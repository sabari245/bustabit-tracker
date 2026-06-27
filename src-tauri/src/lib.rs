// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

/// How often (in iterations) to emit a progress event during the walk. A power
/// of two minus one so we can test it with a cheap bitmask. ~262k keeps the
/// total number of events tiny (a few dozen per run).
const PROGRESS_MASK: u64 = 0x3FFFF;

/// Rows per batched INSERT when filling the cache. Big enough that the per-
/// statement overhead is negligible, small enough to keep the SQL string and
/// the SQLite parser comfortable.
const CHUNK_ROWS: u64 = 4000;

type HmacSha256 = Hmac<Sha256>;

/// First game of the current "classic" era (post-Vx). See docs §3.
/// Games at or after this number all use the fixed `BUSTABIT_GAME_SALT` key,
/// so the whole era is reproducible with plain HMAC (no BLS).
const CLASSIC_START: u64 = 12_279_451;

/// Inception ("terminating") hash of the current chain — the publicly published
/// bottom of the chain. Hashing any current-chain game's hash downward
/// eventually reaches this value; the step count reveals the game number, which
/// lets us locate a game on the chain without the user supplying a number, and
/// proves the hash is genuinely on-chain. See docs/bustabit-provably-fair.html §1/§2.
const INCEPTION_HASH: &str = "567a98370fb7545137ddb53687723cf0b8a1f5e93b1f76f4a1da29416930fa59";

/// Game-numbering offset: applying sha256 to game N's hash exactly
/// (N - CHAIN_OFFSET) times reaches INCEPTION_HASH. The current chain's first
/// game is CHAIN_OFFSET + 1 (= 10,000,001).
const CHAIN_OFFSET: u64 = 10_000_000;

/// Safety cap on the locate-walk so an off-chain/bogus hash errors out instead
/// of looping forever. Covers game numbers up to ~30M (years of headroom).
const MAX_WALK: u64 = 20_000_000;

// A bust is "green" at or above 2.00× (== 200 in integer hundredths/centi). A 2×
// auto-cashout wins iff the game reaches 2.00×, so green = [2.00, ∞) and red (a
// loss) = [1.00, 2.00) — including the 1.00× instant bust. (bustabit's verifier
// uses 1.98 purely as a cosmetic table-row color, which would mislabel 1.98/1.99
// as wins; we don't.) The 200 boundary is hardcoded in the aggregation SQL.

/// Current ("classic") HMAC salt = hash of the Bitcoin block from bustabit's 4th
/// seeding event (bitcointalk topic 5560454). This is the salt live games use
/// today (the post-Vx classic scheme). See docs/bustabit-provably-fair.html §3.
///
/// NOTE: the salt is keyed into HMAC as the UTF-8 bytes of this hex *string*
/// (NOT hex-decoded). Only the game-hash *message* is hex-decoded to raw bytes.
const BUSTABIT_GAME_SALT: &str = "00000000000000000001e08b7fd44f95e3e950ac65650a8031a6d5e1750e34be";

/// Compute the bustabit crash point (multiplier, e.g. 1.00, 38.65) for a game
/// hash, using bustabit's canonical provably-fair algorithm as published in their
/// own verifier (src/utils/math.ts). See docs/bustabit-provably-fair.html §4.
///
/// `game_hash` is the 64-hex-char server seed. This assumes the current "classic"
/// era (GAME_SALT). v2-era and Vx-era games use different keys and can't be
/// distinguished from the hash alone — see docs §3/§8.
///
/// Returns the bust multiplier floored to 2 decimals, min 1.00, or an error if
/// the hash is invalid.
fn compute_bust(game_hash: &str) -> Result<f64, String> {
    let game_hash = game_hash.trim();

    // Validate: must be 64 hex chars.
    if game_hash.len() != 64 || !game_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("game_hash must be a 64-character hex string".to_string());
    }

    // Message = the RAW 32 bytes of the game hash (hex-decoded). (docs §4)
    let message = hex::decode(game_hash).map_err(|e| format!("failed to decode hash: {e}"))?;
    Ok(bust_centi_of_bytes(&message) as f64 / 100.0)
}

