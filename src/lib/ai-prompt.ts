// A ready-to-paste prompt the user hands to ChatGPT/Claude. The assistant then
// interviews them about what they want to see and replies with a single SQLite
// SELECT that drops straight into a widget's SQL box — so the user never has to
// know SQL or the schema.

export const AI_PROMPT = `I'm building a custom widget in a desktop app that analyses bustabit crash-game history. I need you to write ONE SQLite SELECT query for it. First, ask me what I want to visualise; once I answer, reply with ONLY the final SQL query in a code block (no explanation).

The database has a single table:
  games(game_id INTEGER, hash TEXT, bust_centi INTEGER, is_green INTEGER)
- game_id: the game number; higher = more recent.
- bust_centi: the crash multiplier in hundredths. 100 = 1.00x (an instant bust / loss), 250 = 2.50x, 3865 = 38.65x.
- is_green: 1 if the game reached at least 2.00x (a win for a 2x auto-cashout), else 0.

Rules for the query:
- It MUST be a single read-only SELECT (no INSERT/UPDATE/DELETE/PRAGMA).
- It MUST filter with "WHERE game_id <= ?1". The app binds ?1 to the most recent game currently in view. You may use ?1 as many times as needed.
- Choose the output columns based on the widget type I pick:
  * STAT (a single value card): return a column named "value" (the number or text to display) and, optionally, a column named "hint" (a short sub-label string). To show a multiplier nicely, format it as text, e.g. printf('%.2fx', MAX(bust_centi)/100.0) AS value.
  * CHART (bar / line / area): put the category or X value in the FIRST column, then one or more numeric columns (each numeric column becomes a bar/line/area series). Add ORDER BY so the rows come out in display order.

Useful facts:
- "red" = is_green = 0 (below 2x), "green" = is_green = 1.
- Consecutive-run / streak analysis uses gaps-and-islands:
    WITH grp AS (
      SELECT game_id, is_green,
             game_id - ROW_NUMBER() OVER (PARTITION BY is_green ORDER BY game_id) AS island
      FROM games WHERE game_id <= ?1
    ), runs AS (
      SELECT is_green, COUNT(*) AS len FROM grp GROUP BY is_green, island
    )
    -- each row in "runs" is one streak; len is its length.

Now ask me what I'd like to visualise.`;
