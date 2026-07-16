import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Download, Loader2, Plus, RotateCcw } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DashboardGrid } from "@/components/dashboard-grid";
import { ChartEditor } from "@/components/chart-editor";
import {
  ExportProgressDialog,
  type ExportProgress,
} from "@/components/progress-dialog";
import { StatWidget } from "@/components/widgets/stat-widget";
import { ChartWidget } from "@/components/widgets/chart-widget";
import { TabsWidget } from "@/components/widgets/tabs-widget";
import type { DashboardRow, DashboardSpec, Widget } from "@/lib/dashboard-spec";
import type { Row } from "@/lib/query";
import {
  appendWidget,
  findWidget,
  removeWidget,
  replaceWidget,
  seedLayout,
  widgetId,
} from "@/lib/layout";

type ExportRange =
  | "100"
  | "1000"
  | "5000"
  | "10000"
  | "100000"
  | "custom"
  | "all";

type CacheInfo = {
  count: number;
  minGameId: number | null;
  maxGameId: number | null;
};

const EXPORT_RANGES: { value: ExportRange; label: string }[] = [
  { value: "100", label: "100" },
  { value: "1000", label: "1,000" },
  { value: "5000", label: "5,000" },
  { value: "10000", label: "10,000" },
  { value: "100000", label: "100,000" },
  { value: "all", label: "All" },
];

