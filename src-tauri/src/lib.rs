// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
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
// as wins; we don't.) The 200 boundary lives in the dashboard's SQL spec.

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

/// Progress event payload emitted during the walk. `total` is 0 while locating
/// the game (the length isn't known yet); it's the game count while analyzing.
#[derive(Clone, Serialize)]
struct Progress {
    phase: String,
    current: u64,
    total: u64,
}

/// A widget query the frontend wants pre-computed alongside the history fill.
#[derive(Deserialize)]
struct PrecomputeQuery {
    id: String,
    sql: String,
}

/// Range bounds + pre-computed dashboard query results returned by `compute_history`.
#[derive(Serialize)]
struct Prepared {
    from_game: u64,
    to_game: u64,
    total_games: u64,
    results: BTreeMap<String, Vec<serde_json::Map<String, Json>>>,
}

/// Resolve (and create) the on-disk cache path: `<app data dir>/history.db`.
fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("couldn't resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create data dir: {e}"))?;
    Ok(dir.join("history.db"))
}

/// Prepare a history lookup: derive the game number from the hash, then make sure
/// every classic game up to it is computed and cached. Returns the range bounds;
/// the dashboard queries the actual stats from the cache via `run_query`.
///
/// Thanks to the cache, repeat/newer lookups only walk and compute the games that
/// aren't stored yet. The heavy walk + DB work run via `spawn_blocking` on a
/// background thread (with its own single-threaded Tokio runtime), so the window
/// stays responsive (no Windows "Not Responding") during a cold computation.
#[tauri::command]
async fn compute_history(
    app: tauri::AppHandle,
    game_hash: String,
    queries: Vec<PrecomputeQuery>,
) -> Result<Prepared, String> {
    let db_path = db_path(&app)?;
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
                &queries,
                &report,
            )
            .await
        })
    })
    .await
    .map_err(|e| format!("history computation failed to run: {e}"))?
}

/// Run an arbitrary read-only SQL query against the cache and return the rows as
/// JSON objects (column name -> value). This is the engine that powers the
/// schema-driven dashboard: every card and chart is just a SELECT in the JSON
/// spec, bound with the entered game number.
///
/// Results are served from (and stored in) `query_cache`, so re-rendering a chart
/// for an already-analysed game skips the computation entirely. On a miss the
/// *user* SQL runs under `PRAGMA query_only`, which makes the connection reject any
/// mutation at the engine level so even a malformed/hostile query can't write to
/// the cache; the guard is lifted only to persist the freshly computed result.
#[tauri::command]
async fn run_query(
    app: tauri::AppHandle,
    sql: String,
    params: Vec<Json>,
) -> Result<Vec<serde_json::Map<String, Json>>, String> {
    let db_path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("runtime init failed: {e}"))?;
        rt.block_on(async move {
            let db = libsql::Builder::new_local(db_path)
                .build()
                .await
                .map_err(|e| format!("couldn't open cache db: {e}"))?;
            let conn = db.connect().map_err(|e| format!("couldn't connect to cache db: {e}"))?;
            // Wait (up to 5s) for a competing writer's lock to clear instead of
            // failing instantly with "database is locked" when adding a chart races
            // a layout save or a sibling widget's cache write.
            // `PRAGMA busy_timeout = N` reports back the new value as a result row,
            // so it must go through `query` — `execute` rejects row-returning
            // statements with "Execute returned rows".
            conn.query("PRAGMA busy_timeout = 5000", ())
                .await
                .map_err(|e| format!("couldn't set busy timeout: {e}"))?;

            // The result cache is a pure optimization: if any cache step can't run
            // (table init, lookup, or write), fall back to just computing the query
            // so a freshly added chart still renders rather than erroring out.
            let key = query_cache_key(&sql, &params);
            let cacheable = ensure_cache_table(&conn).await.is_ok();
            if cacheable {
                if let Ok(Some(hit)) = cache_get(&conn, &key).await {
                    return Ok(hit);
                }
            }

            // Run the untrusted user SQL sandboxed (read-only), then drop the guard
            // to persist the result so the next render of this chart is a cache hit.
            conn.execute("PRAGMA query_only = ON", ())
                .await
                .map_err(|e| format!("couldn't set read-only mode: {e}"))?;
            let computed = query_rows(&conn, &sql, params).await;
            conn.execute("PRAGMA query_only = OFF", ())
                .await
                .map_err(|e| format!("couldn't clear read-only mode: {e}"))?;
            let rows = computed?;
            if cacheable {
                let _ = cache_put(&conn, &key, &rows).await;
            }
            Ok(rows)
        })
    })
    .await
    .map_err(|e| format!("query failed to run: {e}"))?
}

