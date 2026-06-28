import { useEffect, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";

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
        <Button size="sm" onClick={openNew}>
          <Plus />
          Add chart
        </Button>
      </div>

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