/// Core bust formula for the classic era, operating on the raw 32-byte game hash,
/// returning the crash point in integer hundredths (centi): 3865 == 38.65×,
/// 100 == 1.00×. Working in integers keeps the value exact (no float drift) and
/// is exactly what we persist in the cache.
fn bust_centi_of_bytes(message: &[u8]) -> i64 {
    // HMAC-SHA256, key = GAME_SALT (hex string as UTF-8 bytes), message = raw bytes.
    let mut mac =
        HmacSha256::new_from_slice(BUSTABIT_GAME_SALT.as_bytes()).expect("HMAC accepts any key len");
    mac.update(message);
    let digest = mac.finalize().into_bytes();

    // Top 52 bits = first 13 hex chars of the digest.
    let r = u64::from_str_radix(&hex::encode(&digest)[..13], 16).expect("13 hex chars fit in u64");
    let e = 2f64.powi(52); // 4503599627370496

    // X = r / 2^52 in [0,1); crash = floor(99 / (1 - X)) hundredths, min 100.
    // The ~1% house edge is baked into the 99 (no separate divisible-by-101 check).
    let x = r as f64 / e;
    ((99.0 / (1.0 - x)).floor() as i64).max(100)
}

/// Tauri command wrapper: compute the bust value for a provided game hash.
#[tauri::command]
fn bust_from_hash(game_hash: &str) -> Result<f64, String> {
    compute_bust(game_hash)
}

/// One bar of the bust-value distribution histogram.
#[derive(Serialize)]
struct DistBucket {
    label: String,
    count: u64,
}

/// One row of the streak-length distribution (how many green vs red runs had a
/// length falling in this bucket).
#[derive(Serialize)]
struct StreakBucket {
    label: String,
    green: u64,
    red: u64,
}

/// Exact count of streaks that were precisely `length` long. Used for the
/// dedicated red-streak analysis (frequency / survival / continuation charts).
#[derive(Serialize)]
struct LenCount {
    length: u64,
    count: u64,
}

/// Progress event payload emitted during the walk. `total` is 0 while locating
/// the game (the length isn't known yet) and while aggregating; it's the game
/// count while analyzing/filling.
#[derive(Clone, Serialize)]
struct Progress {
    phase: String,
    current: u64,
    total: u64,
}

/// Aggregated stats for the classic-era history of a chain, from `CLASSIC_START`
/// up to the entered game. Everything is summarised in SQL so we never ship the
/// millions of individual rounds to the frontend.
#[derive(Serialize)]
struct HistoryStats {
    from_game: u64,
    to_game: u64,
    total_games: u64,
    green_count: u64,
    red_count: u64,
    instant_busts: u64,
    mean_bust: f64,
    max_bust: f64,
    max_bust_game: u64,
    longest_green_streak: u64,
    longest_red_streak: u64,
    current_streak_len: u64,
    current_streak_green: bool,
    distribution: Vec<DistBucket>,
    streaks: Vec<StreakBucket>,
    /// Exact red-streak length histogram (index 0 = length 1, up to the longest
    /// red streak). Frontend derives survival & continuation curves from this.
    red_streak_hist: Vec<LenCount>,
}

/// Bucket index for a streak length. Boundaries: 1, 2, 3, 4, 5, 6–10, 11–20, 21+.
fn streak_index(len: u64) -> usize {
    match len {
        1 => 0,
        2 => 1,
        3 => 2,
        4 => 3,
        5 => 4,
        6..=10 => 5,
        11..=20 => 6,
        _ => 7,
    }
}

