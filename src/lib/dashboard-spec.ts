// The dashboard as data. Each widget names what to render and the single SQL
// query that feeds it; `?1` is bound to the entered game's number (the upper
// bound of the history). The renderer is generic — adding a card or chart is a
// matter of adding an entry here, which is what later makes user-defined views
// possible. All queries read the local libSQL cache populated by compute_history.

export type Series = { key: string; label: string; color: string };
export type WidgetSize = "stat" | "half" | "full";

/** Max widgets allowed on a single dashboard row (drag-and-drop constraint). */
export const MAX_PER_ROW = 4;

export type StatWidgetSpec = {
  kind: "stat";
  /** Stable id, used as the precompute key and the drag-and-drop item id. */
  id?: string;
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
  /** Stable id, used as the precompute key and the drag-and-drop item id. */
  id?: string;
  type: "bar" | "line" | "area";
  size?: WidgetSize;
  title: string;
  description?: string;
  /** Shown above the chart when embedded in a tab. */
  note?: string;
  sql: string;
  /** Category/X column name. Auto-detected (first column) when omitted. */
  x?: string;
  /** Series to plot. Auto-derived (the numeric columns) when omitted. */
  series?: Series[];
  /** Axis titles drawn alongside each axis (user-authored views supply these). */
  xTitle?: string;
  yTitle?: string;
  refLine?: number;
  /** Color points by odd/even x position while keeping the line neutral. */
  alternatingPointColors?: {
    oddColor: string;
    evenColor: string;
    lineColor?: string;
  };
  yUnit?: string;
  yDomain?: [number, number];
};

/** Palette for auto-derived chart series (user-authored views). */
export const CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export type TabSpec = { value: string; label: string; chart: ChartWidgetSpec };

export type TabsWidgetSpec = {
  kind: "tabs";
  /** Stable id, used as the precompute key and the drag-and-drop item id. */
  id?: string;
  size?: WidgetSize;
  title: string;
  description?: string;
  tabs: TabSpec[];
};

export type Widget = StatWidgetSpec | ChartWidgetSpec | TabsWidgetSpec;
/** A row of widgets. `id` is stable so drag-and-drop animations survive reorders. */
export type DashboardRow = { id?: string; widgets: Widget[] };
export type DashboardSpec = { rows: DashboardRow[] };

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

// Exact green-streak length histogram, built on top of RUNS.
const GREEN_HIST = `${RUNS},
  gs AS (SELECT len AS length, COUNT(*) AS count FROM runs WHERE green = 1 GROUP BY len)`;

// Shared CTE: collapse maximal alternating-colour games into runs. A run starts
// whenever the current colour matches the previous colour; otherwise it extends
// the current R-G-R-G... / G-R-G-R... run.
const ALT_RUNS = `
  WITH ordered AS (
    SELECT game_id, is_green AS green,
           LAG(is_green) OVER (ORDER BY game_id) AS prev_green
    FROM games WHERE game_id <= ?1
  ),
  marked AS (
    SELECT game_id, green,
           CASE WHEN prev_green IS NULL OR green = prev_green THEN 1 ELSE 0 END AS starts
    FROM ordered
  ),
  grp AS (
    SELECT game_id, green,
           SUM(starts) OVER (ORDER BY game_id ROWS UNBOUNDED PRECEDING) AS island
    FROM marked
  ),
  alt_runs AS (
    SELECT island, COUNT(*) AS len, MIN(game_id) AS lo, MAX(game_id) AS hi
    FROM grp GROUP BY island
  ),
  runs AS (
    SELECT a.len, a.hi, g.green AS start_green
    FROM alt_runs a
    JOIN grp g ON g.island = a.island AND g.game_id = a.lo
  )`;

const RED_ALT_HIST = `${ALT_RUNS},
  ars AS (SELECT len AS length, COUNT(*) AS count FROM runs WHERE start_green = 0 AND len >= 2 GROUP BY len)`;

const GREEN_ALT_HIST = `${ALT_RUNS},
  ags AS (SELECT len AS length, COUNT(*) AS count FROM runs WHERE start_green = 1 AND len >= 2 GROUP BY len)`;

