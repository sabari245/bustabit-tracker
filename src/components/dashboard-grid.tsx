import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MAX_PER_ROW, type DashboardRow, type Widget } from "@/lib/dashboard-spec";

type GridRow = { rowId: string; items: Widget[] };

const NEW_ROW = "new-row";

function toGridRows(rows: DashboardRow[]): GridRow[] {
  return rows.map((r) => ({ rowId: r.id ?? crypto.randomUUID(), items: r.widgets }));
}

function fromGridRows(rows: GridRow[]): DashboardRow[] {
  return rows.map((r) => ({ id: r.rowId, widgets: r.items }));
}

/** Locate the row a draggable/droppable id belongs to, or the new-row zone. */
function findRowIndex(rows: GridRow[], id: string): number | "new-row" | null {
  if (id === NEW_ROW) return "new-row";
  if (id.startsWith("row:")) {
    const idx = rows.findIndex((r) => r.rowId === id.slice(4));
    return idx === -1 ? null : idx;
  }
  const idx = rows.findIndex((r) => r.items.some((it) => it.id === id));
  return idx === -1 ? null : idx;
}

// Prefer pointer-based detection so the empty new-row zone is reachable; fall
// back to rectangle intersection when the pointer is between rows.
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

function SortableItem({
  item,
  children,
  onEdit,
  onDelete,
}: {
  item: Widget;
  children: ReactNode;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id ?? "" });

  const style = { transform: CSS.Transform.toString(transform), transition };
  const editable = item.kind !== "tabs";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("group/item relative min-w-0 flex-1", isDragging && "opacity-40")}
    >
      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover/item:opacity-100">
        {editable && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Edit chart"
            onClick={() => onEdit(item.id ?? "")}
          >
            <Pencil />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Delete chart"
          onClick={() => onDelete(item.id ?? "")}
        >
          <Trash2 />
        </Button>
        <Button
          ref={setActivatorNodeRef}
          variant="ghost"
          size="icon"
          className="size-7 cursor-grab touch-none active:cursor-grabbing"
          aria-label="Drag to rearrange"
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </Button>
      </div>
      {children}
    </div>
  );
}

function RowDroppable({ rowId, children }: { rowId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row:${rowId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex gap-4 rounded-xl",
        isOver && "outline outline-1 outline-primary/40",
      )}
    >
      {children}
    </div>
  );
}

function NewRowZone() {
  const { setNodeRef, isOver } = useDroppable({ id: NEW_ROW });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-14 items-center justify-center rounded-xl border border-dashed text-sm transition-colors",
        isOver
          ? "border-primary bg-primary/5 text-primary"
          : "border-border text-muted-foreground",
      )}
    >
      Drop here to start a new row
    </div>
  );
}

/**
 * Drag-and-drop dashboard grid. Each row splits its width equally between its
 * widgets (`flex-1`), holds at most MAX_PER_ROW of them, and can be reordered
 * within or across rows. Dragging onto the trailing zone starts a new row.
 */
export function DashboardGrid({
  rows: rowsProp,
  renderItem,
  onChange,
  onEdit,
  onDelete,
}: {
  rows: DashboardRow[];
  renderItem: (widget: Widget) => ReactNode;
  onChange: (rows: DashboardRow[]) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [rows, setRows] = useState<GridRow[]>(() => toGridRows(rowsProp));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeWidth, setActiveWidth] = useState<number | undefined>();
  const snapshot = useRef<GridRow[]>(rows);

  // Re-sync when the layout changes from outside a drag (add / edit / delete).
  useEffect(() => {
    if (!activeId) setRows(toGridRows(rowsProp));
  }, [rowsProp, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeItem = activeId
    ? rows.flatMap((r) => r.items).find((i) => i.id === activeId) ?? null
    : null;

  function onDragStart(e: DragStartEvent) {
    snapshot.current = rows;
    setActiveId(String(e.active.id));
    setActiveWidth(e.active.rect.current.initial?.width);
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    const fromRow = findRowIndex(rows, activeIdStr);
    const toRow = findRowIndex(rows, overIdStr);
    if (fromRow == null || toRow == null) return;
    if (toRow === "new-row" || fromRow === "new-row") return; // handled on drop
    if (fromRow === toRow) return; // same-row reorder handled on drop
    if (rows[toRow].items.length >= MAX_PER_ROW) return; // max-4 rejection

    setRows((prev) => {
      const next = prev.map((r) => ({ ...r, items: [...r.items] }));
      const from = next[fromRow];
      const to = next[toRow];
      const ai = from.items.findIndex((i) => i.id === activeIdStr);
      if (ai === -1) return prev;
      const [moved] = from.items.splice(ai, 1);
      const oi = to.items.findIndex((i) => i.id === overIdStr);
      to.items.splice(oi === -1 ? to.items.length : oi, 0, moved);
      return next;
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    setActiveWidth(undefined);
    if (!over) {
      setRows(snapshot.current);
      return;
    }

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);
    const fromRow = findRowIndex(rows, activeIdStr);
    const toRow = findRowIndex(rows, overIdStr);
    if (fromRow == null || fromRow === "new-row" || toRow == null) {
      setRows(snapshot.current);
      return;
    }

    let next = rows.map((r) => ({ ...r, items: [...r.items] }));

    if (toRow === "new-row") {
      const from = next[fromRow];
      const ai = from.items.findIndex((i) => i.id === activeIdStr);
      const [moved] = from.items.splice(ai, 1);
      next.push({ rowId: crypto.randomUUID(), items: [moved] });
    } else if (fromRow === toRow) {
      const row = next[fromRow];
      const oldIndex = row.items.findIndex((i) => i.id === activeIdStr);
      const newIndex = row.items.findIndex((i) => i.id === overIdStr);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        row.items = arrayMove(row.items, oldIndex, newIndex);
      }
    }
    // Cross-row moves were already applied live in onDragOver.

    next = next.filter((r) => r.items.length > 0);
    if (next.some((r) => r.items.length > MAX_PER_ROW)) {
      setRows(snapshot.current); // defensive: never persist an over-full row
      return;
    }

    setRows(next);
    onChange(fromGridRows(next));
  }

  function onDragCancel() {
    setActiveId(null);
    setActiveWidth(undefined);
    setRows(snapshot.current);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex flex-col gap-4">
        {rows.map((row) => (
          <RowDroppable key={row.rowId} rowId={row.rowId}>
            <SortableContext
              items={row.items.map((i) => i.id ?? "")}
              strategy={horizontalListSortingStrategy}
            >
              {row.items.map((item) => (
                <SortableItem
                  key={item.id}
                  item={item}
                  onEdit={onEdit}
                  onDelete={onDelete}
                >
                  {renderItem(item)}
                </SortableItem>
              ))}
            </SortableContext>
          </RowDroppable>
        ))}
        <NewRowZone />
      </div>

      <DragOverlay>
        {activeItem ? (
          <div style={{ width: activeWidth }} className="opacity-90 shadow-lg">
            {renderItem(activeItem)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