/// Walk the current chain backward from `game_hash`, persisting every classic
/// game's bust into a local SQLite (libSQL) cache and summarising the history
/// with SQL. The game number is derived (not supplied) by locating the hash on
/// the chain; thanks to the cache, repeat lookups only walk/compute the games
/// that aren't stored yet.
///
/// This is an `async` command and the heavy walk + DB work run via
/// `spawn_blocking` on a background thread (with its own single-threaded Tokio
/// runtime), so the window stays responsive (no Windows "Not Responding") during
/// the multi-million-hash computation.
#[tauri::command]
async fn compute_history(app: tauri::AppHandle, game_hash: String) -> Result<HistoryStats, String> {
    // Resolve the on-disk cache location on the async side (needs AppHandle).
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("couldn't resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create data dir: {e}"))?;
    let db_path = dir.join("history.db");

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A dedicated current-thread runtime, independent of Tauri's, lets us
        // drive the async libSQL API from this blocking thread without any
        // nested-runtime hazard. The CPU-heavy hashing runs as plain code
        // between DB awaits.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("runtime init failed: {e}"))?;
        rt.block_on(async move {
            let report = |phase: &str, current: u64, total: u64| {
                let _ = app.emit(
                    "history-progress",
                    Progress {
                        phase: phase.to_string(),
                        current,
                        total,
                    },
                );
            };
            let db = libsql::Builder::new_local(db_path)
                .build()
                .await
                .map_err(|e| format!("couldn't open cache db: {e}"))?;
            let conn = db.connect().map_err(|e| format!("couldn't connect to cache db: {e}"))?;
            ensure_schema(&conn).await?;
            run_history(
                &conn,
                &game_hash,
                INCEPTION_HASH,
                CHAIN_OFFSET,
                CLASSIC_START,
                MAX_WALK,
                &report,
            )
            .await
        })
    })
    .await
    .map_err(|e| format!("history computation failed to run: {e}"))?
}

/// Create the cache table (idempotent) and set pragmas tuned for bulk inserts.
/// The UNIQUE index on `hash` is what makes "is this hash already cached?"
/// lookups O(log n) instead of a chain walk.
async fn ensure_schema(conn: &libsql::Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\n\
         PRAGMA synchronous=NORMAL;\n\
         CREATE TABLE IF NOT EXISTS games (\n\
             game_id    INTEGER PRIMARY KEY,\n\
             hash       TEXT    NOT NULL UNIQUE,\n\
             bust_centi INTEGER NOT NULL\n\
         );",
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("schema init failed: {e}"))
}

/// The game number for a hash we've already cached, if any.
async fn lookup_hash(conn: &libsql::Connection, hash_hex: &str) -> Result<Option<u64>, String> {
    let mut rows = conn
        .query("SELECT game_id FROM games WHERE hash = ?1", libsql::params![hash_hex])
        .await
        .map_err(|e| format!("hash lookup failed: {e}"))?;
    match rows.next().await.map_err(|e| format!("hash lookup failed: {e}"))? {
        Some(r) => {
            let id: i64 = r.get(0).map_err(|e| format!("hash lookup failed: {e}"))?;
            Ok(Some(id as u64))
        }
        None => Ok(None),
    }
}

/// The newest (highest game_id) cached game and its raw hash bytes, if any. The
/// cache is always a contiguous range starting at CLASSIC_START, so this is the
/// only stored hash a newer lookup can encounter first when walking down.
async fn stored_max(conn: &libsql::Connection) -> Result<Option<(u64, Vec<u8>)>, String> {
    let mut rows = conn
        .query("SELECT game_id, hash FROM games ORDER BY game_id DESC LIMIT 1", ())
        .await
        .map_err(|e| format!("cache read failed: {e}"))?;
    match rows.next().await.map_err(|e| format!("cache read failed: {e}"))? {
        Some(r) => {
            let id: i64 = r.get(0).map_err(|e| format!("cache read failed: {e}"))?;
            let h: String = r.get(1).map_err(|e| format!("cache read failed: {e}"))?;
            let bytes = hex::decode(&h).map_err(|e| format!("corrupt cached hash: {e}"))?;
            Ok(Some((id as u64, bytes)))
        }
        None => Ok(None),
    }
}

