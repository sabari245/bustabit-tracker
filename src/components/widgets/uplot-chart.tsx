import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { chartNumber, type Row } from "@/lib/query";
import type { ChartWidgetSpec, Series } from "@/lib/dashboard-spec";

const FONT = "11px 'Inter Variable', sans-serif";

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
function tooltipPlugin(series: Series[], colors: string[]): uPlot.Plugin {
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
        tip.innerHTML = series
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
}: {
  widget: ChartWidgetSpec;
  data: Row[];
  x: string;
  series: Series[];
  numericX?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
    const muted = css("var(--muted-foreground)");
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
      cursor: { x: true, y: false, points: { show: false } },
      legend: { show: false },
      scales: {
        x: {
          time: false,
          range:
            isBar
              ? [-0.5, Math.max(0, n - 0.5)]
              : numericX
                ? [xs[0] ?? 0, xs[xs.length - 1] ?? 0]
                : [0, Math.max(0, n - 1)],
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
      plugins: [tooltipPlugin(series, colors)],
      hooks:
        widget.refLine != null
          ? { draw: [refLineHook(widget.refLine, muted)] }
          : {},
    };

    const u = new uPlot(opts, aligned, el);
    const ro = new ResizeObserver(() =>
      u.setSize({ width: el.clientWidth, height: 300 }),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
    };
  }, [widget, data, x, series, numericX, themeTick]);

  return <div ref={ref} className="h-[300px] w-full" />;
}
