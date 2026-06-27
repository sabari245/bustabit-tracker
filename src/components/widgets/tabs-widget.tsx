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

export function TabsWidget({
  widget,
  game,
}: {
  widget: TabsWidgetSpec;
  game: number;
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
              <ChartWidget widget={t.chart} game={game} embedded />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
