import { useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UplotChart } from "@/components/widgets/uplot-chart";
import { isNumericCell, runQuery, type Row } from "@/lib/query";
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
    (c) => c !== x && data.some((r) => isNumericCell(r[c])),
  );
  const nullable = cols.filter(
    (c) => c !== x && data.every((r) => r[c] == null),
  );
  const autoSeries = numeric.length > 0 ? numeric : nullable;
  const series = autoSeries.map((c, i) => ({
    key: c,
    label: c,
    color: CHART_PALETTE[i % CHART_PALETTE.length],
  }));
  return { x, series };
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

  const body = error ? (
    <p className="text-sm text-destructive">{error}</p>
  ) : !data ? (
    <Skeleton className="h-[300px] w-full" />
  ) : data.length === 0 || series.length === 0 ? (
    <p className="text-sm text-muted-foreground">No data to plot.</p>
  ) : (
    <UplotChart widget={widget} data={data} x={x} series={series} />
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
