// The prompt the user hands to ChatGPT/Claude. The assistant interviews them
// about what they want to see, then replies with a SINGLE JSON object describing
// one dashboard widget — title, description, axis titles, format, and the SQLite
// query that feeds it. The app parses that JSON, runs the query, and offers the
// render types the result can support. So the user never has to know SQL, the
// schema, or which chart type fits — they paste one block and pick a picture.

export const AI_PROMPT = `You are helping me build a custom widget for a desktop app that analyses bustabit crash-game history. First interview me briefly so you understand the metric, grouping, filters, and preferred presentation. Ask one or more concise clarification questions when the request is ambiguous. Once the requirements are clear, reply with ONLY one \`\`\`json code block containing a single widget object (no prose before or after it).

## Database
There is one read-only SQLite table:
  games(game_id INTEGER, hash TEXT, bust_centi INTEGER, is_green INTEGER)

Column meanings:
- game_id: game number. Higher numbers are more recent. Ordering by game_id ASC is chronological order.
- hash: provably-fair game hash. It is rarely useful for analysis.
- bust_centi: crash multiplier in hundredths. 100 = 1.00x, 250 = 2.50x, and 3865 = 38.65x. Divide by 100.0 when returning a multiplier.
- is_green: 1 when bust_centi >= 200 (the game reached at least 2.00x), otherwise 0.
- "green" means is_green = 1 (at least 2x). "red" means is_green = 0 (below 2x).

## Mandatory SQL rules
- Produce one read-only SQLite query. A query may begin with WITH and end in one SELECT.
- Never use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, REPLACE, PRAGMA, ATTACH, DETACH, VACUUM, or multiple statements.
- Do not add a trailing semicolon.
- Every read from games MUST be bounded by game_id <= ?1. The app binds ?1 to the latest game currently selected. Reuse ?1 wherever needed, including nested subqueries.
- Do not assume game IDs are contiguous. Use game_id only for chronological ordering; use row numbers or counts for sequence positions.
- Use SQLite syntax and functions only.

## Required result shape
Choose the shape before writing the query.

STAT card:
- Return exactly one row whenever practical.
- Return the main result in a column named value.
- Other columns may supply hint placeholders. For example, SQL can return value and g while JSON uses "hint": "at game #{g}".
- Choose format carefully: int for counts/lengths, mult for a numeric multiplier already divided by 100.0, pct for a number from 0 to 100, or text for preformatted output.
- Prefer a numeric value plus the correct format over formatting numbers with printf. Numeric values are easier for the app to handle.
- Use COALESCE when an aggregate may be NULL and a sensible zero exists.

CHART (bar, line, or area):
- Return the X/category column FIRST.
- Return one or more numeric series columns after it.
- Return at least two rows.
- Use clear, short column aliases because they become series labels.
- Always use ORDER BY to guarantee display order.
- Use a bar chart for discrete categories or frequencies, a line chart for ordered trends/rates, and an area chart for an ordered magnitude where filled area is meaningful.
- Avoid huge result sets. Aggregate into meaningful buckets or use a justified LIMIT when raw games would create an unreadable chart.

## How to craft a reliable query
1. Restate the requested metric precisely: population, threshold, unit, grouping, and whether the result is a stat or chart.
2. Pick the row grain. Decide whether one intermediate row represents a game, a normal streak, an alternating streak, or a display bucket.
3. Apply game_id <= ?1 in the first CTE or every direct games subquery so no future game leaks into the result.
4. Build complex analysis in small named CTE stages. Typical stages are ordered rows, boundary markers, island IDs, aggregated runs, and final display rows.
5. Shape and alias only the final SELECT for the widget contract.
6. Check edge cases: no matching rows, one game, division by zero, tied maxima, missing game IDs, and NULL aggregates.
7. Check units. bust_centi is hundredths, pct expects 0..100, and integer division must be avoided.
8. Check chronology. Window functions used for sequences should normally use ORDER BY game_id ASC.
9. Check chart ordering and ensure all series after the first column are numeric.
10. Keep the query no more complex than the requested metric requires.

## SQLite calculation guidance
- Force real-number division with 100.0, 1.0, or CAST(... AS REAL). For example: 100.0 * SUM(is_green) / COUNT(*).
- For conditional counts, use SUM(condition), because SQLite evaluates a true comparison as 1 and false as 0. Example: SUM(is_green = 0).
- Protect a denominator that might be zero with NULLIF(denominator, 0).
- Use COALESCE(MAX(...), 0) when zero is the correct empty-history result.
- Round only the final displayed percentage, not intermediate values.
- To choose one game when multiple games tie, use an explicit ORDER BY and LIMIT 1.
- LAG and LEAD inspect neighboring rows; ROW_NUMBER and cumulative SUM are useful for gaps-and-islands.
- Window-function aliases generally cannot be reused in the same SELECT level. Put them in a CTE, then reference them in the next stage.

## Sample queries adapted from built-in widgets
These are known-good patterns. Adapt them instead of inventing a different pattern when the request is similar.

1. Games analysed (simple stat with hint columns)
  SELECT COUNT(*) AS value, MIN(game_id) AS min, MAX(game_id) AS max FROM games WHERE game_id <= ?1
Suggested JSON fields: type stat, format int, hint "#{min} → #{max}".

2. Green rate (percentage stat)
  SELECT 100.0 * SUM(is_green) / COUNT(*) AS value, SUM(is_green) AS g FROM games WHERE game_id <= ?1
Suggested JSON fields: type stat, format pct, hint "≥2x · {g} games".

3. Red rate (conditional percentage stat)
  SELECT 100.0 * SUM(is_green = 0) / COUNT(*) AS value, SUM(is_green = 0) AS g FROM games WHERE game_id <= ?1
Suggested JSON fields: type stat, format pct, hint "<2x · {g} games".

4. Maximum bust and the most recent game where it occurred
  SELECT MAX(bust_centi) / 100.0 AS value, (SELECT game_id FROM games WHERE game_id <= ?1 AND bust_centi = (SELECT MAX(bust_centi) FROM games WHERE game_id <= ?1) ORDER BY game_id DESC LIMIT 1) AS g FROM games WHERE game_id <= ?1
Suggested JSON fields: type stat, format mult, hint "at game #{g}".
Notice that every nested read from games repeats the ?1 bound.

5. Longest same-colour streak (gaps-and-islands stat)
  WITH grp AS (
    SELECT game_id, is_green AS green,
           game_id - ROW_NUMBER() OVER (PARTITION BY is_green ORDER BY game_id) AS island
    FROM games WHERE game_id <= ?1
  ), runs AS (
    SELECT green, COUNT(*) AS len
    FROM grp
    GROUP BY green, island
  )
  SELECT COALESCE(MAX(len), 0) AS value
  FROM runs
  WHERE green = 0
This returns the longest red streak. Change the final predicate to green = 1 for green. The subtraction is safe with missing game IDs because rows of the same colour retain a constant difference only while consecutive in the full chronological sequence.

6. Longest alternating streak starting with a chosen colour
  WITH ordered AS (
    SELECT game_id, is_green AS green,
           LAG(is_green) OVER (ORDER BY game_id) AS prev_green
    FROM games WHERE game_id <= ?1
  ), marked AS (
    SELECT game_id, green,
           CASE WHEN prev_green IS NULL OR green = prev_green THEN 1 ELSE 0 END AS starts
    FROM ordered
  ), grp AS (
    SELECT game_id, green,
           SUM(starts) OVER (ORDER BY game_id ROWS UNBOUNDED PRECEDING) AS island
    FROM marked
  ), alt_runs AS (
    SELECT island, COUNT(*) AS len, MIN(game_id) AS lo
    FROM grp
    GROUP BY island
  ), runs AS (
    SELECT a.len, g.green AS start_green
    FROM alt_runs a
    JOIN grp g ON g.island = a.island AND g.game_id = a.lo
  )
  SELECT COALESCE(MAX(len), 0) AS value
  FROM runs
  WHERE start_green = 0
Use start_green = 0 for red-start and start_green = 1 for green-start. A new alternating island begins when the current colour equals the previous colour.

7. Red streak-length frequency (bar chart)
  WITH grp AS (
    SELECT game_id, is_green AS green,
           game_id - ROW_NUMBER() OVER (PARTITION BY is_green ORDER BY game_id) AS island
    FROM games WHERE game_id <= ?1
  ), runs AS (
    SELECT green, COUNT(*) AS len
    FROM grp
    GROUP BY green, island
  )
  SELECT len AS streak_length, COUNT(*) AS frequency
  FROM runs
  WHERE green = 0
  GROUP BY len
  ORDER BY streak_length
The first column is the X value and the second is numeric, so this supports a bar, line, or area chart; bar is the best suggestion for a frequency distribution.

8. Red streak continuation rate by reached length (line chart)
  WITH grp AS (
    SELECT game_id, is_green AS green,
           game_id - ROW_NUMBER() OVER (PARTITION BY is_green ORDER BY game_id) AS island
    FROM games WHERE game_id <= ?1
  ), runs AS (
    SELECT green, COUNT(*) AS len
    FROM grp
    GROUP BY green, island
  ), histogram AS (
    SELECT len AS length, COUNT(*) AS count
    FROM runs
    WHERE green = 0
    GROUP BY len
  ), survival AS (
    SELECT length,
           SUM(count) OVER (ORDER BY length DESC) AS reached
    FROM histogram
  )
  SELECT length,
         ROUND(100.0 * COALESCE(LEAD(reached) OVER (ORDER BY length), 0) / NULLIF(reached, 0), 2) AS continuation_pct
  FROM survival
  ORDER BY length
At length N, reached counts streaks with length at least N. LEAD(reached) is the number that reached N+1, so their ratio is the conditional continuation percentage.

## JSON output contract
Return exactly these fields and omit fields that do not apply:
{
  "type": "stat" | "bar" | "line" | "area",
  "title": "Short widget title",
  "description": "One sentence explaining the chart",
  "sql": "SELECT ... FROM games WHERE game_id <= ?1 ...",
  "format": "int" | "mult" | "pct" | "text",
  "hint": "at game #{g}",
  "xTitle": "X axis label",
  "yTitle": "Y axis label"
}

Output requirements:
- Output valid JSON: double quotes, no comments, and no trailing commas.
- The sql field must be one valid JSON string. Escape line breaks as \\n or keep the SQL on one line.
- Include description, xTitle, and yTitle for charts; omit them for stats.
- Include format and optional hint for stats; omit them for charts.
- Keep titles short and labels specific.
- Output nothing outside the single JSON code block.

## What happens next
I paste your JSON into the app, which runs the SQL against local history, detects compatible render types from the result shape, and shows a live preview. Therefore prioritize correct SQLite, the exact output-column contract, useful aliases, and JSON that parses on the first try.

Now ask what I would like to visualise.`;

/**
 * A ChatGPT deep-link that opens a fresh chat with {@link AI_PROMPT} pre-filled
 * (and submitted) in the composer. ChatGPT natively reads the `?q=` query param,
 * so no browser extension is required. Opened via the Tauri opener plugin.
 */
export function chatGptUrl(): string {
  return `https://chatgpt.com/?q=${encodeURIComponent(AI_PROMPT)}`;
}
