import { StatWidget } from "./widgets/stat-widget";
import { ChartWidget } from "./widgets/chart-widget";
import { TabsWidget } from "./widgets/tabs-widget";
import type { DashboardSpec, Widget, WidgetSize } from "@/lib/dashboard-spec";
import type { Row } from "@/lib/query";
import { widgetId } from "@/lib/views";

// Flex-basis per size, so widgets fold gracefully as the window narrows. The
// `0.5rem`/`0.75rem` subtractions account for the `gap-4` (1rem) between items.
const SIZE_CLASS: Record<WidgetSize, string> = {
  stat: "grow basis-[calc(50%-0.5rem)] md:basis-[calc(25%-0.75rem)] min-w-[150px]",
  half: "grow basis-full md:basis-[calc(50%-0.5rem)] min-w-[280px]",
  full: "basis-full",
};

function sizeOf(widget: Widget): WidgetSize {
  if (widget.size) return widget.size;
  if (widget.kind === "stat") return "stat";
  if (widget.kind === "tabs") return "full";
  return "half";
}

function WidgetView({
  widget,
  game,
  viewId,
  rowIdx,
  widgetIdx,
  precomputed,
}: {
  widget: Widget;
  game: number;
  viewId: string;
  rowIdx: number;
  widgetIdx: number;
  precomputed: Record<string, Row[]>;
}) {
  const id = widgetId(viewId, rowIdx, widgetIdx);
  const data = precomputed[id];
  return (
    <div className={SIZE_CLASS[sizeOf(widget)]}>
      {widget.kind === "stat" ? (
        <StatWidget widget={widget} game={game} precomputed={data} />
      ) : widget.kind === "tabs" ? (
        <TabsWidget
          widget={widget}
          game={game}
          viewId={viewId}
          rowIdx={rowIdx}
          widgetIdx={widgetIdx}
          precomputed={precomputed}
        />
      ) : (
        <ChartWidget widget={widget} game={game} precomputed={data} />
      )}
    </div>
  );
}

/**
 * Render a dashboard purely from its JSON spec. Each row is a flex-wrap line of
 * widgets; each widget fetches its own data, so they load independently.
 */
export function DashboardRenderer({
  spec,
  game,
  viewId,
  precomputed,
}: {
  spec: DashboardSpec;
  game: number;
  viewId: string;
  precomputed: Record<string, Row[]>;
}) {
  return (
    <div className="flex flex-col gap-4">
      {spec.rows.map((row, i) => (
        <div key={i} className="flex flex-wrap gap-4">
          {row.widgets.map((widget, j) => (
            <WidgetView
              key={j}
              widget={widget}
              game={game}
              viewId={viewId}
              rowIdx={i}
              widgetIdx={j}
              precomputed={precomputed}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