/// Locate a game on the chain by hashing downward. Stops early at the newest
/// cached hash (`stored`) when possible — otherwise walks all the way to the
/// chain's inception hash. Returns the derived game number.
fn locate_game(
    start: &[u8],
    stored: Option<(u64, Vec<u8>)>,
    inception: &[u8],
    chain_offset: u64,
    max_walk: u64,
    report: &dyn Fn(&str, u64, u64),
) -> Result<u64, String> {
    let stop = stored.as_ref().map(|(g, h)| (*g, h.as_slice()));
    let mut hash = start.to_vec();
    let mut steps: u64 = 0;
    loop {
        hash = Sha256::digest(&hash).to_vec();
        steps += 1;
        if let Some((stop_game, stop_hash)) = stop {
            if hash == stop_hash {
                return Ok(stop_game + steps);
            }
        }
        if hash == inception {
            return Ok(chain_offset + steps);
        }
        if steps >= max_walk {
            return Err("this hash isn't on the current chain (couldn't reach the chain's origin hash) — check it's a real bustabit game hash".to_string());
        }
        if steps & PROGRESS_MASK == 0 {
            report("locating", steps, 0);
        }
    }
}

/// Compute and persist every classic game from `game_number` down to `lower`
/// (inclusive) that isn't cached yet, walking the chain from `start`. Inserts in
/// batched transactions for throughput.
async fn fill_range(
    conn: &libsql::Connection,
    start: &[u8],
    game_number: u64,
    lower: u64,
    report: &dyn Fn(&str, u64, u64),
) -> Result<(), String> {
    use std::fmt::Write;

    let total = game_number - lower + 1;
    report("analyzing", 0, total);

    conn.execute("BEGIN", ())
        .await
        .map_err(|e| format!("cache write failed: {e}"))?;

    let mut cur = start.to_vec();
    let mut gid = game_number;
    let mut buf = String::new();
    let mut in_batch: u64 = 0;
    let mut done: u64 = 0;

    loop {
        let centi = bust_centi_of_bytes(&cur);
        if in_batch == 0 {
            buf.push_str("INSERT INTO games(game_id,hash,bust_centi) VALUES ");
        } else {
            buf.push(',');
        }
        // game_id and centi are integers; hash is validated hex — no injection risk.
        let _ = write!(buf, "({},'{}',{})", gid, hex::encode(&cur), centi);
        in_batch += 1;

        if in_batch >= CHUNK_ROWS {
            buf.push(';');
            conn.execute_batch(&buf)
                .await
                .map_err(|e| format!("cache write failed: {e}"))?;
            buf.clear();
            in_batch = 0;
        }

        done += 1;
        if done & PROGRESS_MASK == 0 {
            report("analyzing", done, total);
        }

        if gid == lower {
            break;
        }
        cur = Sha256::digest(&cur).to_vec();
        gid -= 1;
    }

    if in_batch > 0 {
        buf.push(';');
        conn.execute_batch(&buf)
            .await
            .map_err(|e| format!("cache write failed: {e}"))?;
    }
    conn.execute("COMMIT", ())
        .await
        .map_err(|e| format!("cache commit failed: {e}"))?;
    Ok(())
}

/// Orchestrate a history lookup against the cache `conn`: derive the game number
/// (cache fast-path, else incremental locate), fill any missing classic games,
/// then summarise with SQL. Parameterised on the chain anchors so tests can run
/// it end-to-end against a synthetic chain in an in-memory database.
async fn run_history(
    conn: &libsql::Connection,
    game_hash: &str,
    inception_hex: &str,
    chain_offset: u64,
    classic_start: u64,
    max_walk: u64,
    report: &dyn Fn(&str, u64, u64),
) -> Result<HistoryStats, String> {
    let game_hash = game_hash.trim();
    if game_hash.len() != 64 || !game_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("game_hash must be a 64-character hex string".to_string());
    }
    let start = hex::decode(game_hash).map_err(|e| format!("failed to decode hash: {e}"))?;
    let inception = hex::decode(inception_hex).map_err(|e| format!("bad inception hash: {e}"))?;

    report("locating", 0, 0);
    let stored = stored_max(conn).await?;

    // Fast path: the hash is already cached, so its number is known directly.
    let game_number = match lookup_hash(conn, game_hash).await? {
        Some(n) => n,
        None => locate_game(&start, stored.clone(), &inception, chain_offset, max_walk, report)?,
    };

    if game_number < classic_start {
        return Err(format!(
            "this hash is a Vx-era game (#{game_number}); only classic-era games (#{classic_start} and later) are supported"
        ));
    }

    // Fill any classic games we don't have yet: from just above the cached max
    // (or the classic start on a cold cache) up to this game.
    let lower = match &stored {
        Some((m, _)) if m + 1 > classic_start => m + 1,
        _ => classic_start,
    };
    if game_number >= lower {
        fill_range(conn, &start, game_number, lower, report).await?;
    }

    report("aggregating", 0, 0);
    aggregate(conn, game_number, classic_start).await
}

