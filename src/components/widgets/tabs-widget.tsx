import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartWidget } from "./chart-widget";
import type { TabsWidgetSpec } from "@/lib/dashboard-spec";
import type { Row } from "@/lib/query";
import { widgetId } from "@/lib/views";

export function TabsWidget({
  widget,
  game,
  viewId,
  rowIdx,
  widgetIdx,
  precomputed,
}: {
  widget: TabsWidgetSpec;
  game: number;
  viewId: string;
  rowIdx: number;
  widgetIdx: number;
  precomputed: Record<string, Row[]>;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{widget.title}</CardTitle>
        {widget.description && (
          <CardDescription>{widget.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={widget.tabs[0]?.value}>
          <TabsList>
            {widget.tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {widget.tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              <ChartWidget
                widget={t.chart}
                game={game}
                embedded
                precomputed={precomputed[widgetId(viewId, rowIdx, widgetIdx, t.value)]}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
