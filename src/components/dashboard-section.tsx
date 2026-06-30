import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Download, Loader2, Plus } from "lucide-react";

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
import { DashboardGrid } from "@/components/dashboard-grid";
import { ChartEditor } from "@/components/chart-editor";
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
  widgetId,
} from "@/lib/layout";

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
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Save the whole cached game history to an .xlsx file the user picks. The
  // workbook itself is built in Rust (see the `export_history` command).
  async function exportXlsx() {
    setExportError(null);
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
      setExporting(true);
      const generatedAt = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      await invoke("export_history", { path, generatedAt });
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch (e) {
      setExportError(String(e));
    } finally {
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
            onClick={exportXlsx}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="animate-spin" />
            ) : exported ? (
              <Check />
            ) : (
              <Download />
            )}
            {exporting ? "Exporting…" : exported ? "Exported" : "Export XLSX"}
          </Button>
          <Button size="sm" onClick={openNew}>
            <Plus />
            Add chart
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
