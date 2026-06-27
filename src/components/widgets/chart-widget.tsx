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
import type { ChartWidgetSpec } from "@/lib/dashboard-spec";

function renderChart(widget: ChartWidgetSpec, data: Row[]): ReactElement {
  const showLegend = widget.series.length > 1;
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
        <XAxis dataKey={widget.x} tickLine={false} axisLine={false} />
        <YAxis {...yProps} />
        <ChartTooltip content={<ChartTooltipContent labelKey={widget.x} />} />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {widget.series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={4} />
        ))}
      </BarChart>
    );
  }

  if (widget.type === "area") {
    return (
      <AreaChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={widget.x} tickLine={false} axisLine={false} />
        <YAxis {...yProps} />
        <ChartTooltip content={<ChartTooltipContent labelKey={widget.x} />} />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {widget.series.map((s) => (
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
      <XAxis dataKey={widget.x} tickLine={false} axisLine={false} />
      <YAxis {...yProps} />
      <ChartTooltip content={<ChartTooltipContent labelKey={widget.x} />} />
      {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      {widget.refLine != null && (
        <ReferenceLine
          y={widget.refLine}
          strokeDasharray="4 4"
          stroke="var(--muted-foreground)"
        />
      )}
      {widget.series.map((s) => (
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
}: {
  widget: ChartWidgetSpec;
  game: number;
  embedded?: boolean;
}) {
  const [data, setData] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    runQuery(widget.sql, [game])
      .then((rows) => active && setData(rows))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [widget.sql, game]);

  const config: ChartConfig = Object.fromEntries(
    widget.series.map((s) => [s.key, { label: s.label, color: s.color }]),
  );

  const body = error ? (
    <p className="text-sm text-destructive">{error}</p>
  ) : !data ? (
    <Skeleton className="h-[300px] w-full" />
  ) : (
    <ChartContainer config={config} className="h-[300px] w-full">
      {renderChart(widget, data)}
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