/// Open the cache db and ensure the schema exists. Used by the lightweight
/// layout commands (no heavy CPU, so they run directly on the async runtime).
async fn open_db_conn(app: &tauri::AppHandle) -> Result<libsql::Connection, String> {
    let path = db_path(app)?;
    let db = libsql::Builder::new_local(path)
        .build()
        .await
        .map_err(|e| format!("couldn't open cache db: {e}"))?;
    let conn = db.connect().map_err(|e| format!("couldn't connect to cache db: {e}"))?;
    ensure_schema(&conn).await?;
    Ok(conn)
}

/// Load the single persisted dashboard layout (a JSON spec), or `None` on first
/// run before any layout has been saved.
#[tauri::command]
async fn load_layout(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let conn = open_db_conn(&app).await?;
    let mut rows = conn
        .query("SELECT spec FROM layout WHERE id = 1", ())
        .await
        .map_err(|e| format!("couldn't load layout: {e}"))?;
    match rows.next().await.map_err(|e| format!("couldn't load layout: {e}"))? {
        Some(r) => Ok(Some(r.get(0).map_err(|e| format!("couldn't read layout: {e}"))?)),
        None => Ok(None),
    }
}

/// Save the single dashboard layout, replacing whatever was there. `spec` must
/// be valid JSON (the full grid of rows and widgets).
#[tauri::command]
async fn save_layout(app: tauri::AppHandle, spec: String) -> Result<(), String> {
    serde_json::from_str::<Json>(&spec)
        .map_err(|e| format!("layout spec isn't valid JSON: {e}"))?;
    let conn = open_db_conn(&app).await?;
    conn.execute(
        "INSERT INTO layout(id, spec) VALUES (1, ?1)\n\
         ON CONFLICT(id) DO UPDATE SET spec = excluded.spec",
        libsql::params![spec],
    )
    .await
    .map_err(|e| format!("couldn't save layout: {e}"))?;
    Ok(())
}

/// Convert an incoming JSON parameter to a libSQL bind value.
fn json_to_libsql(v: Json) -> libsql::Value {
    match v {
        Json::Null => libsql::Value::Null,
        Json::Bool(b) => libsql::Value::Integer(b as i64),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                libsql::Value::Integer(i)
            } else {
                libsql::Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => libsql::Value::Text(s),
        other => libsql::Value::Text(other.to_string()),
    }
}

/// Convert a libSQL cell value to JSON for the frontend.
fn libsql_to_json(v: libsql::Value) -> Json {
    match v {
        libsql::Value::Null => Json::Null,
        libsql::Value::Integer(i) => Json::from(i),
        libsql::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        libsql::Value::Text(s) => Json::String(s),
        libsql::Value::Blob(b) => Json::String(hex::encode(b)),
    }
}

