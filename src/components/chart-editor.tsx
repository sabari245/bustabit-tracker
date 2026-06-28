import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import type { Widget } from "@/lib/dashboard-spec";
import { newWidgetId } from "@/lib/layout";

type DraftType = "stat" | "bar" | "line" | "area";

const TYPE_LABELS: Record<DraftType, string> = {
  stat: "Stat (single value)",
  bar: "Bar chart",
  line: "Line chart",
  area: "Area chart",
};

function widgetToDraft(w: Widget): { title: string; type: DraftType; sql: string } {
  if (w.kind === "stat") return { title: w.title, type: "stat", sql: w.sql };
  if (w.kind === "chart") return { title: w.title, type: w.type, sql: w.sql };
  return { title: w.title, type: "bar", sql: "" };
}

function buildWidget(
  id: string,
  title: string,
  type: DraftType,
  sql: string,
): Widget {
  const t = title.trim() || "Untitled";
  if (type === "stat") return { kind: "stat", id, title: t, sql };
  return { kind: "chart", id, type, title: t, sql };
}

/** Dialog to author or edit a single dashboard chart/card. */
export function ChartEditor({
  open,
  onOpenChange,
  game,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  game: number | null;
  editing: Widget | null;
  onSave: (widget: Widget) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DraftType>("stat");
  const [sql, setSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const seeded = useRef(false);

  // Seed the form whenever the dialog opens (from the edited widget or blank).
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setError(null);
    setPreview(false);
    if (editing) {
      const d = widgetToDraft(editing);
      setTitle(d.title);
      setType(d.type);
      setSql(d.sql);
    } else {
      setTitle("");
      setType("stat");
      setSql("");
    }
  }, [open, editing]);

  async function copyPrompt() {
    await navigator.clipboard.writeText(AI_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function save() {
    if (sql.trim() === "") {
      setError("Add a SQL query for this chart.");
      return;
    }
    const id = editing?.id ?? newWidgetId();
    onSave(buildWidget(id, title, type, sql));
    onOpenChange(false);
  }

  const previewWidget = buildWidget("preview", title, type, sql);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit chart" : "New chart"}</DialogTitle>
          <DialogDescription>
            One SQL query plus a chart type. Use “Copy AI prompt” if you’d rather
            have an assistant write the SQL for you.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            placeholder="Chart title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Select value={type} onValueChange={(v) => setType(v as DraftType)}>
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
        </div>

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
            value={sql}
            onChange={(e) => setSql(e.target.value)}
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
            disabled={game == null || sql.trim() === ""}
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
            {previewWidget.kind === "stat" ? (
              <div className="max-w-[260px]">
                <StatWidget widget={previewWidget} game={game} />
              </div>
            ) : previewWidget.kind === "chart" ? (
              <ChartWidget widget={previewWidget} game={game} embedded />
            ) : null}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>{editing ? "Save changes" : "Add chart"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
