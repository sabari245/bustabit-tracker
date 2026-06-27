import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export type LenCount = { length: number; count: number };

const freqConfig = {
  count: { label: "Red streaks", color: "var(--destructive)" },
} satisfies ChartConfig;

const survivalConfig = {
  pct: { label: "Reached ≥ length", color: "var(--destructive)" },
} satisfies ChartConfig;

const contConfig = {
  pct: { label: "Continued to next", color: "var(--destructive)" },
} satisfies ChartConfig;

export function RedStreaks({ hist }: { hist: LenCount[] }) {
  if (hist.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Red streaks</CardTitle>
          <CardDescription>No red streaks found.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const total = hist.reduce((s, h) => s + h.count, 0);

  // suffix[i] = number of red streaks whose length was >= (i + 1).
  const suffix: number[] = new Array(hist.length);
  let acc = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    acc += hist[i].count;
    suffix[i] = acc;
  }

  // Survival: of all red streaks, what fraction reached at least this length.
  const survival = hist.map((h, i) => ({
    length: h.length,
    pct: +((100 * suffix[i]) / total).toFixed(2),
    atLeast: suffix[i],
  }));

  // Continuation: given a streak already reached this length, how often it
  // extended by one more red. For independent rounds this is ~flat at P(red).
  const continuation = hist.map((h, i) => ({
    length: h.length,
    pct: +((100 * (suffix[i + 1] ?? 0)) / suffix[i]).toFixed(2),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Red streaks</CardTitle>
        <CardDescription>
          Runs of consecutive games below 2× ({total.toLocaleString()} runs)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="frequency">
          <TabsList>
            <TabsTrigger value="frequency">Frequency</TabsTrigger>
            <TabsTrigger value="survival">Survival</TabsTrigger>
            <TabsTrigger value="continuation">Continuation</TabsTrigger>
          </TabsList>

          <TabsContent value="frequency">
            <p className="mb-2 text-sm text-muted-foreground">
              How many red streaks were exactly this many games long.
            </p>
            <ChartContainer config={freqConfig} className="h-[300px] w-full">
              <BarChart data={hist}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="length"
                  tickLine={false}
                  axisLine={false}
                  label={{ value: "streak length", position: "insideBottom", offset: -2 }}
                />
                <YAxis tickLine={false} axisLine={false} width={56} />
                <ChartTooltip
                  content={<ChartTooltipContent labelKey="length" />}
                />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} />
              </BarChart>
            </ChartContainer>
          </TabsContent>

          <TabsContent value="survival">
            <p className="mb-2 text-sm text-muted-foreground">
              Of all red streaks, the % that reached at least this length.
            </p>
            <ChartContainer config={survivalConfig} className="h-[300px] w-full">
              <AreaChart data={survival}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="length" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  domain={[0, 100]}
                  unit="%"
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  dataKey="pct"
                  type="monotone"
                  stroke="var(--color-pct)"
                  fill="var(--color-pct)"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ChartContainer>
          </TabsContent>

          <TabsContent value="continuation">
            <p className="mb-2 text-sm text-muted-foreground">
              Given a streak already reached length N, how often the next game
              was also red. Roughly flat ≈ the base red rate if rounds are
              independent (no “due for a green”).
            </p>
            <ChartContainer config={contConfig} className="h-[300px] w-full">
              <LineChart data={continuation}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="length" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  domain={[0, 100]}
                  unit="%"
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ReferenceLine y={50} strokeDasharray="4 4" stroke="var(--muted-foreground)" />
                <Line
                  dataKey="pct"
                  type="monotone"
                  stroke="var(--color-pct)"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ChartContainer>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
