import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Navbar } from "@/components/navbar";
import { ThemeProvider } from "@/components/theme-provider";
import { DashboardSection } from "@/components/dashboard-section";
import {
  ProgressDialog,
  type HistoryProgress,
} from "@/components/progress-dialog";
import type { DashboardSpec } from "@/lib/dashboard-spec";
import {
  extractQueries,
  loadLayout,
  migrateLayout,
  saveLayout,
  seedLayout,
} from "@/lib/layout";
import type { Row } from "@/lib/query";

/** Range bounds + pre-computed dashboard query results returned by `compute_history`. */
type Prepared = {
  from_game: number;
  to_game: number;
  total_games: number;
  results: Record<string, Row[]>;
};

type HistoryState = {
  last_hash: string;
  last_game_id: number;
  last_computed_at: string;
  highest_hash: string;
  highest_game_id: number;
  highest_computed_at: string;
};

function formatSavedAt(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function App() {
  const [hash, setHash] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [historyState, setHistoryState] = useState<HistoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState<DashboardSpec | null>(null);
  const [progress, setProgress] = useState<HistoryProgress>({
    phase: "locating",
    current: 0,
    total: 0,
  });

  // Load the persisted dashboard layout once; seed it from the built-in
  // dashboard on first run, migrate older saved layouts, then restore the
  // highest analysed hash if one was saved.
  useEffect(() => {
    let active = true;
    async function boot() {
      const stored = await loadLayout();
      let nextLayout: DashboardSpec;
      if (stored) {
        const migrated = migrateLayout(stored);
        nextLayout = migrated.spec;
        if (migrated.changed) saveLayout(nextLayout);
      } else {
        nextLayout = seedLayout();
        saveLayout(nextLayout);
      }

      if (!active) return;
      setLayout(nextLayout);

      const state = await invoke<HistoryState | null>("load_history_state");
      if (!active || !state) return;
      setHistoryState(state);
      setHash(state.highest_hash);
      await prepareHistory(state.highest_hash, nextLayout, null);
    }
    boot().catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, []);

  function updateLayout(spec: DashboardSpec) {
    setLayout(spec);
    saveLayout(spec);
  }

  async function prepareHistory(
    gameHash: string,
    spec: DashboardSpec,
    computedAt: string | null,
  ) {
    setError(null);
    setPrepared(null);
    setProgress({ phase: "locating", current: 0, total: 0 });
    setLoading(true);
    const unlisten = await listen<HistoryProgress>(
      "history-progress",
      (e) => setProgress(e.payload),
    );
    try {
      const result = await invoke<Prepared>("compute_history", {
        gameHash,
        queries: extractQueries(spec),
        computedAt,
      });
      setPrepared(result);
      if (computedAt) {
        const next: HistoryState = {
          last_hash: gameHash,
          last_game_id: result.from_game,
          last_computed_at: computedAt,
          highest_hash:
            historyState == null || result.from_game >= historyState.highest_game_id
              ? gameHash
              : historyState.highest_hash,
          highest_game_id: Math.max(
            result.from_game,
            historyState?.highest_game_id ?? result.from_game,
          ),
          highest_computed_at:
            historyState == null || result.from_game >= historyState.highest_game_id
              ? computedAt
              : historyState.highest_computed_at,
        };
        setHistoryState(next);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setLoading(false);
    }
  }

  async function computeHistory() {
    if (!layout) return;
    await prepareHistory(hash, layout, new Date().toISOString());
  }

  const canSubmit = hash.trim().length > 0 && layout != null;

  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <ProgressDialog open={loading} progress={progress} />
      <div className="flex min-h-screen flex-col">
        <Navbar />
        <main className="flex flex-1 flex-col gap-4 p-4">
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Bust Calculator</CardTitle>
              <CardDescription>
                Enter a classic-era game hash. Its game number is detected
                automatically and the full history is computed back to the start
                of the classic era.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-4 sm:flex-row sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  computeHistory();
                }}
              >
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="hash">Game hash</Label>
                  <Input
                    id="hash"
                    placeholder="64-character hex hash"
                    value={hash}
                    onChange={(e) => setHash(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={!canSubmit || loading}>
                  {loading && (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  )}
                  {loading ? "Computing…" : "Compute history"}
                </Button>
              </form>
              {error && (
                <p className="mt-3 text-sm text-destructive">{error}</p>
              )}
              {historyState && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Last analysed game #{historyState.last_game_id.toLocaleString()}{" "}
                  at {formatSavedAt(historyState.last_computed_at)}. Highest saved
                  game #{historyState.highest_game_id.toLocaleString()}.
                </p>
              )}
            </CardContent>
          </Card>

          {prepared != null && layout != null && (
            <DashboardSection
              game={prepared.from_game}
              layout={layout}
              precomputed={prepared.results}
              onLayoutChange={updateLayout}
            />
          )}
        </main>
      </div>
    </ThemeProvider>
  );
}

export default App;
