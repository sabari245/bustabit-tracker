// Turning the assistant's JSON into a widget. The author flow no longer asks the
// user to pick a chart type up front: ChatGPT returns one JSON object describing
// the widget (title, description, axis titles, SQL, …), the app runs the SQL once,
// and the *shape of the result* decides which render types are even possible. The
// user then picks among those auto-detected options and saves.

import { isNumericCell, type Row } from "@/lib/query";
import type { Widget } from "@/lib/dashboard-spec";

export type DraftType = "stat" | "bar" | "line" | "area";

export const TYPE_LABELS: Record<DraftType, string> = {
  stat: "Stat",
  bar: "Bar chart",
  line: "Line chart",
  area: "Area chart",
};

export type StatFormat = "int" | "mult" | "pct" | "text";

/** A widget being authored, after parsing the assistant's JSON. */
export type WidgetDraft = {
  title: string;
  description: string;
  /** The assistant's suggested render type; the data shape still has final say. */
  type: DraftType;
  sql: string;
  format?: StatFormat;
  hint?: string;
  xTitle?: string;
  yTitle?: string;
};

const TYPES: DraftType[] = ["stat", "bar", "line", "area"];
const FORMATS: StatFormat[] = ["int", "mult", "pct", "text"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\n";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }

  return out;
}

/**
 * Parse the JSON the user pastes from ChatGPT/Claude into a draft. Tolerant of a
 * ```json fenced code block (assistants love wrapping output in one). Returns an
 * `error` string for anything that isn't a usable widget spec.
 */
export function parseWidgetJson(text: string): {
  draft?: WidgetDraft;
  error?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Paste the JSON the assistant gave you above." };

  // Strip a surrounding ```json … ``` fence if present.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let obj: unknown;
  try {
    obj = JSON.parse(unfenced);
  } catch {
    try {
      obj = JSON.parse(escapeControlCharsInStrings(unfenced));
    } catch {
      return {
        error: "That isn't valid JSON — copy the whole { … } object the assistant returned.",
      };
    }
  }
  if (typeof obj !== "object" || obj == null || Array.isArray(obj)) {
    return { error: "Expected a single JSON object describing the widget." };
  }

  const o = obj as Record<string, unknown>;
  if (str(o.sql) == null) {
    return { error: 'The JSON is missing its "sql" query.' };
  }

  const type = (TYPES as string[]).includes(o.type as string)
    ? (o.type as DraftType)
    : "stat";
  const format = (FORMATS as string[]).includes(o.format as string)
    ? (o.format as StatFormat)
    : undefined;

  return {
    draft: {
      title: str(o.title) ?? "",
      description: str(o.description) ?? "",
      type,
      sql: (o.sql as string).trim(),
      format,
      hint: str(o.hint),
      xTitle: str(o.xTitle),
      yTitle: str(o.yTitle),
    },
  };
}

/**
 * Which render types the query's result can actually support:
 *   - a `value` column  → a Stat card,
 *   - ≥2 rows with a numeric column past the first → bar / line / area charts.
 * The fallback guarantees the user is never left with zero options.
 */
export function compatibleTypes(rows: Row[]): DraftType[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  const x = cols[0];
  const numericSeries = cols.filter(
    (c) => c !== x && rows.some((r) => isNumericCell(r[c])),
  );
  const nullableSeries = cols.filter(
    (c) => c !== x && rows.every((r) => r[c] == null),
  );
  const chartSeries = numericSeries.length > 0 ? numericSeries : nullableSeries;

  const types: DraftType[] = [];
  if (cols.includes("value")) types.push("stat");
  if (rows.length >= 2 && chartSeries.length > 0) {
    types.push("bar", "line", "area");
  }

  if (types.length === 0) {
    if (chartSeries.length > 0) types.push("bar", "line", "area");
    else types.push("stat");
  }
  return types;
}

/** Build a persisted widget from a draft and the chosen render type. */
export function buildWidget(
  id: string,
  draft: WidgetDraft,
  type: DraftType,
): Widget {
  const title = draft.title.trim() || "Untitled";
  if (type === "stat") {
    return {
      kind: "stat",
      id,
      title,
      sql: draft.sql,
      format: draft.format,
      hint: draft.hint,
    };
  }
  return {
    kind: "chart",
    id,
    type,
    title,
    sql: draft.sql,
    description: draft.description || undefined,
    xTitle: draft.xTitle,
    yTitle: draft.yTitle,
  };
}

/** Serialise an existing widget back to the JSON the editor box understands. */
export function widgetToJson(w: Widget): string {
  if (w.kind === "stat") {
    return JSON.stringify(
      { title: w.title, type: "stat", sql: w.sql, format: w.format, hint: w.hint },
      null,
      2,
    );
  }
  if (w.kind === "chart") {
    return JSON.stringify(
      {
        title: w.title,
        description: w.description,
        type: w.type,
        sql: w.sql,
        xTitle: w.xTitle,
        yTitle: w.yTitle,
      },
      null,
      2,
    );
  }
  return JSON.stringify({ title: w.title, type: "bar", sql: "" }, null, 2);
}
