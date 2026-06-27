// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

/// How often (in iterations) to emit a progress event during the walk. A power
/// of two minus one so we can test it with a cheap bitmask. ~262k keeps the
/// total number of events tiny (a few dozen per run).
const PROGRESS_MASK: u64 = 0x3FFFF;

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

/// A bust is "green" at or above this multiplier. 2.00 is the meaningful
/// boundary: a 2× auto-cashout wins iff the game reaches 2.00×, so green =
/// [2.00, ∞) and red (a loss) = [1.00, 2.00) — including the 1.00× instant bust.
/// (bustabit's verifier uses 1.98 purely as a cosmetic table-row color, which
/// would mislabel 1.98/1.99 as wins; we don't.)
const GREEN_THRESHOLD: f64 = 2.0;

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
    Ok(bust_of_bytes(&message))
}

/// Core bust formula for the classic era, operating on the raw 32-byte game hash.
/// Kept separate so the history walk can avoid re-decoding hex each iteration.
fn bust_of_bytes(message: &[u8]) -> f64 {
    // HMAC-SHA256, key = GAME_SALT (hex string as UTF-8 bytes), message = raw bytes.
    let mut mac =
        HmacSha256::new_from_slice(BUSTABIT_GAME_SALT.as_bytes()).expect("HMAC accepts any key len");
    mac.update(message);
    let digest = mac.finalize().into_bytes();

    // Top 52 bits = first 13 hex chars of the digest.
    let r = u64::from_str_radix(&hex::encode(&digest)[..13], 16).expect("13 hex chars fit in u64");
    let e = 2f64.powi(52); // 4503599627370496

    // X = r / 2^52 in [0,1); crash = 99 / (1 - X), floored to 2 decimals, min 1.00.
    // The ~1% house edge is baked into the 99 (no separate divisible-by-101 check).
    let x = r as f64 / e;
    ((99.0 / (1.0 - x)).floor() / 100.0).max(1.0)
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
/// the game (the length isn't known yet), and the game count while analyzing.
#[derive(Clone, Serialize)]
struct Progress {
    phase: String,
    current: u64,
    total: u64,
}

/// Aggregated stats for the classic-era history of a chain, walked back from the
/// entered game to `CLASSIC_START`. Everything is summarised in Rust so we never
/// ship the millions of individual rounds to the frontend.
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

/// Bucket index for the bust-value histogram. Boundaries: <2, 2–5, 5–10, 10–100, ≥100.
fn dist_index(bust: f64) -> usize {
    if bust < 2.0 {
        0
    } else if bust < 5.0 {
        1
    } else if bust < 10.0 {
        2
    } else if bust < 100.0 {
        3
    } else {
        4
    }
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

/// Walk the current chain backward from `game_hash` down to the start of the
/// classic era, computing every bust and aggregating dashboard stats. The game
/// number is derived (not supplied) by locating the hash on the chain.
///
/// This is an `async` command and the heavy walk runs via `spawn_blocking`, so it
/// executes on a background thread instead of the main/UI thread — that keeps the
/// window responsive (no Windows "Not Responding" / greyed-out window) during the
/// multi-million-hash computation.
#[tauri::command]
async fn compute_history(app: tauri::AppHandle, game_hash: String) -> Result<HistoryStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Emit throttled progress events the UI can listen to.
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
        compute_history_inner(&game_hash, INCEPTION_HASH, CHAIN_OFFSET, MAX_WALK, &report)
    })
    .await
    .map_err(|e| format!("history computation failed to run: {e}"))?
}