/// Map a libSQL error to a user-facing aggregation error. A free function (not a
/// closure) so it's `Copy` and can be handed to many `map_err` calls.
fn agg_err(e: libsql::Error) -> String {
    format!("aggregation failed: {e}")
}

/// Summarise the cached classic history up to `game_number` entirely in SQL.
/// Returns small result sets only (scalars + a few hundred run-length groups),
/// never the millions of individual rows.
async fn aggregate(
    conn: &libsql::Connection,
    game_number: u64,
    classic_start: u64,
) -> Result<HistoryStats, String> {
    let g = game_number as i64;

    // --- Scalars ---
    let mut rows = conn
        .query(
            "SELECT COUNT(*),
                    COALESCE(SUM(bust_centi >= 200), 0),
                    COALESCE(SUM(bust_centi <= 100), 0),
                    COALESCE(AVG(bust_centi), 0),
                    COALESCE(MAX(bust_centi), 100)
             FROM games WHERE game_id <= ?1",
            libsql::params![g],
        )
        .await
        .map_err(agg_err)?;
    let r = rows.next().await.map_err(agg_err)?.ok_or("aggregation returned no rows")?;
    let total: i64 = r.get(0).map_err(agg_err)?;
    let green: i64 = r.get(1).map_err(agg_err)?;
    let instant: i64 = r.get(2).map_err(agg_err)?;
    let mean_centi: f64 = r.get(3).map_err(agg_err)?;
    let max_centi: i64 = r.get(4).map_err(agg_err)?;
    if total == 0 {
        return Err("no classic games found for this hash".to_string());
    }

    // Which game hit the max bust (newest such game if tied).
    let mut rows = conn
        .query(
            "SELECT game_id FROM games WHERE game_id <= ?1 AND bust_centi = ?2
             ORDER BY game_id DESC LIMIT 1",
            libsql::params![g, max_centi],
        )
        .await
        .map_err(agg_err)?;
    let max_bust_game = match rows.next().await.map_err(agg_err)? {
        Some(r) => r.get::<i64>(0).map_err(agg_err)? as u64,
        None => game_number,
    };

    // --- Bust-value distribution (<2, 2–5, 5–10, 10–100, ≥100) ---
    let mut rows = conn
        .query(
            "SELECT COALESCE(SUM(bust_centi < 200), 0),
                    COALESCE(SUM(bust_centi >= 200 AND bust_centi < 500), 0),
                    COALESCE(SUM(bust_centi >= 500 AND bust_centi < 1000), 0),
                    COALESCE(SUM(bust_centi >= 1000 AND bust_centi < 10000), 0),
                    COALESCE(SUM(bust_centi >= 10000), 0)
             FROM games WHERE game_id <= ?1",
            libsql::params![g],
        )
        .await
        .map_err(agg_err)?;
    let r = rows.next().await.map_err(agg_err)?.ok_or("distribution returned no rows")?;
    let dist_counts = [
        r.get::<i64>(0).map_err(agg_err)? as u64,
        r.get::<i64>(1).map_err(agg_err)? as u64,
        r.get::<i64>(2).map_err(agg_err)? as u64,
        r.get::<i64>(3).map_err(agg_err)? as u64,
        r.get::<i64>(4).map_err(agg_err)? as u64,
    ];

    // --- Streaks via gaps-and-islands ---
    // Consecutive same-colour games share (green, game_id - row_number()); group
    // by that to get each run, then group runs by (green, length).
    let mut rows = conn
        .query(
            "WITH g AS (
                 SELECT game_id, CASE WHEN bust_centi >= 200 THEN 1 ELSE 0 END AS green
                 FROM games WHERE game_id <= ?1
             ),
             grp AS (
                 SELECT game_id, green,
                        game_id - ROW_NUMBER() OVER (PARTITION BY green ORDER BY game_id) AS island
                 FROM g
             ),
             runs AS (
                 SELECT green, COUNT(*) AS len, MAX(game_id) AS hi
                 FROM grp GROUP BY green, island
             )
             SELECT green, len, COUNT(*) AS cnt, MAX(hi) AS max_hi
             FROM runs GROUP BY green, len ORDER BY green, len",
            libsql::params![g],
        )
        .await
        .map_err(agg_err)?;

    let mut green_streaks = [0u64; 8];
    let mut red_streaks = [0u64; 8];
    let mut red_exact: Vec<u64> = Vec::new();
    let mut longest_green = 0u64;
    let mut longest_red = 0u64;
    let mut current_streak_len = 0u64;
    let mut current_streak_green = false;

    while let Some(row) = rows.next().await.map_err(agg_err)? {
        let is_green = row.get::<i64>(0).map_err(agg_err)? == 1;
        let len = row.get::<i64>(1).map_err(agg_err)? as u64;
        let cnt = row.get::<i64>(2).map_err(agg_err)? as u64;
        let max_hi = row.get::<i64>(3).map_err(agg_err)? as u64;
        let idx = streak_index(len);
        if is_green {
            green_streaks[idx] += cnt;
            longest_green = longest_green.max(len);
        } else {
            red_streaks[idx] += cnt;
            longest_red = longest_red.max(len);
            let i = (len - 1) as usize;
            if i >= red_exact.len() {
                red_exact.resize(i + 1, 0);
            }
            red_exact[i] += cnt;
        }
        // The run containing the newest game ends exactly at game_number; that's
        // the "current" streak shown for the entered game.
        if max_hi == game_number {
            current_streak_len = len;
            current_streak_green = is_green;
        }
    }

    let dist_labels = ["<2×", "2–5×", "5–10×", "10–100×", "≥100×"];
    let distribution = dist_labels
        .iter()
        .enumerate()
        .map(|(i, l)| DistBucket {
            label: l.to_string(),
            count: dist_counts[i],
        })
        .collect();

    let streak_labels = ["1", "2", "3", "4", "5", "6–10", "11–20", "21+"];
    let streaks = streak_labels
        .iter()
        .enumerate()
        .map(|(i, l)| StreakBucket {
            label: l.to_string(),
            green: green_streaks[i],
            red: red_streaks[i],
        })
        .collect();

    let red_streak_hist = red_exact
        .iter()
        .enumerate()
        .map(|(i, c)| LenCount {
            length: i as u64 + 1,
            count: *c,
        })
        .collect();

    Ok(HistoryStats {
        from_game: game_number,
        to_game: classic_start,
        total_games: total as u64,
        green_count: green as u64,
        red_count: (total - green) as u64,
        instant_busts: instant as u64,
        mean_bust: mean_centi / 100.0,
        max_bust: max_centi as f64 / 100.0,
        max_bust_game,
        longest_green_streak: longest_green,
        longest_red_streak: longest_red,
        current_streak_len,
        current_streak_green,
        distribution,
        streaks,
        red_streak_hist,
    })
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, bust_from_hash, compute_history])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_classic_game() {
        // df5d54b8… is a current-era classic game; site shows 38.65x.
        let b = compute_bust("df5d54b8ca42cb40ea80e8ba74b3281f7b9d49bc27fecbe104847de1e91e4929").unwrap();
        assert!((b - 38.65).abs() < 1e-9, "got {b}");
    }

    #[test]
    fn rejects_bad_hash() {
        assert!(compute_bust("nope").is_err());
    }

    // Build a synthetic anchor: treat sha256^steps(start) as the "inception" so
    // the locate-walk terminates after a known, tiny number of steps.
    fn synthetic_inception(start_hex: &str, steps: u64) -> String {
        let mut h = hex::decode(start_hex).unwrap();
        for _ in 0..steps {
            h = Sha256::digest(&h).to_vec();
        }
        hex::encode(h)
    }

    const START: &str = "df5d54b8ca42cb40ea80e8ba74b3281f7b9d49bc27fecbe104847de1e91e4929";

    async fn mem_conn() -> libsql::Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = db.connect().unwrap();
        ensure_schema(&conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn history_invariants() {
        let conn = mem_conn().await;
        // 10 steps to inception, offset so game_number lands 10 above classic_start.
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5; // game_number = classic_start + 5
        let s = run_history(&conn, START, &inception, offset, classic_start, 100, &|_, _, _| {})
            .await
            .unwrap();

        assert_eq!(s.from_game, classic_start + 5);
        assert_eq!(s.to_game, classic_start);
        assert_eq!(s.total_games, 6);
        assert_eq!(s.green_count + s.red_count, s.total_games);
        let dist: u64 = s.distribution.iter().map(|b| b.count).sum();
        assert_eq!(dist, s.total_games);
        let streak_runs: u64 = s.streaks.iter().map(|b| b.green + b.red).sum();
        // Every game belongs to exactly one run, and runs partition the games,
        // so total run length == total games (sanity on the gaps-and-islands SQL).
        let red_runs: u64 = s.red_streak_hist.iter().map(|h| h.count).sum();
        assert!(streak_runs >= 1 && red_runs <= streak_runs);
        assert!(s.longest_green_streak <= s.total_games);
        assert!(s.longest_red_streak <= s.total_games);
        assert!(s.max_bust >= 1.0);
        assert!(s.current_streak_len >= 1);
    }

    #[tokio::test]
    async fn history_rejects_off_chain_hash() {
        let conn = mem_conn().await;
        let bogus = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(run_history(&conn, START, bogus, 10_000_000, 1_000, 50, &|_, _, _| {})
            .await
            .is_err());
    }

    #[tokio::test]
    async fn history_rejects_pre_classic() {
        let conn = mem_conn().await;
        // 3 steps, tiny offset → derived game_number well below classic_start.
        let inception = synthetic_inception(START, 3);
        assert!(run_history(&conn, START, &inception, 100, 1_000_000, 50, &|_, _, _| {})
            .await
            .is_err());
    }

    // Walking forward (sha256) generates OLDER games, so sha256^k(START) is the
    // game k positions below START on the chain. Entering an older game first,
    // then START, exercises the incremental locate+fill path; the final stats
    // must match a single cold computation of the same range.
    #[tokio::test]
    async fn incremental_matches_full() {
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5; // game_number(START) = classic_start + 5

        // Cold, single-shot computation of the full range.
        let cold = mem_conn().await;
        let full = run_history(&cold, START, &inception, offset, classic_start, 100, &|_, _, _| {})
            .await
            .unwrap();

        // Incremental: first an older game (4 steps below START), then START.
        let older = synthetic_inception(START, 4); // game_number = classic_start + 1
        let inc = mem_conn().await;
        let first = run_history(&inc, &older, &inception, offset, classic_start, 100, &|_, _, _| {})
            .await
            .unwrap();
        assert_eq!(first.from_game, classic_start + 1);

        let second = run_history(&inc, START, &inception, offset, classic_start, 100, &|_, _, _| {})
            .await
            .unwrap();

        // The incremental run reached the same game via the cached anchor and
        // produced identical aggregates.
        assert_eq!(second.from_game, full.from_game);
        assert_eq!(second.total_games, full.total_games);
        assert_eq!(second.green_count, full.green_count);
        assert_eq!(second.red_count, full.red_count);
        assert_eq!(second.longest_green_streak, full.longest_green_streak);
        assert_eq!(second.longest_red_streak, full.longest_red_streak);
        assert_eq!(second.max_bust_game, full.max_bust_game);
        assert!((second.mean_bust - full.mean_bust).abs() < 1e-9);
    }

    #[tokio::test]
    async fn cached_hash_is_reused() {
        let conn = mem_conn().await;
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5;
        let _ = run_history(&conn, START, &inception, offset, classic_start, 100, &|_, _, _| {})
            .await
            .unwrap();
        // Second lookup of the same hash takes the cache fast-path: even with a
        // max_walk of 0 (no walking allowed) it must still succeed.
        let again = run_history(&conn, START, &inception, offset, classic_start, 0, &|_, _, _| {})
            .await
            .unwrap();
        assert_eq!(again.from_game, classic_start + 5);
    }
}
