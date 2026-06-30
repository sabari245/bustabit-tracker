// The prompt the user hands to ChatGPT/Claude. The assistant interviews them
// about what they want to see, then replies with a SINGLE JSON object describing
// one dashboard widget — title, description, axis titles, format, and the SQLite
// query that feeds it. The app parses that JSON, runs the query, and offers the
// render types the result can support. So the user never has to know SQL, the
// schema, or which chart type fits — they paste one block and pick a picture.

export const AI_PROMPT = `You are helping me build a custom widget for a desktop app that analyses bustabit crash-game history. Interview me, then output ONE JSON object the app can ingest. Ask me what I want to see; once I answer, reply with ONLY a single \`\`\`json code block (no prose before or after).

## The database
One SQLite table, read-only:
  games(game_id INTEGER, hash TEXT, bust_centi INTEGER, is_green INTEGER)
- game_id: the game number; higher = more recent. Append-only.
- hash: the provably-fair hash (you will not normally need this).
- bust_centi: the crash multiplier in hundredths. 100 = 1.00x (an instant bust / loss), 250 = 2.50x, 3865 = 38.65x. Divide by 100.0 for the real multiplier.
- is_green: 1 if the game reached at least 2.00x (a win for a 2x auto-cashout), else 0. Equivalent to bust_centi >= 200.

## The SQL query rules
- It MUST be a single read-only SELECT. No INSERT / UPDATE / DELETE / PRAGMA / ATTACH / semicolons chaining extra statements.
- It MUST filter with "WHERE game_id <= ?1". The app binds ?1 to the most recent game currently in view; reuse ?1 as many times as needed.
- Shape the output columns to the widget kind:
  * For a STAT (single-value card): return a column named "value" (the number or text shown big). Optionally a "hint" column for a short sub-label, and you can reference any other returned column inside the hint text with {column_name}.
  * For a CHART (bar / line / area): put the category or X value in the FIRST column, then one or more NUMERIC columns — each numeric column becomes its own bar/line/area series. Return at least 2 rows. Add ORDER BY so rows come out in display order.

## The JSON you output
Return exactly these fields (omit the ones that don't apply):
{
  "type": "stat" | "bar" | "line" | "area",   // your best-fit suggestion; the app lets me switch among the types my data supports
  "title": "Short widget title",
  "description": "One sentence on what it shows",   // charts only; ignored for stats
  "sql": "SELECT ... FROM games WHERE game_id <= ?1 ...",
  "format": "int" | "mult" | "pct" | "text",   // STAT only: how to format the value. int = 1,234 · mult = 2.50x · pct = 12.3% · text = as-is
  "hint": "at game #{g}",                        // STAT only: optional sub-label, may use {column} placeholders
  "xTitle": "X axis label",                     // CHART only
  "yTitle": "Y axis label"                      // CHART only
}
Rules for the JSON: valid JSON only (double quotes, no comments, no trailing commas), the "sql" value on a single logical string, and NOTHING outside the one code block.

## Useful facts
- "red" = is_green = 0 (below 2x); "green" = is_green = 1.
- A 2x-cashout win rate is: 100.0 * SUM(is_green) / COUNT(*).
- Format a multiplier as text in a stat with printf, e.g. printf('%.2fx', MAX(bust_centi)/100.0).
- Consecutive-run / streak analysis uses gaps-and-islands:
    WITH grp AS (
      SELECT game_id, is_green,
             game_id - ROW_NUMBER() OVER (PARTITION BY is_green ORDER BY game_id) AS island
      FROM games WHERE game_id <= ?1
    ), runs AS (
      SELECT is_green, COUNT(*) AS len FROM grp GROUP BY is_green, island
    )
    -- each row in "runs" is one streak; len is its length.

## What I do with your answer
I copy your JSON block, paste it into the app's "Paste widget JSON" box, watch a live preview render, pick the chart/stat style I like, and save. So make the title and labels clear, and make sure the JSON parses on the first try.

Now ask me what I'd like to visualise.`;

/**
 * A ChatGPT deep-link that opens a fresh chat with {@link AI_PROMPT} pre-filled
 * (and submitted) in the composer. ChatGPT natively reads the `?q=` query param,
 * so no browser extension is required. Opened via the Tauri opener plugin.
 */
export function chatGptUrl(): string {
  return `https://chatgpt.com/?q=${encodeURIComponent(AI_PROMPT)}`;
}
