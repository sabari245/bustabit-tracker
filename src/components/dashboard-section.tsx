import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardRenderer } from "@/components/dashboard-renderer";
import { ViewEditor } from "@/components/view-editor";
import { DASHBOARD, type DashboardSpec } from "@/lib/dashboard-spec";
import {
  deleteView,
  listViews,
  parseSpec,
  type SavedView,
} from "@/lib/views";

const BUILTIN = "builtin";

export function DashboardSection({ game }: { game: number }) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState<string>(BUILTIN);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SavedView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(() => listViews().then(setViews), []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeView =
    selected === BUILTIN ? null : views.find((v) => String(v.id) === selected) ?? null;

  const spec: DashboardSpec =
    selected === BUILTIN ? DASHBOARD : parseSpec(activeView?.spec ?? "") ?? { rows: [] };

  function openNew() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit() {
    if (activeView) {
      setEditing(activeView);
      setEditorOpen(true);
    }
  }

  async function onSaved(id: number) {
    await refresh();
    setSelected(String(id));
  }

  async function doDelete() {
    if (!activeView) return;
    await deleteView(activeView.id);
    setConfirmDelete(false);
    setSelected(BUILTIN);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BUILTIN}>Built-in dashboard</SelectItem>
            {views.map((v) => (
              <SelectItem key={v.id} value={String(v.id)}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {activeView && (
          <>
            <Button variant="outline" size="sm" onClick={openEdit}>
              <Pencil />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
              Delete
            </Button>
          </>
        )}

        <Button size="sm" className="ml-auto" onClick={openNew}>
          <Plus />
          New view
        </Button>
      </div>

      <DashboardRenderer spec={spec} game={game} />

      <ViewEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        game={game}
        editing={editing}
        onSaved={onSaved}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this view?</AlertDialogTitle>
            <AlertDialogDescription>
              “{activeView?.name}” will be permanently removed. The cached game
              data is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
