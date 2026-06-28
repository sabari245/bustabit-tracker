import { useEffect, useState, type ReactElement } from "react";
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
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { runQuery, type Row } from "@/lib/query";
import {
  CHART_PALETTE,
  type ChartWidgetSpec,
  type Series,
} from "@/lib/dashboard-spec";

/**
 * Resolve the x column and series for a chart. Explicit spec values win;
 * otherwise we derive them from the result columns so user-authored widgets
 * only need to supply SQL: first column = category/x, numeric columns = series.
 */
function resolveAxes(
  widget: ChartWidgetSpec,
  data: Row[],
): { x: string; series: Series[] } {
  const cols = data.length > 0 ? Object.keys(data[0]) : [];
  const x = widget.x ?? cols[0] ?? "x";
  if (widget.series && widget.series.length > 0) {
    return { x, series: widget.series };
  }
  const numeric = cols.filter(
    (c) => c !== x && data.some((r) => typeof r[c] === "number"),
  );
  const series = numeric.map((c, i) => ({
    key: c,
    label: c,
    color: CHART_PALETTE[i % CHART_PALETTE.length],
  }));
  return { x, series };
}

function renderChart(
  widget: ChartWidgetSpec,
  data: Row[],
  x: string,
  series: Series[],
): ReactElement {
  const showLegend = series.length > 1;
  const yProps = {
    tickLine: false,
    axisLine: false,
    width: 48,
    ...(widget.yUnit ? { unit: widget.yUnit } : {}),
    ...(widget.yDomain ? { domain: widget.yDomain } : {}),
  };

  if (widget.type === "bar") {
    return (
      <BarChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x} tickLine={false} axisLine={false} />
        <YAxis {...yProps} />
        <ChartTooltip content={<ChartTooltipContent labelKey={x} />} />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={4} />
        ))}
      </BarChart>
    );
  }

  if (widget.type === "area") {
    return (
      <AreaChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x} tickLine={false} axisLine={false} />
        <YAxis {...yProps} />
        <ChartTooltip content={<ChartTooltipContent labelKey={x} />} />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            fill={`var(--color-${s.key})`}
            fillOpacity={0.2}
          />
        ))}
      </AreaChart>
    );
  }

  return (
    <LineChart data={data}>
      <CartesianGrid vertical={false} />
      <XAxis dataKey={x} tickLine={false} axisLine={false} />
      <YAxis {...yProps} />
      <ChartTooltip content={<ChartTooltipContent labelKey={x} />} />
      {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      {widget.refLine != null && (
        <ReferenceLine
          y={widget.refLine}
          strokeDasharray="4 4"
          stroke="var(--muted-foreground)"
        />
      )}
      {series.map((s) => (
        <Line
          key={s.key}
          dataKey={s.key}
          type="monotone"
          stroke={`var(--color-${s.key})`}
          dot={false}
          strokeWidth={2}
        />
      ))}
    </LineChart>
  );
}

export function ChartWidget({
  widget,
  game,
  embedded = false,
  precomputed,
}: {
  widget: ChartWidgetSpec;
  game: number;
  embedded?: boolean;
  precomputed?: Row[];
}) {
  const [data, setData] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (precomputed) {
      setData(precomputed);
      setError(null);
      return;
    }
    let active = true;
    setData(null);
    setError(null);
    runQuery(widget.sql, [game])
      .then((rows) => active && setData(rows))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [widget.sql, game, precomputed]);

  const { x, series } = resolveAxes(widget, data ?? []);
  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }]),
  );

  const body = error ? (
    <p className="text-sm text-destructive">{error}</p>
  ) : !data ? (
    <Skeleton className="h-[300px] w-full" />
  ) : data.length === 0 || series.length === 0 ? (
    <p className="text-sm text-muted-foreground">No data to plot.</p>
  ) : (
    <ChartContainer config={config} className="h-[300px] w-full">
      {renderChart(widget, data, x, series)}
    </ChartContainer>
  );

  if (embedded) {
    return (
      <>
        {widget.note && (
          <p className="mb-2 text-sm text-muted-foreground">{widget.note}</p>
        )}
        {body}
      </>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{widget.title}</CardTitle>
        {widget.description && (
          <CardDescription>{widget.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
