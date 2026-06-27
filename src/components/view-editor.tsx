import { useEffect, useRef, useState } from "react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { StatWidget } from "@/components/widgets/stat-widget";
import { ChartWidget } from "@/components/widgets/chart-widget";
import { AI_PROMPT } from "@/lib/ai-prompt";
import type { DashboardSpec, Widget } from "@/lib/dashboard-spec";
import { saveView, updateView, parseSpec, type SavedView } from "@/lib/views";

type DraftType = "stat" | "bar" | "line" | "area";
type Draft = { uid: number; title: string; type: DraftType; sql: string };

const TYPE_LABELS: Record<DraftType, string> = {
  stat: "Stat (single value)",
  bar: "Bar chart",
  line: "Line chart",
  area: "Area chart",
};

let nextUid = 1;
const blankDraft = (): Draft => ({ uid: nextUid++, title: "", type: "stat", sql: "" });

function draftToWidget(d: Draft): Widget {
  const title = d.title.trim() || "Untitled";
  if (d.type === "stat") return { kind: "stat", title, sql: d.sql };
  return { kind: "chart", type: d.type, title, sql: d.sql };
}

function widgetToDraft(w: Widget): Draft {
  if (w.kind === "stat") return { uid: nextUid++, title: w.title, type: "stat", sql: w.sql };
  if (w.kind === "chart")
    return { uid: nextUid++, title: w.title, type: w.type, sql: w.sql };
  // Tabs widgets aren't authored in this editor; flatten to nothing usable.
  return { uid: nextUid++, title: w.title, type: "bar", sql: "" };
}

function draftsFromSpec(spec: DashboardSpec): Draft[] {
  const drafts = spec.rows
    .flatMap((r) => r.widgets)
    .filter((w) => w.kind !== "tabs")
    .map(widgetToDraft);
  return drafts.length > 0 ? drafts : [blankDraft()];
}

/** A single widget being authored: title, type, SQL, AI-prompt helper, preview. */
function WidgetEditorCard({
  draft,
  game,
  onChange,
  onRemove,
  canRemove,
}: {
  draft: Draft;
  game: number | null;
  onChange: (d: Draft) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);

  async function copyPrompt() {
    await navigator.clipboard.writeText(AI_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const widget = draftToWidget(draft);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Input
          placeholder="Widget title"
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
        <Select
          value={draft.type}
          onValueChange={(v) => onChange({ ...draft, type: v as DraftType })}
        >
          <SelectTrigger className="w-[190px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TYPE_LABELS) as DraftType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Remove widget"
        >
          <Trash2 />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>SQL query</Label>
            <Button type="button" variant="outline" size="sm" onClick={copyPrompt}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied!" : "Copy AI prompt"}
            </Button>
          </div>
          <Textarea
            placeholder="SELECT … FROM games WHERE game_id <= ?1"
            className="min-h-[120px] font-mono text-xs"
            value={draft.sql}
            onChange={(e) => onChange({ ...draft, sql: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Paste the “Copy AI prompt” text into ChatGPT/Claude, describe what you
            want, then paste the SQL it gives back here.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={game == null || draft.sql.trim() === ""}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Hide preview" : "Preview"}
          </Button>
          {game == null && (
            <span className="text-xs text-muted-foreground">
              Run a history lookup first to preview.
            </span>
          )}
        </div>

        {preview && game != null && (
          <div className="rounded-md border p-3">
            {widget.kind === "stat" ? (
              <div className="max-w-[260px]">
                <StatWidget widget={widget} game={game} />
              </div>
            ) : widget.kind === "chart" ? (
              <ChartWidget widget={widget} game={game} embedded />
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ViewEditor({
  open,
  onOpenChange,
  game,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  game: number | null;
  editing: SavedView | null;
  onSaved: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([blankDraft()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seeded = useRef(false);

  // Seed the form whenever the dialog opens (from the edited view or blank).
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setError(null);
    if (editing) {
      setName(editing.name);
      const spec = parseSpec(editing.spec);
      setDrafts(spec ? draftsFromSpec(spec) : [blankDraft()]);
    } else {
      setName("");
      setDrafts([blankDraft()]);
    }
  }, [open, editing]);

  function updateDraft(uid: number, next: Draft) {
    setDrafts((ds) => ds.map((d) => (d.uid === uid ? next : d)));
  }
  function removeDraft(uid: number) {
    setDrafts((ds) => ds.filter((d) => d.uid !== uid));
  }

  async function save() {
    const usable = drafts.filter((d) => d.sql.trim() !== "");
    if (name.trim() === "") {
      setError("Give the view a name.");
      return;
    }
    if (usable.length === 0) {
      setError("Add at least one widget with a SQL query.");
      return;
    }
    const spec: DashboardSpec = {
      rows: [{ widgets: usable.map(draftToWidget) }],
    };
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateView(editing.id, name.trim(), spec);
        onSaved(editing.id);
      } else {
        const id = await saveView(name.trim(), spec);
        onSaved(id);
      }
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit view" : "New view"}</DialogTitle>
          <DialogDescription>
            Each widget is one SQL query plus a chart type. Use “Copy AI prompt”
            if you’d rather have an assistant write the SQL for you.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="view-name">View name</Label>
          <Input
            id="view-name"
            placeholder="e.g. My streak watch"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-3">
          {drafts.map((d) => (
            <WidgetEditorCard
              key={d.uid}
              draft={d}
              game={game}
              canRemove={drafts.length > 1}
              onChange={(next) => updateDraft(d.uid, next)}
              onRemove={() => removeDraft(d.uid)}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => setDrafts((ds) => [...ds, blankDraft()])}
          >
            <Plus />
            Add widget
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save view"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
