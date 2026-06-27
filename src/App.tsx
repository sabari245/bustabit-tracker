import { useState } from "react";
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
import { Dashboard, type HistoryStats } from "@/components/dashboard";
import {
  ProgressDialog,
  type HistoryProgress,
} from "@/components/progress-dialog";

function App() {
  const [hash, setHash] = useState("");
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<HistoryProgress>({
    phase: "locating",
    current: 0,
    total: 0,
  });

  async function computeHistory() {
    setError(null);
    setStats(null);
    setProgress({ phase: "locating", current: 0, total: 0 });
    setLoading(true);
    const unlisten = await listen<HistoryProgress>(
      "history-progress",
      (e) => setProgress(e.payload),
    );
    try {
      const result = await invoke<HistoryStats>("compute_history", {
        gameHash: hash,
      });
      setStats(result);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setLoading(false);
    }
  }

  const canSubmit = hash.trim().length > 0;

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
                  {loading && <Loader2 className="animate-spin" />}
                  {loading ? "Computing…" : "Compute history"}
                </Button>
              </form>
              {error && (
                <p className="mt-3 text-sm text-destructive">{error}</p>
              )}
            </CardContent>
          </Card>

          {stats && <Dashboard stats={stats} />}
        </main>
      </div>
    </ThemeProvider>
  );
}

export default App;
