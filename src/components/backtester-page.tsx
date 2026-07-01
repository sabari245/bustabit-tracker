import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, Loader2, Play, Trash2 } from "lucide-react";

import {
  AutobetBacktestRunner,
  DEFAULT_BACKTEST_SCRIPT,
  bitsToSats,
  formatBits,
  parseBacktestDetail,
  type BacktestGame,
  type BacktestResult,
} from "@/lib/backtester";
import type { ChartWidgetSpec } from "@/lib/dashboard-spec";
import type { Row } from "@/lib/query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UplotChart } from "@/components/widgets/uplot-chart";

const BATCH_SIZE = 50_000;

type CacheInfo = {
  count: number;
  minGameId: number | null;
  maxGameId: number | null;
};

type BacktestSummary = {
  id: number;
  name: string;
  createdAt: string;
  startGameId: number;
  endGameId: number;
  games: number;
  finalBalance: number;
  profit: number;
  wagered: number;
  bets: number;
  wins: number;
  losses: number;
  maxDrawdown: number;
};

type BacktestDetail = BacktestSummary & {
  script: string;
  startingBalance: number;
  resultJson: string;
};

const EQUITY_CHART: ChartWidgetSpec = {
  kind: "chart",
  type: "line",
  title: "Backtest equity",
  sql: "",
  x: "game",
  yTitle: "bits",
  series: [
    { key: "profit", label: "Profit", color: "var(--chart-1)" },
    { key: "balance", label: "Balance", color: "var(--chart-2)" },
  ],
};