/// Execute a SELECT and collect rows into JSON objects keyed by column name.
async fn query_rows(
    conn: &libsql::Connection,
    sql: &str,
    params: Vec<Json>,
) -> Result<Vec<serde_json::Map<String, Json>>, String> {
    let binds: Vec<libsql::Value> = params.into_iter().map(json_to_libsql).collect();
    let mut rows = conn
        .query(sql, libsql::params_from_iter(binds))
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("query failed: {e}"))? {
        let mut obj = serde_json::Map::new();
        let cols = row.column_count();
        for i in 0..cols {
            let name = row
                .column_name(i)
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("col{i}"));
            let val = row.get_value(i).map_err(|e| format!("query failed: {e}"))?;
            obj.insert(name, libsql_to_json(val));
        }
        out.push(obj);
    }
    Ok(out)
}

/// The cache identity for a query: `sha256(sql + NUL + params-json)`, hex-encoded.
/// Including the bound params means a different game number (or any other bound
/// value) maps to a distinct entry, and editing a chart's SQL never collides with
/// the old result. See `ensure_cache_table` for why this key never goes stale.
fn query_cache_key(sql: &str, params: &[Json]) -> String {
    let mut h = Sha256::new();
    h.update(sql.as_bytes());
    h.update([0u8]);
    h.update(serde_json::to_vec(params).unwrap_or_default());
    hex::encode(h.finalize())
}

