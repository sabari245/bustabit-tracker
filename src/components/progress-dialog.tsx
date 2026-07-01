import { Check, Loader2 } from "lucide-react";

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

export type ExportProgress = HistoryProgress;

export type BacktestProgress = {
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
  const indeterminate = progress.phase === "locating";
  const aggregating = progress.phase === "aggregating";
  const showBar = !indeterminate && progress.total > 0;
  const percent = showBar
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  const description = aggregating
    ? "Summarising the history from the local cache."
    : progress.phase === "analyzing"
      ? "Computing and caching the games we don't have yet."
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
          <Progress value={showBar ? percent : null} />
          <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
            {indeterminate && <Loader2 className="h-4 w-4 animate-spin" />}
            {aggregating ? (
              <span>
                {progress.current.toLocaleString()} /{" "}
                {progress.total.toLocaleString()} widgets ({percent}%)
              </span>
            ) : progress.phase === "analyzing" ? (
              <span>
                {progress.current.toLocaleString()} /{" "}
                {progress.total.toLocaleString()} games ({percent}%)
              </span>
            ) : (
              <span>{progress.current.toLocaleString()} hashes scanned…</span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ExportProgressDialog({
  open,
  progress,
}: {
  open: boolean;
  progress: ExportProgress;
}) {
  const completed = progress.phase === "completed";
  const writing = progress.phase === "writing";
  const showBar = completed || (progress.total > 0 && writing);
  const percent = completed
    ? 100
    : showBar
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  const description =
    progress.phase === "saving"
      ? "Saving the workbook to the selected XLSX file."
      : completed
        ? "The XLSX export has finished."
        : writing
          ? "Writing the cached game history into the workbook."
          : "Loading cached history and preparing the workbook.";

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {completed ? "Export complete" : "Exporting XLSX"}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <Progress value={showBar ? percent : null} />
          <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
            {completed ? (
              <Check />
            ) : (
              <Loader2 className="animate-spin" />
            )}
            {completed ? (
              <span>{progress.current.toLocaleString()} rows exported</span>
            ) : writing && progress.total > 0 ? (
              <span>
                {progress.current.toLocaleString()} /{" "}
                {progress.total.toLocaleString()} rows ({percent}%)
              </span>
            ) : progress.phase === "saving" ? (
              <span>Saving file…</span>
            ) : progress.total > 0 ? (
              <span>{progress.total.toLocaleString()} rows ready to export</span>
            ) : (
              <span>Loading cached history…</span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BacktestProgressDialog({
  open,
  progress,
}: {
  open: boolean;
  progress: BacktestProgress;
}) {
  const showBar = progress.total > 0;
  const percent = showBar
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Running backtest</DialogTitle>
          <DialogDescription>
            Replaying cached games through the selected autobet strategy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <Progress value={showBar ? percent : null} />
          <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
            <Loader2 className="animate-spin" />
            {showBar ? (
              <span>
                {progress.current.toLocaleString()} /{" "}
                {progress.total.toLocaleString()} games ({percent}%)
              </span>
            ) : (
              <span>Preparing cached games…</span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