export function DashboardSection({
  game,
  layout,
  precomputed,
  onLayoutChange,
}: {
  game: number;
  layout: DashboardSpec;
  precomputed: Record<string, Row[]>;
  onLayoutChange: (spec: DashboardSpec) => void;
}) {
  // Local copy of the precomputed results so editing a widget's SQL can drop its
  // (now stale) cached row and let the widget re-query live.
  const [pre, setPre] = useState(precomputed);
  useEffect(() => setPre(precomputed), [precomputed]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Widget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportRangeOpen, setExportRangeOpen] = useState(false);
  const [exportRange, setExportRange] = useState<ExportRange>("1000");
  const [exportRowLimit, setExportRowLimit] = useState("1000");
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [cacheInfoLoading, setCacheInfoLoading] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress>({
    phase: "loading",
    current: 0,
    total: 0,
  });

  async function openExportRangeDialog() {
    setExportError(null);
    setExported(false);
    setExportRangeOpen(true);
    setCacheInfoLoading(true);
    try {
      setCacheInfo(await invoke<CacheInfo>("load_backtest_cache_info"));
    } catch (e) {
      setCacheInfo(null);
      setExportError(String(e));
    } finally {
      setCacheInfoLoading(false);
    }
  }

  useEffect(() => {
    if (exportRange === "all" && cacheInfo != null) {
      setExportRowLimit(String(cacheInfo.count));
    }
  }, [cacheInfo?.count, exportRange]);

  const selectedLimit =
    exportRowLimit === "" ||
    !Number.isSafeInteger(Number(exportRowLimit)) ||
    Number(exportRowLimit) < 1
      ? null
      : Number(exportRowLimit);
  const selectedRows =
    cacheInfo == null || selectedLimit == null
      ? null
      : Math.min(cacheInfo.count, selectedLimit);
  const canExportSelected =
    !exporting &&
    !cacheInfoLoading &&
    cacheInfo != null &&
    cacheInfo.count > 0 &&
    selectedRows != null &&
    selectedRows > 0;

  // Save the selected cached game history range to an .xlsx file the user picks.
  // The workbook itself is built in Rust (see the `export_history` command).
  async function exportXlsx() {
    setExportError(null);
    setExported(false);
    let unlisten: (() => void) | null = null;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    try {
      const path = await save({
        title: "Export game history",
        defaultPath: `bustabit-history-${date}.xlsx`,
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
      if (!path) return; // user cancelled the dialog
      setExportRangeOpen(false);
      setExportProgress({ phase: "loading", current: 0, total: 0 });
      setExportDialogOpen(true);
      setExporting(true);
      unlisten = await listen<ExportProgress>(
        "export-progress",
        (e) => setExportProgress(e.payload),
      );
      const generatedAt = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const rows = await invoke<number>("export_history", {
        path,
        generatedAt,
        rowLimit: selectedLimit,
      });
      setExportProgress((p) => ({
        phase: "completed",
        current: rows,
        total: p.total || rows,
      }));
      setExported(true);
      setTimeout(() => {
        setExported(false);
        setExportDialogOpen(false);
      }, 2000);
    } catch (e) {
      setExportError(String(e));
      setExportDialogOpen(false);
    } finally {
      unlisten?.();
      setExporting(false);
    }
  }

  function openNew() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(id: string) {
    const w = findWidget(layout, id);
    if (w) {
      setEditing(w);
      setEditorOpen(true);
    }
  }

  function onSaveChart(widget: Widget) {
    const exists = widget.id != null && findWidget(layout, widget.id) != null;
    if (exists && widget.id) {
      // Drop the stale precomputed row so the edited SQL runs fresh.
      setPre((p) => {
        const next = { ...p };
        delete next[widgetId(widget.id!)];
        return next;
      });
      onLayoutChange(replaceWidget(layout, widget));
    } else {
      onLayoutChange(appendWidget(layout, widget));
    }
  }

  function onReorder(rows: DashboardRow[]) {
    onLayoutChange({ rows });
  }

  function doDelete() {
    if (deleteId) onLayoutChange(removeWidget(layout, deleteId));
    setDeleteId(null);
  }

  function resetLayout() {
    setPre({});
    onLayoutChange(seedLayout());
    setResetOpen(false);
  }

  const renderItem = (w: Widget): ReactNode => {
    const id = w.id ?? "";
    if (w.kind === "stat") {
      return <StatWidget widget={w} game={game} precomputed={pre[widgetId(id)]} />;
    }
    if (w.kind === "tabs") {
      return <TabsWidget widget={w} game={game} precomputed={pre} />;
    }
    return <ChartWidget widget={w} game={game} precomputed={pre[widgetId(id)]} />;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Dashboard</h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={openExportRangeDialog}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : exported ? (
              <Check data-icon="inline-start" />
            ) : (
              <Download data-icon="inline-start" />
            )}
            {exporting ? "Exporting…" : exported ? "Exported" : "Export XLSX"}
          </Button>
          <Button size="sm" onClick={openNew}>
            <Plus data-icon="inline-start" />
            Add chart
          </Button>
          <Button size="sm" variant="outline" onClick={() => setResetOpen(true)}>
            <RotateCcw data-icon="inline-start" />
            Reset layout
          </Button>
        </div>
      </div>
      {exportError && (
        <p className="text-sm text-destructive">{exportError}</p>
      )}

      <DashboardGrid
        rows={layout.rows}
        renderItem={renderItem}
        onChange={onReorder}
        onEdit={openEdit}
        onDelete={setDeleteId}
      />

      <ChartEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        game={game}
        editing={editing}
        onSave={onSaveChart}
      />

      <Dialog
        open={exportRangeOpen}
        onOpenChange={(open) => {
          if (!exporting) setExportRangeOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export game history</DialogTitle>
            <DialogDescription>
              Choose how much cached history to export, counted back from the
              latest cached game.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="text-sm text-muted-foreground">
              {cacheInfoLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading cached history…
                </span>
              ) : cacheInfo && cacheInfo.count > 0 ? (
                <span>
                  Latest cached game #
                  {cacheInfo.maxGameId?.toLocaleString()}.{" "}
                  {cacheInfo.count.toLocaleString()} games available.
                </span>
              ) : cacheInfo ? (
                <span>No cached games are available to export.</span>
              ) : (
                <span>Cached history could not be loaded.</span>
              )}
            </div>

            <ToggleGroup
              type="single"
              variant="outline"
              value={exportRange}
              onValueChange={(value) => {
                if (!value) return;
                setExportRange(value as ExportRange);
                setExportRowLimit(
                  value === "all" && cacheInfo != null
                    ? String(cacheInfo.count)
                    : value === "all"
                      ? ""
                      : value,
                );
              }}
            >
              {EXPORT_RANGES.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <Input
              id="custom-export-range"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              placeholder="Custom number of games"
              aria-label="Custom number of games"
              value={exportRowLimit}
              onFocus={() => setExportRange("custom")}
              onChange={(event) => {
                setExportRange("custom");
                setExportRowLimit(event.target.value);
              }}
              aria-invalid={exportRowLimit !== "" && selectedLimit == null}
            />
            {exportRowLimit !== "" && selectedLimit == null && (
                <p className="text-sm text-destructive">
                  Enter a whole number greater than zero.
                </p>
              )}

            {selectedRows != null && cacheInfo && cacheInfo.count > 0 && (
              <p className="text-sm text-muted-foreground">
                {selectedRows.toLocaleString()} rows will be exported.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setExportRangeOpen(false)}
              disabled={exporting}
            >
              Cancel
            </Button>
            <Button onClick={exportXlsx} disabled={!canExportSelected}>
              {exporting && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              Continue to export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExportProgressDialog
        open={exportDialogOpen}
        progress={exportProgress}
      />

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset dashboard layout?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores the default charts and arrangement. Custom charts and
              layout changes will be removed, but cached game data is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={resetLayout}>Reset layout</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteId != null}
        onOpenChange={(o) => !o && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this chart?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be removed from your dashboard layout. The cached game data
              is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
