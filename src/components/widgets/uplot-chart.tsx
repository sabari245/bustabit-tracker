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

export type ChartEnvelope = {
  /** Full-resolution x values, ascending. */
  xs: ArrayLike<number>;
  /** Full-resolution y values, same length as xs. */
  ys: ArrayLike<number>;
};

export type ChartThreshold = {
  y: number;
  label?: string;
  seriesKey?: string;
  lineColor?: string;
  aboveColor: string;
  belowColor: string;
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
  formatX?: (u: uPlot, idx: number) => string,
  pointColors?: string[],
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
        const heading = formatX?.(u, idx);
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
            const pointColor = pointColors?.[idx] ?? colors[i];
            return `<div class="flex w-full items-center justify-between gap-2">
              <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 shrink-0 rounded-[2px]" style="background:${pointColor}"></span>${name}</span>
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

const ENVELOPE_BUCKETS = 1000;

/** First index whose value is >= target (xs ascending). */
function lowerBound(xs: ArrayLike<number>, target: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Min/max envelope decimation of the [xmin, xmax] window: at most 2 points per
 * bucket (the bucket's minimum and maximum, in x order), so extremes survive
 * any zoom level. Once the visible window has fewer points than the budget the
 * raw data is returned as-is — zooming in gradually reveals every point.
 */
function decimateEnvelope(
  env: ChartEnvelope,
  xmin: number,
  xmax: number,
  buckets: number,
): [number[], number[]] {
  const { xs, ys } = env;
  const n = xs.length;
  if (n === 0) return [[], []];
  // Extend one point past each edge so the line enters/exits the viewport.
  const i0 = Math.max(0, lowerBound(xs, xmin) - 1);
  const i1 = Math.min(n - 1, lowerBound(xs, xmax));
  const count = i1 - i0 + 1;
  const outX: number[] = [];
  const outY: number[] = [];
  if (count <= buckets * 2) {
    for (let i = i0; i <= i1; i++) {
      outX.push(xs[i]);
      outY.push(ys[i]);
    }
    return [outX, outY];
  }
  const size = count / buckets;
  let prevIdx = -1;
  const push = (i: number) => {
    if (i === prevIdx) return;
    prevIdx = i;
    outX.push(xs[i]);
    outY.push(ys[i]);
  };
  push(i0);
  for (let b = 0; b < buckets; b++) {
    const s = i0 + Math.floor(b * size);
    const e = Math.min(i1, i0 + Math.floor((b + 1) * size) - 1);
    let minIdx = s;
    let maxIdx = s;
    for (let i = s + 1; i <= e; i++) {
      if (ys[i] < ys[minIdx]) minIdx = i;
      if (ys[i] > ys[maxIdx]) maxIdx = i;
    }
    if (minIdx <= maxIdx) {
      push(minIdx);
      push(maxIdx);
    } else {
      push(maxIdx);
      push(minIdx);
    }
  }
  push(i1);
  return [outX, outY];
}

/**
 * Re-decimates a full-resolution single-series dataset whenever the x scale
 * changes (wheel/drag/button zoom), and fits the y scale to the visible data.
 * rAF-throttled so a burst of wheel events costs one rebuild per frame.
 */
function envelopePlugin(env: ChartEnvelope): uPlot.Plugin {
  let raf = 0;
  const rebuild = (u: uPlot) => {
    const xmin = Number(u.scales.x.min ?? env.xs[0]);
    const xmax = Number(u.scales.x.max ?? env.xs[env.xs.length - 1]);
    const [dx, dy] = decimateEnvelope(env, xmin, xmax, ENVELOPE_BUCKETS);
    u.setData([dx, dy], false);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of dy) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo <= hi) {
      const pad = Math.max((hi - lo) * 0.06, 1e-9);
      u.setScale("y", { min: lo - pad, max: hi + pad });
    }
  };
  return {
    hooks: {
      setScale: (u, key) => {
        if (key !== "x" || raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          rebuild(u);
        });
      },
      destroy: () => {
        if (raf) cancelAnimationFrame(raf);
      },
    },
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

function coloredPointsPlugin(
  pointColors: string[],
  seriesIdx: number,
): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const xs = u.data[0];
        const ys = u.data[seriesIdx];
        if (!ys) return;

        const { ctx } = u;
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        for (let i = 0; i < xs.length; i += 1) {
          const xVal = xs[i];
          const yVal = ys[i];
          if (xVal == null || yVal == null) continue;

          ctx.fillStyle = pointColors[i] ?? pointColors[0];
          ctx.beginPath();
          ctx.arc(
            u.valToPos(xVal, "x", true),
            u.valToPos(yVal, "y", true),
            4,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }

        ctx.restore();
      },
    },
  };
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  from: [number, number],
  to: [number, number],
) {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
}

function thresholdPlugin(
  threshold: ChartThreshold,
  seriesIdx: number,
  lineColor: string,
  aboveColor: string,
  belowColor: string,
): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const { ctx } = u;
        const left = u.bbox.left;
        const top = u.bbox.top;
        const right = left + u.bbox.width;
        const bottom = top + u.bbox.height;
        const lineY = Math.round(u.valToPos(threshold.y, "y", true));

        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, u.bbox.width, u.bbox.height);
        ctx.clip();

        if (lineY >= top && lineY <= bottom) {
          ctx.strokeStyle = lineColor;
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          drawSegment(ctx, [left, lineY], [right, lineY]);
        }

        const xs = u.data[0];
        const ys = u.data[seriesIdx];
        if (!ys) {
          ctx.restore();
          return;
        }
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (let i = 1; i < xs.length; i += 1) {
          const x1Val = xs[i - 1];
          const x2Val = xs[i];
          const y1Val = ys[i - 1];
          const y2Val = ys[i];
          if (x1Val == null || x2Val == null || y1Val == null || y2Val == null) {
            continue;
          }

          const x1 = u.valToPos(x1Val, "x", true);
          const x2 = u.valToPos(x2Val, "x", true);
          const y1 = u.valToPos(y1Val, "y", true);
          const y2 = u.valToPos(y2Val, "y", true);
          const startsAbove = y1Val >= threshold.y;
          const endsAbove = y2Val >= threshold.y;

          if (startsAbove === endsAbove || y1Val === y2Val) {
            ctx.strokeStyle = startsAbove ? aboveColor : belowColor;
            drawSegment(ctx, [x1, y1], [x2, y2]);
            continue;
          }

          const t = (threshold.y - y1Val) / (y2Val - y1Val);
          const crossX = x1 + (x2 - x1) * t;
          const cross = [crossX, lineY] satisfies [number, number];

          ctx.strokeStyle = startsAbove ? aboveColor : belowColor;
          drawSegment(ctx, [x1, y1], cross);
          ctx.strokeStyle = endsAbove ? aboveColor : belowColor;
          drawSegment(ctx, cross, [x2, y2]);
        }

        ctx.restore();

        if (threshold.label && lineY >= top && lineY <= bottom) {
          ctx.save();
          ctx.font = FONT;
          ctx.fillStyle = lineColor;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          ctx.fillText(threshold.label, right - 4, lineY - 4);
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
  threshold,
  envelope,
}: {
  widget: ChartWidgetSpec;
  data: Row[];
  x: string;
  series: Series[];
  numericX?: boolean;
  interactive?: boolean;
  markers?: ChartMarker[];
  threshold?: ChartThreshold;
  /** Full-resolution data for a single-series line chart; the chart renders a
   * min/max envelope and re-decimates on zoom. Overrides `data` for the series. */
  envelope?: ChartEnvelope;
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

    // Envelope mode: single-series line over full-resolution data, decimated
    // per zoom window instead of pre-sampled rows.
    const env = envelope && series.length === 1 && envelope.xs.length > 0 ? envelope : undefined;
    const envInitial = env ? decimateEnvelope(env, -Infinity, Infinity, ENVELOPE_BUCKETS) : null;

    const n = data.length;
    const xs = envInitial
      ? envInitial[0]
      : numericX
        ? data.map((r, i) => chartNumber(r[x]) ?? i)
        : data.map((_, i) => i);
    const labels = data.map((r) => String(r[x] ?? ""));
    const colors = series.map((s) => css(s.color));
    const aligned: uPlot.AlignedData = envInitial
      ? envInitial
      : [xs, ...series.map((s) => data.map((r) => chartNumber(r[s.key])))];
    const isBar = widget.type === "bar";
    const isArea = widget.type === "area";
    const fullX: [number, number] = env
      ? [Number(env.xs[0] ?? 0), Number(env.xs[env.xs.length - 1] ?? 0)]
      : isBar
        ? [-0.5, Math.max(0, n - 0.5)]
        : numericX
          ? [xs[0] ?? 0, xs[xs.length - 1] ?? 0]
          : [0, Math.max(0, n - 1)];
    fullXRef.current = fullX;

    const muted = css("var(--muted-foreground)");
    const markerColor = css("var(--destructive)");
    const thresholdLineColor = threshold?.lineColor
      ? css(threshold.lineColor)
      : muted;
    const thresholdAboveColor = threshold ? css(threshold.aboveColor) : "";
    const thresholdBelowColor = threshold ? css(threshold.belowColor) : "";
    const pointColors = widget.alternatingPointColors
      ? data.map((row, i) => {
          const position = chartNumber(row[x]) ?? i + 1;
          return Math.abs(position) % 2 === 1
            ? css(widget.alternatingPointColors!.oddColor)
            : css(widget.alternatingPointColors!.evenColor);
        })
      : undefined;
    const pointLineColor = widget.alternatingPointColors
      ? css(widget.alternatingPointColors.lineColor ?? "var(--muted-foreground)")
      : "";
    const thresholdSeriesIdx = threshold && series.length > 0
      ? Math.max(
          0,
          series.findIndex((s) => !threshold.seriesKey || s.key === threshold.seriesKey),
        )
      : -1;
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
          // Envelope data changes with zoom, so let uPlot pick round-number
          // splits from the current scale instead of pinning them to the
          // initial decimation.
          ...(env ? {} : { splits: () => xSplits }),
          values: (_u, sp) =>
            numericX || env
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
          stroke:
            i === thresholdSeriesIdx
              ? "transparent"
              : pointColors
                ? pointLineColor
                : colors[i],
          ...(isBar
            ? { paths: barPaths(i), fill: colors[i] }
            : isArea
              ? { width: 2, paths: uPlot.paths.spline!(), fill: withAlpha(colors[i], 0.2) }
              : {
                  width: i === thresholdSeriesIdx ? 0 : 2,
                  paths: uPlot.paths.spline!(),
                }),
        })),
      ],
      plugins: [
        tooltipPlugin(
          series,
          colors,
          (u, idx) =>
            numericX || env
              ? `${widget.xTitle ? `${widget.xTitle} ` : ""}${Number(u.data[0][idx]).toLocaleString()}`
              : (labels[idx] ?? ""),
          pointColors,
        ),
        ...(env ? [envelopePlugin(env)] : []),
        ...(pointColors
          ? series.map((_, i) => coloredPointsPlugin(pointColors, i + 1))
          : []),
        ...(markers.length > 0 ? [markersPlugin(markers, markerColor)] : []),
        ...(threshold && thresholdSeriesIdx >= 0
          ? [
              thresholdPlugin(
                threshold,
                thresholdSeriesIdx + 1,
                thresholdLineColor,
                thresholdAboveColor,
                thresholdBelowColor,
              ),
            ]
          : []),
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
  }, [widget, data, x, series, numericX, interactive, markers, threshold, envelope, themeTick]);

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