function formatSavedAt(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function SummaryGrid({ result }: { result: BacktestResult | BacktestDetail }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric label="Games" value={result.games.toLocaleString()} />
      <Metric label="Bets" value={result.bets.toLocaleString()} />
      <Metric label="Amount bet" value={`${formatBits(result.wagered)} bits`} />
      <Metric label="Profit" value={`${formatBits(result.profit)} bits`} />
      <Metric label="Final balance" value={`${formatBits(result.finalBalance)} bits`} />
      <Metric label="Wins" value={result.wins.toLocaleString()} />
      <Metric label="Losses" value={result.losses.toLocaleString()} />
      <Metric label="Max drawdown" value={`${formatBits(result.maxDrawdown)} bits`} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-muted p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function EquityChart({ resultJson }: { resultJson: string }) {
  const detail = useMemo(() => parseBacktestDetail(resultJson), [resultJson]);
  const rows: Row[] = detail.balanceSeries.map((p) => ({
    game: p.gameId,
    balance: p.balance / 100,
    profit: p.profit / 100,
  }));

  return (
    <div className="flex flex-col gap-4">
      <UplotChart widget={EQUITY_CHART} data={rows} x="game" series={EQUITY_CHART.series ?? []} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Highest money"
          value={`${formatBits(detail.peak.profit)} bits at #${detail.peak.gameId.toLocaleString()}`}
        />
        <Metric
          label="Lowest money"
          value={`${formatBits(detail.trough.profit)} bits at #${detail.trough.gameId.toLocaleString()}`}
        />
        <Metric
          label="Worst drawdown point"
          value={`${formatBits(detail.maxDrawdownAt.profit)} bits at #${detail.maxDrawdownAt.gameId.toLocaleString()}`}
        />
      </div>
    </div>
  );
}

function Logs({ resultJson }: { resultJson: string }) {
  const detail = useMemo(() => parseBacktestDetail(resultJson), [resultJson]);
  return (
    <div className="flex flex-col gap-2">
      {detail.stopped && detail.stopReason && (
        <p className="text-sm text-muted-foreground">Stopped: {detail.stopReason}</p>
      )}
      <pre className="max-h-80 overflow-auto rounded-2xl bg-muted p-3 text-xs">
        {detail.logs.join("\n") || "No script logs."}
      </pre>
    </div>
  );
}

export function BacktesterPage() {
  const [name, setName] = useState("Backtest");
  const [script, setScript] = useState(DEFAULT_BACKTEST_SCRIPT);
  const [startingBits, setStartingBits] = useState("10000");
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);
  const [rows, setRows] = useState<BacktestSummary[]>([]);
  const [selected, setSelected] = useState<BacktestDetail | null>(null);
  const [latest, setLatest] = useState<BacktestResult | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function refreshBacktests() {
    const next = await invoke<BacktestSummary[]>("list_backtests");
    setRows(next);
  }

  async function refreshCacheInfo() {
    const info = await invoke<CacheInfo>("load_backtest_cache_info");
    setCacheInfo(info);
    return info;
  }

  useEffect(() => {
    async function boot() {
      await Promise.all([refreshCacheInfo(), refreshBacktests()]);
    }
    boot().catch((e) => setError(String(e)));
  }, []);

  async function run() {
    setError(null);
    setLatest(null);
    setSelected(null);
    setProgress(0);
    setRunning(true);
    try {
      const info = await refreshCacheInfo();
      if (info.count === 0) {
        throw new Error("No cached games yet. Compute a tracker history first.");
      }

      const runner = new AutobetBacktestRunner(
        name.trim() || "Backtest",
        script,
        bitsToSats(Number(startingBits) || 0),
        info.count,
      );

      let afterGameId = 0;
      let loaded = 0;
      for (;;) {
        const batch = await invoke<BacktestGame[]>("load_backtest_games", {
          afterGameId,
          limit: BATCH_SIZE,
        });
        if (batch.length === 0) break;
        runner.process(batch);
        loaded += batch.length;
        afterGameId = batch[batch.length - 1].gameId;
        setProgress(Math.min(loaded, info.count));
        if (runner.isStopped()) break;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      const result = runner.result();
      const id = await invoke<number>("save_backtest", { input: result });
      setLatest(result);
      await refreshBacktests();
      await loadBacktest(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  async function loadBacktest(id: number) {
    setError(null);
    const detail = await invoke<BacktestDetail | null>("get_backtest", { id });
    setSelected(detail);
  }

  async function deleteBacktest() {
    if (deleteId == null) return;
    setError(null);
    try {
      await invoke<void>("delete_backtest", { id: deleteId });
      if (selected?.id === deleteId) setSelected(null);
      setDeleteId(null);
      await refreshBacktests();
    } catch (e) {
      setError(String(e));
    }
  }

  const cacheText =
    cacheInfo && cacheInfo.count > 0 && cacheInfo.minGameId != null && cacheInfo.maxGameId != null
      ? `${cacheInfo.count.toLocaleString()} cached games, #${cacheInfo.minGameId.toLocaleString()} to #${cacheInfo.maxGameId.toLocaleString()}`
      : "No cached games yet. Compute a tracker history first.";
  const progressText =
    cacheInfo && cacheInfo.count > 0
      ? `${progress.toLocaleString()} / ${cacheInfo.count.toLocaleString()} games`
      : "";

  return (
    <main className="flex flex-1 flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Autobet Backtester</CardTitle>
          <CardDescription>
            Runs the strategy over every cached game in chronological order.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
          >
            <div className="grid gap-4 lg:grid-cols-[1fr_220px_160px]">
              <div className="flex flex-col gap-2">
                <Label htmlFor="backtest-name">Name</Label>
                <Input
                  id="backtest-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="starting-balance">Starting balance (bits)</Label>
                <Input
                  id="starting-balance"
                  inputMode="decimal"
                  value={startingBits}
                  onChange={(e) => setStartingBits(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" className="w-full" disabled={running}>
                  {running ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Play data-icon="inline-start" />
                  )}
                  {running ? "Running..." : "Run all"}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="strategy">Strategy</Label>
              <Textarea
                id="strategy"
                className="max-h-[32rem] min-h-96 overflow-y-auto font-mono"
                value={script}
                onChange={(e) => setScript(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              <p>{cacheText}</p>
              {running && <p>{progressText}</p>}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>
        </CardContent>
      </Card>

      {latest && (
        <Card>
          <CardHeader>
            <CardTitle>Latest Run</CardTitle>
            <CardDescription>
              Auto-saved after games #{latest.startGameId.toLocaleString()} to #
              {latest.endGameId.toLocaleString()}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SummaryGrid result={latest} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Backtests</CardTitle>
          <CardDescription>Click a run to inspect its equity curve and logs.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Games</TableHead>
                <TableHead>Bets</TableHead>
                <TableHead>Amount bet</TableHead>
                <TableHead>Profit</TableHead>
                <TableHead>Drawdown</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    No backtests yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell>{row.games.toLocaleString()}</TableCell>
                    <TableCell>{row.bets.toLocaleString()}</TableCell>
                    <TableCell>{formatBits(row.wagered)} bits</TableCell>
                    <TableCell>{formatBits(row.profit)} bits</TableCell>
                    <TableCell>{formatBits(row.maxDrawdown)} bits</TableCell>
                    <TableCell>{formatSavedAt(row.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => loadBacktest(row.id)}>
                          <Eye data-icon="inline-start" />
                          View
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setDeleteId(row.id)}
                        >
                          <Trash2 data-icon="inline-start" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>{selected.name}</CardTitle>
            <CardDescription>
              Games #{selected.startGameId.toLocaleString()} to #
              {selected.endGameId.toLocaleString()}, saved {formatSavedAt(selected.createdAt)}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="graph">
              <TabsList>
                <TabsTrigger value="graph">Graph</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="script">Script</TabsTrigger>
              </TabsList>
              <TabsContent value="graph">
                <EquityChart resultJson={selected.resultJson} />
              </TabsContent>
              <TabsContent value="summary">
                <SummaryGrid result={selected} />
              </TabsContent>
              <TabsContent value="logs">
                <Logs resultJson={selected.resultJson} />
              </TabsContent>
              <TabsContent value="script">
                <Textarea
                  className="max-h-[32rem] min-h-96 overflow-y-auto font-mono"
                  value={selected.script}
                  readOnly
                  spellCheck={false}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={deleteId != null}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backtest?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the run from the local database. Cached game history is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteBacktest}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