const RED = "var(--destructive)";
const GREEN = "var(--chart-2)";

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
          title: "Red rate",
          format: "pct",
          hint: "<2× · {g} games",
          sql: "SELECT 100.0 * SUM(is_green = 0) / COUNT(*) AS value, SUM(is_green = 0) AS g FROM games WHERE game_id <= ?1",
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
          title: "Red alternating streak",
          format: "int",
          hint: "consecutive red/green games",
          sql: `${ALT_RUNS} SELECT COALESCE(MAX(len), 0) AS value FROM runs WHERE start_green = 0`,
        },
        {
          kind: "stat",
          title: "Green alternating streak",
          format: "int",
          hint: "consecutive green/red games",
          sql: `${ALT_RUNS} SELECT COALESCE(MAX(len), 0) AS value FROM runs WHERE start_green = 1`,
        },
      ],
    },

    {
      // Red and green continuation analysis share a row.
      widgets: [
        {
          kind: "tabs",
          title: "Red streaks",
          description: "Runs of consecutive games below 2×",
          tabs: [

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
        {
          // Green-streak analysis mirrors the red-streak views in the same row.
          kind: "tabs",
          title: "Green streaks",
          description: "Runs of consecutive games at or above 2×",
          tabs: [

            {
              value: "continuation",
              label: "Continuation",
              chart: {
                kind: "chart",
                type: "line",
                title: "Continuation",
                note: "Given a streak already reached length N, how often the next game was also green. Roughly flat ≈ the base green rate if rounds are independent.",
                x: "length",
                yUnit: "%",
                yDomain: [0, 100],
                refLine: 50,
                series: [{ key: "pct", label: "Continued to next", color: GREEN }],
                sql: `${GREEN_HIST},
                      s AS (SELECT length, SUM(count) OVER (ORDER BY length DESC) AS atleast FROM gs)
                      SELECT length,
                             ROUND(100.0 * COALESCE(LEAD(atleast) OVER (ORDER BY length), 0) / atleast, 2) AS pct
                      FROM s ORDER BY length`,
              },
            },
          ],
        },
      ],
    },
    {
      // Red-start and green-start alternating continuation analysis share a row.
      widgets: [
        {
          kind: "tabs",
          title: "Alternating streaks (red start)",
          description: "Runs that alternate below 2×, at least 2×, below 2×...",
          tabs: [
            {
              value: "continuation",
              label: "Continuation",
              chart: {
                kind: "chart",
                type: "line",
                title: "Continuation",
                note: "Given a red-start alternating streak already reached length N, how often the next game kept alternating.",
                x: "length",
                yUnit: "%",
                yDomain: [0, 100],
                refLine: 50,
                alternatingPointColors: {
                  oddColor: RED,
                  evenColor: GREEN,
                  lineColor: "var(--muted-foreground)",
                },
                series: [{ key: "pct", label: "Continued to next", color: RED }],
                sql: `${RED_ALT_HIST},
                      s AS (SELECT length, SUM(count) OVER (ORDER BY length DESC) AS atleast FROM ars)
                      SELECT length,
                             ROUND(100.0 * COALESCE(LEAD(atleast) OVER (ORDER BY length), 0) / atleast, 2) AS pct
                      FROM s ORDER BY length`,
              },
            },
          ],
        },
        {
          kind: "tabs",
          title: "Alternating streaks (green start)",
          description: "Runs that alternate at least 2×, below 2×, at least 2×...",
          tabs: [
            {
              value: "continuation",
              label: "Continuation",
              chart: {
                kind: "chart",
                type: "line",
                title: "Continuation",
                note: "Given a green-start alternating streak already reached length N, how often the next game kept alternating.",
                x: "length",
                yUnit: "%",
                yDomain: [0, 100],
                refLine: 50,
                alternatingPointColors: {
                  oddColor: GREEN,
                  evenColor: RED,
                  lineColor: "var(--muted-foreground)",
                },
                series: [{ key: "pct", label: "Continued to next", color: GREEN }],
                sql: `${GREEN_ALT_HIST},
                      s AS (SELECT length, SUM(count) OVER (ORDER BY length DESC) AS atleast FROM ags)
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
