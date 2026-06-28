import { invoke } from "@tauri-apps/api/core";
import type { DashboardSpec } from "@/lib/dashboard-spec";

/** A custom view as stored in the cache db (spec is a JSON string). */
export type SavedView = {
  id: number;
  name: string;
  spec: string;
};

export function listViews(): Promise<SavedView[]> {
  return invoke<SavedView[]>("list_views");
}

export function saveView(name: string, spec: DashboardSpec): Promise<number> {
  return invoke<number>("save_view", { name, spec: JSON.stringify(spec) });
}

export function updateView(
  id: number,
  name: string,
  spec: DashboardSpec,
): Promise<void> {
  return invoke("update_view", { id, name, spec: JSON.stringify(spec) });
}

export function deleteView(id: number): Promise<void> {
  return invoke("delete_view", { id });
}

/** Parse a stored spec string; returns null if it isn't a usable spec. */
export function parseSpec(spec: string): DashboardSpec | null {
  try {
    const parsed = JSON.parse(spec) as DashboardSpec;
    if (parsed && Array.isArray(parsed.rows)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export type PrecomputeQuery = { id: string; sql: string };

// `viewId` is the owning view prefix (`builtin` or `view:<id>`); `tabValue` disambiguates the charts inside a `tabs` widget.
export function widgetId(
  viewId: string,
  rowIdx: number,
  widgetIdx: number,
  tabValue?: string,
): string {
  const base = `${viewId}:r${rowIdx}w${widgetIdx}`;
  return tabValue ? `${base}:${tabValue}` : base;
}

export function extractQueries(
  viewId: string,
  spec: DashboardSpec,
): PrecomputeQuery[] {
  const out: PrecomputeQuery[] = [];
  spec.rows.forEach((row, ri) => {
    row.widgets.forEach((w, wi) => {
      if (w.kind === "stat" || w.kind === "chart") {
        out.push({ id: widgetId(viewId, ri, wi), sql: w.sql });
      } else if (w.kind === "tabs") {
        w.tabs.forEach((t) => {
          out.push({
            id: widgetId(viewId, ri, wi, t.value),
            sql: t.chart.sql,
          });
        });
      }
    });
  });
  return out;
}
