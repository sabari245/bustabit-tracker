import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { StatWidget } from "@/components/widgets/stat-widget";
import { ChartWidget } from "@/components/widgets/chart-widget";
import { AI_PROMPT, chatGptUrl } from "@/lib/ai-prompt";
import type { Widget } from "@/lib/dashboard-spec";
import type { Row } from "@/lib/query";
import { runQuery } from "@/lib/query";
import { newWidgetId } from "@/lib/layout";
import {
  buildWidget,
  compatibleTypes,
  parseWidgetJson,
  TYPE_LABELS,
  widgetToJson,
  type DraftType,
} from "@/lib/widget-spec";

/** Dialog to author or edit a single dashboard widget from pasted assistant JSON. */
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
  const [jsonText, setJsonText] = useState("");
  const [selType, setSelType] = useState<DraftType | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const seeded = useRef(false);

  const parsed = useMemo(() => parseWidgetJson(jsonText), [jsonText]);
  const draft = parsed.draft;

  // Render types the result actually supports. Without a history lookup we can't
  // run the query, so we fall back to the assistant's suggested type alone.
  const options = useMemo<DraftType[]>(
    () => (rows ? compatibleTypes(rows) : draft ? [draft.type] : []),
    [rows, draft],
  );

  // Seed the box whenever the dialog opens (from the edited widget or blank).
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    setError(null);
    setRunError(null);
    setRows(null);
    setSelType(null);
    setJsonText(editing ? widgetToJson(editing) : "");
  }, [open, editing]);

  // Run the query once per (valid JSON, game) so we can detect types and preview.
  useEffect(() => {
    if (!open || !draft || game == null) {
      setRows(null);
      setRunError(null);
      return;
    }
    let active = true;
    setRunError(null);
    runQuery(draft.sql, [game])
      .then((r) => active && (setRows(r), setRunError(null)))
      .catch((e) => active && (setRows(null), setRunError(String(e))));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.sql, game]);

  // Keep the selected type valid: prefer the current pick, else the assistant's
  // suggestion, else the first compatible option.
  useEffect(() => {
    if (options.length === 0) {
      setSelType(null);
      return;
    }
    setSelType((prev) =>
      prev && options.includes(prev)
        ? prev
        : draft && options.includes(draft.type)
          ? draft.type
          : options[0],
    );
  }, [options, draft]);

  async function copyPrompt() {
    await navigator.clipboard.writeText(AI_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function save() {
    if (!draft) {
      setError(parsed.error ?? "Paste the widget JSON first.");
      return;
    }
    if (!selType) {
      setError("Pick how to display it.");
      return;
    }
    const id = editing?.id ?? newWidgetId();
    onSave(buildWidget(id, draft, selType));
    onOpenChange(false);
  }

  const previewWidget =
    draft && selType ? buildWidget("preview", draft, selType) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit widget" : "New widget"}</DialogTitle>
          <DialogDescription>
            Let an assistant write it for you: copy the prompt (or open it
            straight in ChatGPT), describe what you want, then paste the JSON it
            replies with below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copyPrompt}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied!" : "Copy prompt"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openUrl(chatGptUrl())}
          >
            <ExternalLink />
            Open in ChatGPT
          </Button>
          <span className="text-xs text-muted-foreground">
            Opens a new chat with the prompt already filled in.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Paste widget JSON</Label>
          <Textarea
            placeholder={'{\n  "type": "bar",\n  "title": "…",\n  "sql": "SELECT … FROM games WHERE game_id <= ?1"\n}'}
            className="min-h-[140px] font-mono text-xs"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          {jsonText.trim() !== "" && parsed.error && (
            <p className="text-xs text-destructive">{parsed.error}</p>
          )}
        </div>

        {draft && (
          <div className="flex flex-col gap-2">
            <Label>Display as</Label>
            {options.length > 0 ? (
              <ToggleGroup
                type="single"
                variant="outline"
                value={selType ?? ""}
                onValueChange={(v) => v && setSelType(v as DraftType)}
                className="justify-start"
              >
                {options.map((t) => (
                  <ToggleGroupItem key={t} value={t} className="px-3">
                    {TYPE_LABELS[t]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              <p className="text-xs text-muted-foreground">
                {game == null
                  ? "Run a history lookup first to detect the available styles."
                  : "Waiting for the query to run…"}
              </p>
            )}
            {rows != null && (
              <p className="text-xs text-muted-foreground">
                Auto-detected from the query result
                {game != null && ` · ${rows.length} row${rows.length === 1 ? "" : "s"}`}.
              </p>
            )}
          </div>
        )}

        {runError && <p className="text-sm text-destructive">{runError}</p>}

        {previewWidget && game != null && rows != null && !runError && (
          <div className="flex flex-col gap-2">
            <Label>Preview</Label>
            <div className="rounded-md border p-3">
              {previewWidget.kind === "stat" ? (
                <div className="max-w-[260px]">
                  <StatWidget
                    widget={previewWidget}
                    game={game}
                    precomputed={rows}
                  />
                </div>
              ) : previewWidget.kind === "chart" ? (
                <ChartWidget
                  widget={previewWidget}
                  game={game}
                  embedded
                  precomputed={rows}
                />
              ) : null}
            </div>
          </div>
        )}

        {draft && game == null && (
          <p className="text-xs text-muted-foreground">
            Run a history lookup to see a live preview before saving.
          </p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!draft}>
            {editing ? "Save changes" : "Add widget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
