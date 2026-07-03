import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { chartNumber, type Row } from "@/lib/query";
import type { ChartWidgetSpec, Series } from "@/lib/dashboard-spec";

const FONT = "11px 'Inter Variable', sans-serif";

export type ChartMarker = {
  x: number;
  label: string;
  color?: string;
};

/** Resolve a colour that may be a `var(--x)` reference, against `el`'s computed style. */
function resolveColor(el: Element, color: string): string {
  const m = color.match(/^var\((--[\w-]+)\)$/);
  return m ? getComputedStyle(el).getPropertyValue(m[1]).trim() : color;
}

/** Add an alpha channel to an oklch/rgb/hsl colour string (theme colours are oklch). */
function withAlpha(color: string, a: number): string {
  return color.endsWith(")") ? color.replace(/\s*\)\s*$/, ` / ${a})`) : color;
}

/**
 * Hover tooltip styled like the old shadcn popover card: a colour dot + value per
 * series (the series name only when there's more than one), with no x-axis label
 * heading. Lives entirely in the DOM/canvas layer — no React re-render on hover.
 */
function tooltipPlugin(
  series: Series[],
  colors: string[],
  formatX?: (idx: number) => string,
): uPlot.Plugin {
  let tip: HTMLDivElement;
  const named = series.length > 1;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className =
          "pointer-events-none absolute left-0 top-0 z-50 hidden min-w-24 gap-1.5 rounded-xl bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10";
        u.over.appendChild(tip);
      },
      setCursor: (u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left == null || left < 0) {
          tip.style.display = "none";
          return;
        }
        const heading = formatX?.(idx);
        const headingHtml = heading
          ? `<div class="mb-1 font-medium text-muted-foreground">${heading}</div>`
          : "";
        tip.innerHTML =
          headingHtml +
          series
          .map((s, i) => {
            const v = u.data[i + 1][idx];
            if (v == null) return "";
            const name = named
              ? `<span class="text-muted-foreground">${s.label}</span>`
              : "";
            return `<div class="flex w-full items-center justify-between gap-2">
              <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 shrink-0 rounded-[2px]" style="background:${colors[i]}"></span>${name}</span>
              <span class="font-mono font-medium tabular-nums">${v.toLocaleString()}</span>
            </div>`;
          })
          .join("");
        tip.style.display = "grid";
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        let x = left + 12;
        let y = (top ?? 0) + 12;
        if (x + w > u.over.clientWidth) x = left - w - 12;
        if (y + h > u.over.clientHeight) y = (top ?? 0) - h - 12;
        tip.style.transform = `translate(${x}px, ${y}px)`;
      },
    },
  };
}

/** Dashed horizontal reference line at a fixed y value (e.g. the 50% guide). */
function refLineHook(yVal: number, color: string) {
  return (u: uPlot) => {
    const y = Math.round(u.valToPos(yVal, "y", true));
    const { ctx } = u;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(u.bbox.left, y);
    ctx.lineTo(u.bbox.left + u.bbox.width, y);
    ctx.stroke();
    ctx.restore();
  };
}

function clampRange(
  min: number,
  max: number,
  fullMin: number,
  fullMax: number,
): [number, number] {
  const width = max - min;
  const fullWidth = fullMax - fullMin;
  if (width >= fullWidth) return [fullMin, fullMax];
  if (min < fullMin) return [fullMin, fullMin + width];
  if (max > fullMax) return [fullMax - width, fullMax];
  return [min, max];
}

function zoomX(u: uPlot, factor: number, anchor: number | null, full: [number, number]) {
  const scale = u.scales.x;
  const min = Number(scale.min ?? full[0]);
  const max = Number(scale.max ?? full[1]);
  const width = max - min;
  if (width <= 0) return;
  const nextWidth = Math.min(
    full[1] - full[0],
    Math.max(1, width * factor),
  );
  const pivot = anchor == null ? min + width / 2 : anchor;
  const leftRatio = (pivot - min) / width;
  const nextMin = pivot - nextWidth * leftRatio;
  const nextMax = nextMin + nextWidth;
  const [clampedMin, clampedMax] = clampRange(nextMin, nextMax, full[0], full[1]);
  u.setScale("x", { min: clampedMin, max: clampedMax });
}

function resetZoom(u: uPlot, full: [number, number]) {
  u.setScale("x", { min: full[0], max: full[1] });
}

