import { invoke } from "@tauri-apps/api/core";

/** A single SQL cell value as it crosses the Tauri boundary. */
export type Cell = string | number | null;

/** One result row: column name -> value. */
export type Row = Record<string, Cell>;

/** True when a query cell can be plotted as a finite numeric value. */
export function isNumericCell(value: Cell): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(Number(value));
}

/** Convert a query cell into a chart value. Null stays null so charts can show gaps. */
export function chartNumber(value: Cell): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Run a read-only SQL query against the local history cache and get the rows
 * back as objects keyed by column name. This is the single primitive the whole
 * schema-driven dashboard is built on — every card and chart is just a SELECT.
 *
 * Use numbered placeholders (`?1`, `?2`, …) in the SQL and pass their values in
 * `params`; a placeholder may be reused (`?1` many times binds the same value).
 */
export function runQuery(sql: string, params: Cell[] = []): Promise<Row[]> {
  return invoke<Row[]>("run_query", { sql, params });
}
