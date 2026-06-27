// The dashboard as data. Each widget names what to render and the single SQL
// query that feeds it; `?1` is bound to the entered game's number (the upper
// bound of the history). The renderer is generic — adding a card or chart is a
// matter of adding an entry here, which is what later makes user-defined views
// possible. All queries read the local libSQL cache populated by compute_history.

export type Series = { key: string; label: string; color: string };
export type WidgetSize = "stat" | "half" | "full";

export type StatWidgetSpec = {
  kind: "stat";
  size?: WidgetSize;
  title: string;
  sql: string;
  /** How to format the `value` column. */
  format?: "int" | "mult" | "pct" | "text";
  unit?: string;
  /** Sub-label; `{col}` placeholders are filled from the result row. */
  hint?: string;
};

export type ChartWidgetSpec = {
  kind: "chart";
  type: "bar" | "line" | "area";
  size?: WidgetSize;
  title: string;
  description?: string;
  /** Shown above the chart when embedded in a tab. */
  note?: string;
  sql: string;
  /** Category/X column name. */
  x: string;
  series: Series[];
  refLine?: number;
  yUnit?: string;
  yDomain?: [number, number];
};

export type TabSpec = { value: string; label: string; chart: ChartWidgetSpec };

export type TabsWidgetSpec = {
  kind: "tabs";
  size?: WidgetSize;
  title: string;
  description?: string;
  tabs: TabSpec[];
};

export type Widget = StatWidgetSpec | ChartWidgetSpec | TabsWidgetSpec;
export type DashboardSpec = { rows: { widgets: Widget[] }[] };

// Shared CTE: collapse consecutive same-colour games into runs via gaps-and-
// islands. Reused by every streak query. Reads the precomputed `is_green` flag
// directly so the (is_green, game_id) index can satisfy the window ordering.
const RUNS = `
  WITH grp AS (
    SELECT game_id, is_green AS green,
           game_id - ROW_NUMBER() OVER (PARTITION BY is_green ORDER BY game_id) AS island
    FROM games WHERE game_id <= ?1
  ),
  runs AS (
    SELECT green, COUNT(*) AS len, MAX(game_id) AS hi
    FROM grp GROUP BY green, island
  )`;

// Exact red-streak length histogram, built on top of RUNS.
const RED_HIST = `${RUNS},
  rs AS (SELECT len AS length, COUNT(*) AS count FROM runs WHERE green = 0 GROUP BY len)`;

const RED = "var(--destructive)";