function interactionPlugin(full: [number, number]): uPlot.Plugin {
  let move: ((e: MouseEvent) => void) | null = null;
  let up: (() => void) | null = null;

  return {
    hooks: {
      ready: (u) => {
        const wheel = (e: WheelEvent) => {
          e.preventDefault();
          const rect = u.over.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const anchor = u.posToVal(x, "x");
          zoomX(u, e.deltaY < 0 ? 0.78 : 1.28, anchor, full);
        };
        const down = (e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const startX = e.clientX;
          const startMin = Number(u.scales.x.min ?? full[0]);
          const startMax = Number(u.scales.x.max ?? full[1]);
          const width = startMax - startMin;
          move = (next) => {
            const dx = next.clientX - startX;
            const delta = (dx / Math.max(1, u.bbox.width)) * width;
            const [min, max] = clampRange(
              startMin - delta,
              startMax - delta,
              full[0],
              full[1],
            );
            u.setScale("x", { min, max });
          };
          up = () => {
            if (move) window.removeEventListener("mousemove", move);
            if (up) window.removeEventListener("mouseup", up);
            move = null;
            up = null;
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up, { once: true });
        };
        const dblClick = () => resetZoom(u, full);
        u.over.addEventListener("wheel", wheel, { passive: false });
        u.over.addEventListener("mousedown", down);
        u.over.addEventListener("dblclick", dblClick);
        (u as uPlot & { _interactiveCleanup?: () => void })._interactiveCleanup = () => {
          u.over.removeEventListener("wheel", wheel);
          u.over.removeEventListener("mousedown", down);
          u.over.removeEventListener("dblclick", dblClick);
          if (move) window.removeEventListener("mousemove", move);
          if (up) window.removeEventListener("mouseup", up);
        };
      },
      destroy: (u) => {
        (u as uPlot & { _interactiveCleanup?: () => void })._interactiveCleanup?.();
      },
    },
  };
}

function markersPlugin(markers: ChartMarker[], color: string): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx } = u;
        for (const marker of markers) {
          const x = Math.round(u.valToPos(marker.x, "x", true));
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;

          const stroke = marker.color ?? color;
          ctx.save();
          ctx.strokeStyle = stroke;
          ctx.fillStyle = stroke;
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x, u.bbox.top);
          ctx.lineTo(x, u.bbox.top + u.bbox.height);
          ctx.stroke();

          ctx.setLineDash([]);
          const label = marker.label;
          if (!label) {
            ctx.restore();
            continue;
          }
          ctx.font = FONT;
          const padX = 7;
          const w = ctx.measureText(label).width + padX * 2;
          const h = 18;
          const boxX = Math.min(
            Math.max(u.bbox.left + 4, x + 8),
            u.bbox.left + u.bbox.width - w - 4,
          );
          const boxY = u.bbox.top + 8;
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.roundRect(boxX, boxY, w, h, 5);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = "white";
          ctx.textBaseline = "middle";
          ctx.fillText(label, boxX + padX, boxY + h / 2 + 0.5);
          ctx.restore();
        }
      },
    },
  };
}

/**
 * uPlot-backed chart. All layout/rendering runs on canvas outside React — the
 * component only mounts the instance and rebuilds it when its inputs (or the
 * applied colour theme) change. Replaces the previous recharts renderer.
 */
