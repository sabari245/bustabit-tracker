import { invoke } from "@tauri-apps/api/core";
import {
  DASHBOARD,
  MAX_PER_ROW,
  type DashboardSpec,
  type Widget,
} from "@/lib/dashboard-spec";

// The dashboard is a single persisted layout: a grid of rows, each row holding
// up to MAX_PER_ROW widgets. The whole arrangement — which widgets, in what
// order, in which rows — lives in one JSON document so reopening the app
// restores exactly what the user last arranged. The built-in DASHBOARD is only
// the *seed*; once persisted, the stored layout is the source of truth.

/** Parse a stored layout string; returns null if it isn't a usable spec. */
export function parseSpec(spec: string): DashboardSpec | null {
  try {
    const parsed = JSON.parse(spec) as DashboardSpec;
    if (parsed && Array.isArray(parsed.rows)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function loadLayout(): Promise<DashboardSpec | null> {
  const raw = await invoke<string | null>("load_layout");
  return raw ? parseSpec(raw) : null;
}

export function saveLayout(spec: DashboardSpec): Promise<void> {
  return invoke("save_layout", { spec: JSON.stringify(spec) });
}

function genId(): string {
  return crypto.randomUUID();
}

/** Assign a stable id to every row and widget that lacks one (in place-safe clone). */
export function ensureIds(spec: DashboardSpec): DashboardSpec {
  return {
    rows: spec.rows.map((row) => ({
      id: row.id ?? genId(),
      widgets: row.widgets.map((w) => ({ ...w, id: w.id ?? genId() })),
    })),
  };
}

/** Split any row wider than MAX_PER_ROW into consecutive rows of that width. */
export function normalizeRows(spec: DashboardSpec): DashboardSpec {
  const rows: DashboardSpec["rows"] = [];
  for (const row of spec.rows) {
    for (let i = 0; i < row.widgets.length; i += MAX_PER_ROW) {
      rows.push({ widgets: row.widgets.slice(i, i + MAX_PER_ROW) });
    }
  }
  return { rows };
}

/** The default layout used on first run: the built-in dashboard, made editable. */
export function seedLayout(): DashboardSpec {
  return ensureIds(normalizeRows(DASHBOARD));
}

/** Create a fresh widget id (for newly authored charts). */
export const newWidgetId = genId;

export type PrecomputeQuery = { id: string; sql: string };

// `tabValue` disambiguates the charts inside a `tabs` widget.
export function widgetId(id: string, tabValue?: string): string {
  return tabValue ? `${id}:${tabValue}` : id;
}

export function extractQueries(spec: DashboardSpec): PrecomputeQuery[] {
  const out: PrecomputeQuery[] = [];
  for (const row of spec.rows) {
    for (const w of row.widgets) {
      const id = w.id;
      if (!id) continue;
      if (w.kind === "stat" || w.kind === "chart") {
        out.push({ id: widgetId(id), sql: w.sql });
      } else if (w.kind === "tabs") {
        for (const t of w.tabs) {
          out.push({ id: widgetId(id, t.value), sql: t.chart.sql });
        }
      }
    }
  }
  return out;
}

/** Append a widget to the layout: into the last row if it has room, else a new row. */
export function appendWidget(spec: DashboardSpec, widget: Widget): DashboardSpec {
  const rows = spec.rows.map((r) => ({ ...r, widgets: [...r.widgets] }));
  const last = rows[rows.length - 1];
  if (last && last.widgets.length < MAX_PER_ROW) {
    last.widgets.push(widget);
  } else {
    rows.push({ id: genId(), widgets: [widget] });
  }
  return { rows };
}

/** Replace the widget with the same id, keeping its position. */
export function replaceWidget(spec: DashboardSpec, widget: Widget): DashboardSpec {
  return {
    rows: spec.rows.map((r) => ({
      ...r,
      widgets: r.widgets.map((w) => (w.id === widget.id ? widget : w)),
    })),
  };
}

/** Remove a widget by id and drop any row left empty. */
export function removeWidget(spec: DashboardSpec, id: string): DashboardSpec {
  return {
    rows: spec.rows
      .map((r) => ({ ...r, widgets: r.widgets.filter((w) => w.id !== id) }))
      .filter((r) => r.widgets.length > 0),
  };
}

/** Find a widget by id across all rows. */
export function findWidget(spec: DashboardSpec, id: string): Widget | null {
  for (const row of spec.rows) {
    for (const w of row.widgets) if (w.id === id) return w;
  }
  return null;
}
