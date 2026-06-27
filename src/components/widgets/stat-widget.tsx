import { useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { runQuery, type Cell, type Row } from "@/lib/query";
import type { StatWidgetSpec } from "@/lib/dashboard-spec";

function formatValue(v: Cell, format?: string, unit?: string): string {
  if (v == null) return "—";
  if (format === "mult") return `${Number(v).toFixed(2)}×`;
  if (format === "pct") return `${Number(v).toFixed(1)}%`;
  if (format === "int") return Number(v).toLocaleString();
  return `${v}${unit ?? ""}`;
}

function fillHint(template: string, row: Row): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = row[key];
    if (v == null) return "—";
    return typeof v === "number" ? v.toLocaleString() : String(v);
  });
}

export function StatWidget({
  widget,
  game,
}: {
  widget: StatWidgetSpec;
  game: number;
}) {
  const [row, setRow] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRow(null);
    setError(null);
    runQuery(widget.sql, [game])
      .then((rows) => active && setRow(rows[0] ?? {}))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [widget.sql, game]);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardDescription>{widget.title}</CardDescription>
        {row ? (
          <CardTitle className="text-2xl tabular-nums">
            {formatValue(row.value, widget.format, widget.unit)}
          </CardTitle>
        ) : (
          <Skeleton className="h-8 w-24" />
        )}
      </CardHeader>
      {(widget.hint || error) && (
        <CardContent className="pt-0 text-xs text-muted-foreground">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : row && widget.hint ? (
            fillHint(widget.hint, row)
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}