/// Look up a previously cached result for `key`, deserializing the stored JSON.
async fn cache_get(
    conn: &libsql::Connection,
    key: &str,
) -> Result<Option<Vec<serde_json::Map<String, Json>>>, String> {
    let mut rows = conn
        .query("SELECT result FROM query_cache WHERE cache_key = ?1", libsql::params![key])
        .await
        .map_err(|e| format!("cache read failed: {e}"))?;
    match rows.next().await.map_err(|e| format!("cache read failed: {e}"))? {
        Some(r) => {
            let s: String = r.get(0).map_err(|e| format!("cache read failed: {e}"))?;
            let parsed = serde_json::from_str(&s)
                .map_err(|e| format!("corrupt cache entry: {e}"))?;
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

/// Persist a query result under `key` (upsert, so a recompute overwrites cleanly).
async fn cache_put(
    conn: &libsql::Connection,
    key: &str,
    rows: &[serde_json::Map<String, Json>],
) -> Result<(), String> {
    let s = serde_json::to_string(rows).map_err(|e| format!("cache encode failed: {e}"))?;
    conn.execute(
        "INSERT INTO query_cache(cache_key, result) VALUES (?1, ?2)\n\
         ON CONFLICT(cache_key) DO UPDATE SET result = excluded.result",
        libsql::params![key, s],
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("cache write failed: {e}"))?;
    Ok(())
}

/// Run a query through the result cache: return the stored rows on a hit, else
/// compute, persist, and return them. The connection must be writable (the
/// precompute path is; `run_query` guards the *user* SQL with `query_only` but
/// writes the cache with the guard off).
async fn cached_query_rows(
    conn: &libsql::Connection,
    sql: &str,
    params: Vec<Json>,
) -> Result<Vec<serde_json::Map<String, Json>>, String> {
    let key = query_cache_key(sql, &params);
    if let Some(hit) = cache_get(conn, &key).await? {
        return Ok(hit);
    }
    let rows = query_rows(conn, sql, params).await?;
    cache_put(conn, &key, &rows).await?;
    Ok(rows)
}

/// Create the cache table (idempotent) and set pragmas tuned for bulk inserts.
/// The UNIQUE index on `hash` makes "is this hash already cached?" lookups
/// O(log n) instead of a chain walk; the `(is_green, game_id)` index lets the
/// streak window queries (PARTITION BY is_green ORDER BY game_id) skip sorting
/// millions of rows. `is_green` is the precomputed 2.00× green/red flag.
async fn ensure_schema(conn: &libsql::Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\n\
         PRAGMA synchronous=NORMAL;\n\
         PRAGMA busy_timeout=5000;\n\
         CREATE TABLE IF NOT EXISTS games (\n\
             game_id    INTEGER PRIMARY KEY,\n\
             hash       TEXT    NOT NULL UNIQUE,\n\
             bust_centi INTEGER NOT NULL,\n\
             is_green   INTEGER NOT NULL\n\
         );\n\
         CREATE TABLE IF NOT EXISTS layout (\n\
             id   INTEGER PRIMARY KEY CHECK (id = 1),\n\
             spec TEXT NOT NULL\n\
         );",
    )
    .await
    .map_err(|e| format!("schema init failed: {e}"))?;

    // Migrate caches created before the is_green column existed: add it and
    // backfill from bust_centi (the green boundary is 2.00× == 200 centi).
    if !column_exists(conn, "games", "is_green").await? {
        conn.execute("ALTER TABLE games ADD COLUMN is_green INTEGER NOT NULL DEFAULT 0", ())
            .await
            .map_err(|e| format!("schema migration failed: {e}"))?;
        conn.execute("UPDATE games SET is_green = (bust_centi >= 200)", ())
            .await
            .map_err(|e| format!("schema migration failed: {e}"))?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_games_green_game ON games(is_green, game_id)",
        (),
    )
    .await
    .map_err(|e| format!("index init failed: {e}"))?;

    ensure_cache_table(conn).await
}

/// Create the chart-result cache table (idempotent). Kept separate from the full
/// `ensure_schema` so the read-only `run_query` path can guarantee the table
/// exists without re-running the games-table migration on every call.
///
/// A dashboard query's result is a pure function of its (SQL, bound params): the
/// `games` table is append-only and every game ≤ N is immutable, and every query
/// filters `game_id <= ?1`. So a row keyed by `sha256(sql + params)` stays correct
/// forever — no invalidation needed. A newer hash yields a higher game number
/// (different params → new key); an edited chart yields different SQL (new key).
async fn ensure_cache_table(conn: &libsql::Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS query_cache (\n\
             cache_key TEXT PRIMARY KEY,\n\
             result    TEXT NOT NULL\n\
         )",
        (),
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("cache table init failed: {e}"))
}

/// Whether `table` has a column named `col` (via PRAGMA table_info).
async fn column_exists(conn: &libsql::Connection, table: &str, col: &str) -> Result<bool, String> {
    // `table` is an internal constant, not user input — no injection surface.
    let mut rows = conn
        .query(&format!("PRAGMA table_info({table})"), ())
        .await
        .map_err(|e| format!("schema check failed: {e}"))?;
    while let Some(r) = rows.next().await.map_err(|e| format!("schema check failed: {e}"))? {
        let name: String = r.get(1).map_err(|e| format!("schema check failed: {e}"))?;
        if name == col {
            return Ok(true);
        }
    }
    Ok(false)
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
        let green = (centi >= 200) as i64;
        if in_batch == 0 {
            buf.push_str("INSERT INTO games(game_id,hash,bust_centi,is_green) VALUES ");
        } else {
            buf.push(',');
        }
        // game_id, centi and green are integers; hash is validated hex — no injection risk.
        let _ = write!(buf, "({},'{}',{},{})", gid, hex::encode(&cur), centi, green);
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
/// run every requested dashboard query bound to that game, and return the range
/// bounds plus the pre-computed result rows keyed by client-supplied id.
/// Parameterised on the chain anchors so tests can run it end-to-end against a
/// synthetic chain in an in-memory database.
async fn run_history(
    conn: &libsql::Connection,
    game_hash: &str,
    inception_hex: &str,
    chain_offset: u64,
    classic_start: u64,
    max_walk: u64,
    queries: &[PrecomputeQuery],
    report: &dyn Fn(&str, u64, u64),
) -> Result<Prepared, String> {
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

    // Per-query failures are skipped: the widget falls back to its on-demand `runQuery`.
    // Each result is served from `query_cache` when present, so repeat lookups of an
    // already-analysed game return instantly instead of re-scanning the games table.
    let total_queries = queries.len() as u64;
    let mut results: BTreeMap<String, Vec<serde_json::Map<String, Json>>> = BTreeMap::new();
    for (i, q) in queries.iter().enumerate() {
        report("aggregating", i as u64, total_queries);
        if let Ok(rows) = cached_query_rows(conn, &q.sql, vec![Json::from(game_number)]).await {
            results.insert(q.id.clone(), rows);
        }
    }
    report("aggregating", total_queries, total_queries);

    Ok(Prepared {
        from_game: game_number,
        to_game: classic_start,
        total_games: game_number - classic_start + 1,
        results,
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
        .invoke_handler(tauri::generate_handler![
            greet,
            bust_from_hash,
            compute_history,
            run_query,
            load_layout,
            save_layout
        ])
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

    /// Run a query that returns a single integer in column `c`.
    async fn scalar(conn: &libsql::Connection, sql: &str, params: Vec<Json>) -> i64 {
        let rows = query_rows(conn, sql, params).await.unwrap();
        rows[0]["c"].as_i64().unwrap()
    }

    #[tokio::test]
    async fn locate_and_fill() {
        let conn = mem_conn().await;
        // 10 steps to inception, offset so game_number lands 5 above classic_start.
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5; // game_number = classic_start + 5
        let p = run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();

        assert_eq!(p.from_game, classic_start + 5);
        assert_eq!(p.to_game, classic_start);
        assert_eq!(p.total_games, 6);

        // The cache holds exactly the classic range [classic_start, from_game].
        let n = scalar(&conn, "SELECT COUNT(*) AS c FROM games", vec![]).await;
        assert_eq!(n as u64, p.total_games);
        let lo = scalar(&conn, "SELECT MIN(game_id) AS c FROM games", vec![]).await;
        let hi = scalar(&conn, "SELECT MAX(game_id) AS c FROM games", vec![]).await;
        assert_eq!(lo as u64, classic_start);
        assert_eq!(hi as u64, classic_start + 5);
    }

    #[tokio::test]
    async fn history_rejects_off_chain_hash() {
        let conn = mem_conn().await;
        let bogus = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(run_history(
            &conn,
            START,
            bogus,
            10_000_000,
            1_000,
            50,
            &[],
            &|_, _, _| {}
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn history_rejects_pre_classic() {
        let conn = mem_conn().await;
        // 3 steps, tiny offset → derived game_number well below classic_start.
        let inception = synthetic_inception(START, 3);
        assert!(run_history(
            &conn,
            START,
            &inception,
            100,
            1_000_000,
            50,
            &[],
            &|_, _, _| {}
        )
        .await
        .is_err());
    }

    // Walking forward (sha256) generates OLDER games, so sha256^k(START) is the
    // game k positions below START on the chain. Entering an older game first,
    // then START, exercises the incremental locate+fill path; the cached data
    // must match a single cold computation of the same range.
    #[tokio::test]
    async fn incremental_matches_full() {
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5; // game_number(START) = classic_start + 5

        let count_sql = "SELECT COUNT(*) AS c FROM games WHERE game_id <= ?1";
        let green_sql = "SELECT COALESCE(SUM(bust_centi >= 200),0) AS c FROM games WHERE game_id <= ?1";

        // Cold, single-shot computation of the full range.
        let cold = mem_conn().await;
        let full = run_history(
            &cold,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();
        let g = Json::from(full.from_game);
        let full_count = scalar(&cold, count_sql, vec![g.clone()]).await;
        let full_green = scalar(&cold, green_sql, vec![g.clone()]).await;

        // Incremental: first an older game (4 steps below START), then START.
        let older = synthetic_inception(START, 4); // game_number = classic_start + 1
        let inc = mem_conn().await;
        let first = run_history(
            &inc,
            &older,
            &inception,
            offset,
            classic_start,
            100,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();
        assert_eq!(first.from_game, classic_start + 1);
        let second = run_history(
            &inc,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();

        assert_eq!(second.from_game, full.from_game);
        assert_eq!(second.total_games, full.total_games);
        assert_eq!(scalar(&inc, count_sql, vec![g.clone()]).await, full_count);
        assert_eq!(scalar(&inc, green_sql, vec![g]).await, full_green);
    }

    #[tokio::test]
    async fn cached_hash_is_reused() {
        let conn = mem_conn().await;
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5;
        let _ = run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();
        // Second lookup of the same hash takes the cache fast-path: even with a
        // max_walk of 0 (no walking allowed) it must still succeed.
        let again = run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            0,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();
        assert_eq!(again.from_game, classic_start + 5);
    }

    #[tokio::test]
    async fn run_query_binds_params_and_types() {
        let conn = mem_conn().await;
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5;
        run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &[],
            &|_, _, _| {},
        )
        .await
        .unwrap();

        // A representative dashboard-style query with a bound bound and mixed
        // column types (int + real + text).
        let rows = query_rows(
            &conn,
            "SELECT COUNT(*) AS games, AVG(bust_centi)/100.0 AS mean, MAX(hash) AS h
             FROM games WHERE game_id <= ?1",
            vec![Json::from(classic_start + 5)],
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["games"].as_i64().unwrap(), 6);
        assert!(rows[0]["mean"].as_f64().unwrap() >= 1.0);
        assert!(rows[0]["h"].is_string());
    }

    #[tokio::test]
    async fn precompute_runs_each_query_and_matches_on_demand() {
        let conn = mem_conn().await;
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5;

        let count_sql = "SELECT COUNT(*) AS c FROM games WHERE game_id <= ?1";
        let max_sql =
            "SELECT MAX(bust_centi) / 100.0 AS c FROM games WHERE game_id <= ?1";
        let queries = vec![
            PrecomputeQuery {
                id: "count".to_string(),
                sql: count_sql.to_string(),
            },
            PrecomputeQuery {
                id: "max".to_string(),
                sql: max_sql.to_string(),
            },
        ];

        let p = run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &queries,
            &|_, _, _| {},
        )
        .await
        .unwrap();

        assert_eq!(p.results.len(), 2);
        let g = Json::from(p.from_game);
        let on_demand_count = scalar(&conn, count_sql, vec![g.clone()]).await;
        let on_demand_rows =
            query_rows(&conn, max_sql, vec![g]).await.unwrap();
        let on_demand_max = on_demand_rows[0]["c"].as_f64().unwrap();
        assert_eq!(
            p.results["count"][0]["c"].as_i64().unwrap(),
            on_demand_count
        );
        assert_eq!(p.results["max"][0]["c"].as_f64().unwrap(), on_demand_max);
    }

    #[tokio::test]
    async fn precompute_skips_failing_queries() {
        let conn = mem_conn().await;
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5;

        let queries = vec![
            PrecomputeQuery {
                id: "ok".to_string(),
                sql: "SELECT 1 AS c".to_string(),
            },
            PrecomputeQuery {
                id: "bad".to_string(),
                sql: "SELECT * FROM no_such_table".to_string(),
            },
        ];

        let p = run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &queries,
            &|_, _, _| {},
        )
        .await
        .unwrap();

        assert!(p.results.contains_key("ok"));
        assert!(!p.results.contains_key("bad"));
    }

    #[tokio::test]
    async fn layout_upserts_single_row() {
        let conn = mem_conn().await;
        let upsert = "INSERT INTO layout(id, spec) VALUES (1, ?1)\n\
                      ON CONFLICT(id) DO UPDATE SET spec = excluded.spec";

        conn.execute(upsert, libsql::params!["{\"rows\":[]}"]).await.unwrap();
        conn.execute(upsert, libsql::params!["{\"rows\":[{\"widgets\":[]}]}"])
            .await
            .unwrap();

        // Always exactly one row; the latest spec wins.
        assert_eq!(scalar(&conn, "SELECT COUNT(*) AS c FROM layout", vec![]).await, 1);
        let rows = query_rows(&conn, "SELECT spec FROM layout WHERE id = 1", vec![])
            .await
            .unwrap();
        assert_eq!(rows[0]["spec"].as_str().unwrap(), "{\"rows\":[{\"widgets\":[]}]}");
    }

    #[tokio::test]
    async fn cached_query_returns_stored_result_after_data_changes() {
        let conn = mem_conn().await;
        conn.execute(
            "INSERT INTO games(game_id,hash,bust_centi,is_green) VALUES (1,'aa',100,0)",
            (),
        )
        .await
        .unwrap();
        let sql = "SELECT COUNT(*) AS c FROM games WHERE game_id <= ?1";
        let params = vec![Json::from(10)];

        // First call computes (count = 1) and caches it.
        let first = cached_query_rows(&conn, sql, params.clone()).await.unwrap();
        assert_eq!(first[0]["c"].as_i64().unwrap(), 1);

        // Underlying data changes: a fresh, uncached query now sees 2 rows...
        conn.execute(
            "INSERT INTO games(game_id,hash,bust_centi,is_green) VALUES (2,'bb',100,0)",
            (),
        )
        .await
        .unwrap();
        assert_eq!(scalar(&conn, sql, params.clone()).await, 2);

        // ...but the cached call still returns the original result, proving the
        // hit was served from query_cache rather than recomputed. (In production
        // the games ≤ N never change, so this can only ever be the right answer.)
        let second = cached_query_rows(&conn, sql, params).await.unwrap();
        assert_eq!(second[0]["c"].as_i64().unwrap(), 1);
    }

    #[tokio::test]
    async fn cached_query_keys_on_params() {
        let conn = mem_conn().await;
        for (g, h) in [(1, "aa"), (2, "bb")] {
            conn.execute(
                &format!("INSERT INTO games(game_id,hash,bust_centi,is_green) VALUES ({g},'{h}',100,0)"),
                (),
            )
            .await
            .unwrap();
        }
        let sql = "SELECT COUNT(*) AS c FROM games WHERE game_id <= ?1";
        // Same SQL, different bound game number → independent cache entries.
        let a = cached_query_rows(&conn, sql, vec![Json::from(1)]).await.unwrap();
        let b = cached_query_rows(&conn, sql, vec![Json::from(2)]).await.unwrap();
        assert_eq!(a[0]["c"].as_i64().unwrap(), 1);
        assert_eq!(b[0]["c"].as_i64().unwrap(), 2);
        assert_ne!(
            query_cache_key(sql, &[Json::from(1)]),
            query_cache_key(sql, &[Json::from(2)])
        );
    }

    #[tokio::test]
    async fn precompute_populates_query_cache() {
        let conn = mem_conn().await;
        let inception = synthetic_inception(START, 10);
        let classic_start = 1_000u64;
        let offset = classic_start - 5;
        let queries = vec![PrecomputeQuery {
            id: "count".to_string(),
            sql: "SELECT COUNT(*) AS c FROM games WHERE game_id <= ?1".to_string(),
        }];

        run_history(
            &conn,
            START,
            &inception,
            offset,
            classic_start,
            100,
            &queries,
            &|_, _, _| {},
        )
        .await
        .unwrap();

        // The precompute pass wrote the result into the cache for reuse next run.
        assert_eq!(scalar(&conn, "SELECT COUNT(*) AS c FROM query_cache", vec![]).await, 1);
    }

    #[tokio::test]
    async fn run_query_rejects_writes_when_query_only() {
        let conn = mem_conn().await;
        conn.execute("PRAGMA query_only = ON", ()).await.unwrap();
        // A mutation must fail on a read-only connection.
        let err = query_rows(
            &conn,
            "INSERT INTO games(game_id,hash,bust_centi,is_green) VALUES (1,'deadbeef',100,0)",
            vec![],
        )
        .await;
        assert!(err.is_err());
    }
}
