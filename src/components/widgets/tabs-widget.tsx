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
import { widgetId } from "@/lib/layout";

export function TabsWidget({
  widget,
  game,
  precomputed,
}: {
  widget: TabsWidgetSpec;
  game: number;
  precomputed: Record<string, Row[]>;
}) {
  const onlyTab = widget.tabs.length === 1 ? widget.tabs[0] : null;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{widget.title}</CardTitle>
        {widget.description && (
          <CardDescription>{widget.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {onlyTab ? (
          <ChartWidget
            widget={onlyTab.chart}
            game={game}
            embedded
            precomputed={precomputed[widgetId(widget.id ?? "", onlyTab.value)]}
          />
        ) : (
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
                  precomputed={precomputed[widgetId(widget.id ?? "", t.value)]}
                />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
