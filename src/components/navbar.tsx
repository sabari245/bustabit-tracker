import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";

export type AppPage = "tracker" | "backtester";

export function Navbar({
  page,
  onPageChange,
}: {
  page: AppPage;
  onPageChange: (page: AppPage) => void;
}) {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <span className="font-bold">bustabit tracker</span>
          <nav className="flex items-center gap-1">
            <Button
              size="sm"
              variant={page === "tracker" ? "secondary" : "ghost"}
              onClick={() => onPageChange("tracker")}
            >
              Tracker
            </Button>
            <Button
              size="sm"
              variant={page === "backtester" ? "secondary" : "ghost"}
              onClick={() => onPageChange("backtester")}
            >
              Backtester
            </Button>
          </nav>
        </div>
        <ModeToggle />
      </div>
    </header>
  );
}