export function UplotChart({
  widget,
  data,
  x,
  series,
  numericX = false,
  interactive = false,
  markers = [],
}: {
  widget: ChartWidgetSpec;
  data: Row[];
  x: string;
  series: Series[];
  numericX?: boolean;
  interactive?: boolean;
  markers?: ChartMarker[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const fullXRef = useRef<[number, number] | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  // Rebuild when the html `class` (light/dark) flips so canvas colours track it.
  useEffect(() => {
    const ob = new MutationObserver(() => setThemeTick((t) => t + 1));
    ob.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const css = (v: string) => resolveColor(el, v);

    const n = data.length;
    const xs = numericX
      ? data.map((r, i) => chartNumber(r[x]) ?? i)
      : data.map((_, i) => i);
    const labels = data.map((r) => String(r[x] ?? ""));
    const colors = series.map((s) => css(s.color));
    const aligned: uPlot.AlignedData = [
      xs,
      ...series.map((s) => data.map((r) => chartNumber(r[s.key]))),
    ];
    const isBar = widget.type === "bar";
    const isArea = widget.type === "area";
    const fullX: [number, number] = isBar
      ? [-0.5, Math.max(0, n - 0.5)]
      : numericX
        ? [xs[0] ?? 0, xs[xs.length - 1] ?? 0]
        : [0, Math.max(0, n - 1)];
    fullXRef.current = fullX;

    const muted = css("var(--muted-foreground)");
    const markerColor = css("var(--destructive)");
    const slot = 0.9 / series.length;

    // Grouped bars (general for any series count): split each unit-wide category
    // band into N equal slots, one bar centred in each via uPlot's `disp` facets.
    const barPaths = (pos: number) =>
      uPlot.paths.bars!({
        radius: 0.15,
        disp: {
          x0: { unit: 1, values: () => xs.map((i) => i - 0.45 + pos * slot + slot * 0.07) },
          size: { unit: 1, values: () => [slot * 0.86] },
        },
      });

    const labelStep = Math.max(1, Math.ceil(n / 12));
    const xSplits = xs.filter((_, i) => i % labelStep === 0);

    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height: 300,
      cursor: {
        x: true,
        y: false,
        points: { show: false },
        // We drive pan/zoom ourselves in interactionPlugin; disable uPlot's
        // built-in drag box-zoom so it doesn't fight our mouse handlers.
        drag: { x: false, y: false },
      },
      legend: { show: false },
      scales: {
        x: {
          time: false,
          // A static `range` tuple PINS the scale — uPlot then ignores
          // `setScale`, so wheel/button zoom silently no-ops. For interactive
          // charts use an identity range instead: it fits the data extent
          // (== fullX) on init and passes our zoomed min/max straight through
          // (no padding), so setScale drives zoom cleanly.
          range: interactive ? (_u, min, max) => [min, max] : fullX,
        },
        y: {
          range: widget.yDomain
            ? widget.yDomain
            : isBar || isArea
              ? (_u, _min, max) => [0, max * 1.12]
              : undefined,
        },
      },
      axes: [
        {
          font: FONT,
          stroke: muted,
          grid: { show: false },
          ticks: { show: false },
          splits: () => xSplits,
          values: (_u, sp) =>
            numericX
              ? sp.map((v) => Number(v).toLocaleString())
              : sp.map((i) => labels[i] ?? ""),
          label: widget.xTitle,
          labelFont: FONT,
          labelSize: widget.xTitle ? 18 : undefined,
        },
        {
          font: FONT,
          stroke: muted,
          size: 52,
          grid: { show: true, stroke: css("var(--border)"), width: 1 },
          ticks: { show: false },
          values: (_u, sp) => sp.map((v) => `${v}${widget.yUnit ?? ""}`),
          label: widget.yTitle,
          labelFont: FONT,
          labelSize: widget.yTitle ? 18 : undefined,
        },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: colors[i],
          ...(isBar
            ? { paths: barPaths(i), fill: colors[i] }
            : isArea
              ? { width: 2, paths: uPlot.paths.spline!(), fill: withAlpha(colors[i], 0.2) }
              : { width: 2, paths: uPlot.paths.spline!() }),
        })),
      ],
      plugins: [
        tooltipPlugin(series, colors, (idx) =>
          numericX
            ? `${widget.xTitle ? `${widget.xTitle} ` : ""}${Number(xs[idx]).toLocaleString()}`
            : (labels[idx] ?? ""),
        ),
        ...(markers.length > 0 ? [markersPlugin(markers, markerColor)] : []),
        ...(interactive ? [interactionPlugin(fullX)] : []),
      ],
      hooks:
        widget.refLine != null
          ? { draw: [refLineHook(widget.refLine, muted)] }
          : {},
    };

    const u = new uPlot(opts, aligned, el);
    plotRef.current = u;
    const ro = new ResizeObserver(() =>
      u.setSize({ width: el.clientWidth, height: 300 }),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [widget, data, x, series, numericX, interactive, markers, themeTick]);

  function control(action: "zoom-in" | "zoom-out" | "reset") {
    const plot = plotRef.current;
    const full = fullXRef.current;
    if (!plot || !full) return;
    if (action === "zoom-in") zoomX(plot, 0.72, null, full);
    else if (action === "zoom-out") zoomX(plot, 1.38, null, full);
    else resetZoom(plot, full);
  }

  return (
    <div className="group relative">
      {interactive && (
        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Zoom in"
                onClick={() => control("zoom-in")}
              >
                <ZoomIn />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom in</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Zoom out"
                onClick={() => control("zoom-out")}
              >
                <ZoomOut />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom out</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Reset zoom"
                onClick={() => control("reset")}
              >
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset zoom</TooltipContent>
          </Tooltip>
        </div>
      )}
      <div
        ref={ref}
        className={cn(
          "h-[300px] w-full",
          interactive && "cursor-grab active:cursor-grabbing",
        )}
      />
    </div>
  );
}