/// Inner implementation with the chain anchor parameterised so it can be tested
/// against a synthetic inception hash without walking the real multi-million
/// chain. `report(phase, current, total)` receives throttled progress updates.
fn compute_history_inner(
    game_hash: &str,
    inception_hex: &str,
    chain_offset: u64,
    max_walk: u64,
    report: &dyn Fn(&str, u64, u64),
) -> Result<HistoryStats, String> {
    let game_hash = game_hash.trim();
    if game_hash.len() != 64 || !game_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("game_hash must be a 64-character hex string".to_string());
    }
    let start = hex::decode(game_hash).map_err(|e| format!("failed to decode hash: {e}"))?;
    let inception = hex::decode(inception_hex).map_err(|e| format!("bad inception hash: {e}"))?;

    // Pass 1 — locate the game on the chain by hashing down to the known
    // inception hash. The number of steps = game_number - chain_offset. This both
    // derives the game number and proves the hash is genuinely on-chain. (docs §1)
    let mut hash = start.clone();
    let mut steps: u64 = 0;
    report("locating", 0, 0);
    loop {
        hash = Sha256::digest(&hash).to_vec();
        steps += 1;
        if hash == inception {
            break;
        }
        if steps >= max_walk {
            return Err("this hash isn't on the current chain (couldn't reach the chain's origin hash) — check it's a real bustabit game hash".to_string());
        }
        if steps & PROGRESS_MASK == 0 {
            report("locating", steps, 0);
        }
    }
    let game_number = chain_offset + steps;
    if game_number < CLASSIC_START {
        return Err(format!(
            "this hash is a Vx-era game (#{game_number}); only classic-era games (#{CLASSIC_START} and later) are supported"
        ));
    }

    // Pass 2 — aggregate stats over the classic games, newest -> oldest.
    let mut hash = start;
    let total_games = game_number - CLASSIC_START + 1;
    let mut green_count: u64 = 0;
    let mut instant_busts: u64 = 0;
    let mut sum_bust: f64 = 0.0;
    let mut max_bust: f64 = 0.0;
    let mut max_bust_game: u64 = game_number;
    let mut distribution = [0u64; 5];
    let mut green_streaks = [0u64; 8];
    let mut red_streaks = [0u64; 8];
    // Exact red-streak length counts (index = length - 1), grown on demand.
    let mut red_exact: Vec<u64> = Vec::new();

    // Streak tracking. We walk newest -> oldest, so the first run we see is the
    // "current" (most recent) streak.
    let mut run_len: u64 = 0;
    let mut run_green = false;
    let mut longest_green_streak: u64 = 0;
    let mut longest_red_streak: u64 = 0;
    let mut current_streak_len: u64 = 0;
    let mut current_streak_green = false;
    let mut first_run = true;

    report("analyzing", 0, total_games);
    let mut gid = game_number;
    while gid >= CLASSIC_START {
        let bust = bust_of_bytes(&hash);
        let is_green = bust >= GREEN_THRESHOLD;

        sum_bust += bust;
        if is_green {
            green_count += 1;
        }
        if bust <= 1.0 {
            instant_busts += 1;
        }
        if bust > max_bust {
            max_bust = bust;
            max_bust_game = gid;
        }
        distribution[dist_index(bust)] += 1;

        // Streak bookkeeping.
        if run_len == 0 {
            run_len = 1;
            run_green = is_green;
        } else if is_green == run_green {
            run_len += 1;
        } else {
            // Run ended; record it.
            close_run(
                run_len,
                run_green,
                &mut green_streaks,
                &mut red_streaks,
                &mut red_exact,
                &mut longest_green_streak,
                &mut longest_red_streak,
            );
            if first_run {
                current_streak_len = run_len;
                current_streak_green = run_green;
                first_run = false;
            }
            run_len = 1;
            run_green = is_green;
        }

        // Previous game's hash = sha256 of the raw bytes (current chain). (docs §1)
        hash = Sha256::digest(&hash).to_vec();
        gid -= 1;

        let analyzed = game_number - gid;
        if analyzed & PROGRESS_MASK == 0 {
            report("analyzing", analyzed, total_games);
        }
    }

    // Close the final (oldest) run.
    if run_len > 0 {
        close_run(
            run_len,
            run_green,
            &mut green_streaks,
            &mut red_streaks,
            &mut red_exact,
            &mut longest_green_streak,
            &mut longest_red_streak,
        );
        if first_run {
            current_streak_len = run_len;
            current_streak_green = run_green;
        }
    }

    let dist_labels = ["<2×", "2–5×", "5–10×", "10–100×", "≥100×"];
    let distribution = dist_labels
        .iter()
        .enumerate()
        .map(|(i, l)| DistBucket {
            label: l.to_string(),
            count: distribution[i],
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
        to_game: CLASSIC_START,
        total_games,
        green_count,
        red_count: total_games - green_count,
        instant_busts,
        mean_bust: sum_bust / total_games as f64,
        max_bust,
        max_bust_game,
        longest_green_streak,
        longest_red_streak,
        current_streak_len,
        current_streak_green,
        distribution,
        streaks,
        red_streak_hist,
    })
}

/// Record a finished streak into the length-distribution buckets and update the
/// per-colour longest-streak maxima. Red runs are also tallied at exact length
/// in `red_exact` (grown on demand) for the dedicated red-streak charts.
fn close_run(
    len: u64,
    green: bool,
    green_streaks: &mut [u64; 8],
    red_streaks: &mut [u64; 8],
    red_exact: &mut Vec<u64>,
    longest_green: &mut u64,
    longest_red: &mut u64,
) {
    let idx = streak_index(len);
    if green {
        green_streaks[idx] += 1;
        *longest_green = (*longest_green).max(len);
    } else {
        red_streaks[idx] += 1;
        *longest_red = (*longest_red).max(len);
        let i = (len - 1) as usize;
        if i >= red_exact.len() {
            red_exact.resize(i + 1, 0);
        }
        red_exact[i] += 1;
    }
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
    use super::compute_bust;

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
        use sha2::{Digest, Sha256};
        let mut h = hex::decode(start_hex).unwrap();
        for _ in 0..steps {
            h = Sha256::digest(&h).to_vec();
        }
        hex::encode(h)
    }

    const START: &str = "df5d54b8ca42cb40ea80e8ba74b3281f7b9d49bc27fecbe104847de1e91e4929";

    #[test]
    fn history_invariants() {
        use super::{compute_history_inner, CLASSIC_START};
        // 10 steps to inception, offset so game_number lands 10 above CLASSIC_START.
        let inception = synthetic_inception(START, 10);
        let offset = CLASSIC_START; // game_number = CLASSIC_START + 10
        let s = compute_history_inner(START, &inception, offset, 100, &|_, _, _| {}).unwrap();

        assert_eq!(s.from_game, CLASSIC_START + 10);
        assert_eq!(s.to_game, CLASSIC_START);
        assert_eq!(s.total_games, 11);
        assert_eq!(s.green_count + s.red_count, s.total_games);
        let dist: u64 = s.distribution.iter().map(|b| b.count).sum();
        assert_eq!(dist, s.total_games);
        assert!(s.longest_green_streak <= s.total_games);
        assert!(s.longest_red_streak <= s.total_games);
        assert!(s.max_bust >= 1.0);
    }

    #[test]
    fn history_rejects_off_chain_hash() {
        use super::compute_history_inner;
        // Inception that the walk will never reach within the cap.
        let bogus = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(compute_history_inner(START, bogus, 10_000_000, 50, &|_, _, _| {}).is_err());
    }

    #[test]
    fn history_rejects_pre_classic() {
        use super::compute_history_inner;
        // 3 steps, tiny offset → derived game_number well below CLASSIC_START.
        let inception = synthetic_inception(START, 3);
        assert!(compute_history_inner(START, &inception, 100, 50, &|_, _, _| {}).is_err());
    }
}
