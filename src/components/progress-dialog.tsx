import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

export type HistoryProgress = {
  phase: string;
  current: number;
  total: number;
};

export function ProgressDialog({
  open,
  progress,
}: {
  open: boolean;
  progress: HistoryProgress;
}) {
  const analyzing = progress.phase === "analyzing" && progress.total > 0;
  const aggregating = progress.phase === "aggregating";
  const percent = analyzing
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  const description = analyzing
    ? "Computing and caching the games we don't have yet."
    : aggregating
      ? "Summarising the history from the local cache."
      : "Locating the game on the chain and verifying it's genuine.";

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Computing history</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <Progress value={analyzing ? percent : null} />
          <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
            {!analyzing && <Loader2 className="h-4 w-4 animate-spin" />}
            {analyzing ? (
              <span>
                {progress.current.toLocaleString()} /{" "}
                {progress.total.toLocaleString()} games ({percent}%)
              </span>
            ) : aggregating ? (
              <span>Crunching the numbers…</span>
            ) : (
              <span>{progress.current.toLocaleString()} hashes scanned…</span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