export const DASHBOARD: DashboardSpec = {
  rows: [
    {
      // Top row: eight at-a-glance stats. They fold 4-up / 2-up via flex-wrap.
      widgets: [
        {
          kind: "stat",
          title: "Games analysed",
          format: "int",
          hint: "#{min} → #{max}",
          sql: "SELECT COUNT(*) AS value, MIN(game_id) AS min, MAX(game_id) AS max FROM games WHERE game_id <= ?1",
        },
        {
          kind: "stat",
          title: "Max bust",
          format: "mult",
          hint: "at game #{g}",
          sql: `SELECT MAX(bust_centi) / 100.0 AS value,
                  (SELECT game_id FROM games
                   WHERE game_id <= ?1 AND bust_centi = (SELECT MAX(bust_centi) FROM games WHERE game_id <= ?1)
                   ORDER BY game_id DESC LIMIT 1) AS g
                FROM games WHERE game_id <= ?1`,
        },
        {
          kind: "stat",
          title: "Green rate",
          format: "pct",
          hint: "≥2× · {g} games",
          sql: "SELECT 100.0 * SUM(is_green) / COUNT(*) AS value, SUM(is_green) AS g FROM games WHERE game_id <= ?1",
        },
        {
          kind: "stat",
          title: "Instant busts",
          format: "pct",
          hint: "1.00× · {g} games",
          sql: "SELECT 100.0 * SUM(bust_centi <= 100) / COUNT(*) AS value, SUM(bust_centi <= 100) AS g FROM games WHERE game_id <= ?1",
        },
        {
          kind: "stat",
          title: "Longest green streak",
          format: "int",
          hint: "consecutive ≥2×",
          sql: `${RUNS} SELECT COALESCE(MAX(len), 0) AS value FROM runs WHERE green = 1`,
        },
        {
          kind: "stat",
          title: "Longest red streak",
          format: "int",
          hint: "consecutive <2×",
          sql: `${RUNS} SELECT COALESCE(MAX(len), 0) AS value FROM runs WHERE green = 0`,
        },
        {
          kind: "stat",
          title: "Current streak",
          format: "text",
          hint: "at the entered game",
          sql: `${RUNS}
                SELECT printf('%d %s', len, CASE WHEN green = 1 THEN 'green' ELSE 'red' END) AS value
                FROM runs WHERE hi = ?1`,
        },
        {
          kind: "stat",
          title: "Mean bust",
          format: "mult",
          hint: "average multiplier",
          sql: "SELECT AVG(bust_centi) / 100.0 AS value FROM games WHERE game_id <= ?1",
        },
      ],
    },
    {
      // Two half-width charts, side by side (fold to stacked on narrow windows).
      widgets: [
        {
          kind: "chart",
          type: "bar",
          title: "Bust distribution",
          description: "How often each multiplier range hits",
          x: "label",
          series: [{ key: "count", label: "Games", color: "var(--chart-1)" }],
          sql: `WITH d AS (
                  SELECT
                    SUM(bust_centi < 200) AS b0,
                    SUM(bust_centi >= 200 AND bust_centi < 500) AS b1,
                    SUM(bust_centi >= 500 AND bust_centi < 1000) AS b2,
                    SUM(bust_centi >= 1000 AND bust_centi < 10000) AS b3,
                    SUM(bust_centi >= 10000) AS b4
                  FROM games WHERE game_id <= ?1
                )
                SELECT label, count FROM (
                  SELECT '<2×' AS label, 0 AS ord, b0 AS count FROM d
                  UNION ALL SELECT '2–5×', 1, b1 FROM d
                  UNION ALL SELECT '5–10×', 2, b2 FROM d
                  UNION ALL SELECT '10–100×', 3, b3 FROM d
                  UNION ALL SELECT '≥100×', 4, b4 FROM d
                ) ORDER BY ord`,
        },
        {
          kind: "chart",
          type: "bar",
          title: "Streak lengths",
          description: "Number of green vs red runs by length",
          x: "label",
          series: [
            { key: "green", label: "Green runs", color: "var(--chart-2)" },
            { key: "red", label: "Red runs", color: RED },
          ],
          sql: `${RUNS},
                labeled AS (
                  SELECT green, CASE
                    WHEN len BETWEEN 6 AND 10 THEN 6
                    WHEN len BETWEEN 11 AND 20 THEN 7
                    WHEN len >= 21 THEN 8 ELSE len END AS ord
                  FROM runs
                ),
                buckets(label, ord) AS (
                  VALUES ('1',1),('2',2),('3',3),('4',4),('5',5),('6–10',6),('11–20',7),('21+',8)
                )
                SELECT b.label AS label,
                  COALESCE(SUM(CASE WHEN l.green = 1 THEN 1 END), 0) AS green,
                  COALESCE(SUM(CASE WHEN l.green = 0 THEN 1 END), 0) AS red
                FROM buckets b LEFT JOIN labeled l ON l.ord = b.ord
                GROUP BY b.ord, b.label ORDER BY b.ord`,
        },
      ],
    },
    {
      // Dedicated red-streak analysis, three views in tabs.
      widgets: [
        {
          kind: "tabs",
          title: "Red streaks",
          description: "Runs of consecutive games below 2×",
          tabs: [
            {
              value: "frequency",
              label: "Frequency",
              chart: {
                kind: "chart",
                type: "bar",
                title: "Frequency",
                note: "How many red streaks were exactly this many games long.",
                x: "length",
                series: [{ key: "count", label: "Red streaks", color: RED }],
                sql: `${RED_HIST} SELECT length, count FROM rs ORDER BY length`,
              },
            },
            {
              value: "survival",
              label: "Survival",
              chart: {
                kind: "chart",
                type: "area",
                title: "Survival",
                note: "Of all red streaks, the % that reached at least this length.",
                x: "length",
                yUnit: "%",
                yDomain: [0, 100],
                series: [{ key: "pct", label: "Reached ≥ length", color: RED }],
                sql: `${RED_HIST},
                      tot AS (SELECT SUM(count) AS s FROM rs)
                      SELECT length,
                             ROUND(100.0 * SUM(count) OVER (ORDER BY length DESC) / (SELECT s FROM tot), 2) AS pct
                      FROM rs ORDER BY length`,
              },
            },
            {
              value: "continuation",
              label: "Continuation",
              chart: {
                kind: "chart",
                type: "line",
                title: "Continuation",
                note: "Given a streak already reached length N, how often the next game was also red. Roughly flat ≈ the base red rate if rounds are independent (no “due for a green”).",
                x: "length",
                yUnit: "%",
                yDomain: [0, 100],
                refLine: 50,
                series: [{ key: "pct", label: "Continued to next", color: RED }],
                sql: `${RED_HIST},
                      s AS (SELECT length, SUM(count) OVER (ORDER BY length DESC) AS atleast FROM rs)
                      SELECT length,
                             ROUND(100.0 * COALESCE(LEAD(atleast) OVER (ORDER BY length), 0) / atleast, 2) AS pct
                      FROM s ORDER BY length`,
              },
            },
          ],
        },
      ],
    },
  ],
};
