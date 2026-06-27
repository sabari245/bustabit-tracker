import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { RedStreaks } from "@/components/red-streaks";

export type HistoryStats = {
  from_game: number;
  to_game: number;
  total_games: number;
  green_count: number;
  red_count: number;
  instant_busts: number;
  mean_bust: number;
  max_bust: number;
  max_bust_game: number;
  longest_green_streak: number;
  longest_red_streak: number;
  current_streak_len: number;
  current_streak_green: boolean;
  distribution: { label: string; count: number }[];
  streaks: { label: string; green: number; red: number }[];
  red_streak_hist: { length: number; count: number }[];
};

const pct = (n: number, total: number) =>
  total === 0 ? "0%" : `${((100 * n) / total).toFixed(1)}%`;

const num = (n: number) => n.toLocaleString();

function StatCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint && (
        <CardContent className="pt-0 text-xs text-muted-foreground">
          {hint}
        </CardContent>
      )}
    </Card>
  );
}

const distConfig = {
  count: { label: "Games", color: "var(--chart-1)" },
} satisfies ChartConfig;

const streakConfig = {
  green: { label: "Green runs", color: "var(--chart-2)" },
  red: { label: "Red runs", color: "var(--destructive)" },
} satisfies ChartConfig;

export function Dashboard({ stats }: { stats: HistoryStats }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          title="Games analysed"
          value={num(stats.total_games)}
          hint={`#${num(stats.to_game)} → #${num(stats.from_game)}`}
        />
        <StatCard
          title="Max bust"
          value={`${stats.max_bust.toFixed(2)}×`}
          hint={`at game #${num(stats.max_bust_game)}`}
        />
        <StatCard
          title="Green rate"
          value={pct(stats.green_count, stats.total_games)}
          hint={`≥2× · ${num(stats.green_count)} games`}
        />
        <StatCard
          title="Instant busts"
          value={pct(stats.instant_busts, stats.total_games)}
          hint={`1.00× · ${num(stats.instant_busts)} games`}
        />
        <StatCard
          title="Longest green streak"
          value={num(stats.longest_green_streak)}
          hint="consecutive ≥2×"
        />
        <StatCard
          title="Longest red streak"
          value={num(stats.longest_red_streak)}
          hint="consecutive <2×"
        />
        <StatCard
          title="Current streak"
          value={`${num(stats.current_streak_len)} ${
            stats.current_streak_green ? "green" : "red"
          }`}
          hint="at the entered game"
        />
        <StatCard
          title="Mean bust"
          value={`${stats.mean_bust.toFixed(2)}×`}
          hint="average multiplier"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Bust distribution</CardTitle>
            <CardDescription>How often each multiplier range hits</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={distConfig} className="h-[260px] w-full">
              <BarChart data={stats.distribution}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={48} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Streak lengths</CardTitle>
            <CardDescription>
              Number of green vs red runs by length
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={streakConfig} className="h-[260px] w-full">
              <BarChart data={stats.streaks}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={48} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="green" fill="var(--color-green)" radius={4} />
                <Bar dataKey="red" fill="var(--color-red)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <RedStreaks hist={stats.red_streak_hist} />
    </div>
  );
}
