import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";

export interface ChartSlice {
  label: string;
  value: number;
  color: string;
}

/** Ring chart with the total in the middle. */
export function DonutChart(props: { slices: readonly ChartSlice[]; label: string; size?: number }) {
  const size = () => props.size ?? 148;
  const total = () => props.slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const arcs = () => {
    let offset = 0;
    return props.slices
      .filter((slice) => slice.value > 0)
      .map((slice) => {
        const length = total() > 0 ? (slice.value / total()) * circumference : 0;
        const arc = { ...slice, length, offset };
        offset += length;
        return arc;
      });
  };
  return (
    <div class="work-donut">
      <svg width={size()} height={size()} viewBox="0 0 100 100" role="img" aria-label={props.label}>
        <circle cx="50" cy="50" r={radius} class="work-donut-track" />
        <For each={arcs()}>
          {(arc) => (
            <circle
              cx="50"
              cy="50"
              r={radius}
              class="work-donut-arc"
              stroke={arc.color}
              stroke-dasharray={`${Math.max(0, arc.length - 1.2)} ${circumference}`}
              stroke-dashoffset={-arc.offset}
              transform="rotate(-90 50 50)"
            >
              <title>{`${arc.label}: ${arc.value}`}</title>
            </circle>
          )}
        </For>
        <text x="50" y="49" class="work-donut-total">
          {total()}
        </text>
        <text x="50" y="62" class="work-donut-caption">
          {props.label}
        </text>
      </svg>
      <ul class="work-legend">
        <For each={props.slices}>
          {(slice) => (
            <li>
              <span class="work-legend-dot" style={{ background: slice.color }} />
              <span class="work-legend-label">{slice.label}</span>
              <span class="work-legend-value">{slice.value}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

export interface BarRow {
  label: string;
  value: number;
  max?: number;
  hint?: string;
  color?: string;
}

/** Horizontal progress bars, one per row. */
export function BarList(props: { rows: readonly BarRow[]; empty?: string }) {
  const max = () => Math.max(1, ...props.rows.map((row) => row.max ?? row.value));
  return (
    <Show when={props.rows.length > 0} fallback={<p class="work-empty">{props.empty ?? "Sem dados ainda."}</p>}>
      <ul class="work-bars">
        <For each={props.rows}>
          {(row) => (
            <li>
              <div class="work-bars-head">
                <span class="work-bars-label" title={row.label}>
                  {row.label}
                </span>
                <span class="work-bars-value">{row.hint ?? row.value}</span>
              </div>
              <div class="work-bars-track">
                <div
                  class="work-bars-fill"
                  style={{
                    width: `${Math.min(100, (row.value / (row.max ?? max())) * 100)}%`,
                    ...(row.color ? { background: row.color } : {}),
                  }}
                />
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** Vertical columns (for example tasks per day). */
export function ColumnChart(props: { columns: readonly { label: string; value: number; highlight?: boolean }[] }) {
  const max = () => Math.max(1, ...props.columns.map((column) => column.value));
  return (
    <div class="work-columns" role="img" aria-label={props.columns.map((c) => `${c.label} ${c.value}`).join(", ")}>
      <For each={props.columns}>
        {(column) => (
          <div class="work-column" data-highlight={column.highlight ? "" : undefined}>
            <span class="work-column-value">{column.value || ""}</span>
            <div class="work-column-bar" style={{ height: `${Math.max(4, (column.value / max()) * 100)}%` }} />
            <span class="work-column-label">{column.label}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** Half-ring gauge for one share (0–1). */
export function Gauge(props: { share: number; label: string; caption?: string }) {
  const share = () => Math.max(0, Math.min(1, props.share));
  const length = Math.PI * 40;
  return (
    <div class="work-gauge">
      <svg viewBox="0 0 100 60" role="img" aria-label={`${props.label} ${Math.round(share() * 100)}%`}>
        <path d="M10 52 A40 40 0 0 1 90 52" class="work-gauge-track" />
        <path
          d="M10 52 A40 40 0 0 1 90 52"
          class="work-gauge-fill"
          stroke-dasharray={`${share() * length} ${length}`}
        />
        <text x="50" y="47" class="work-gauge-value">{`${Math.round(share() * 100)}%`}</text>
      </svg>
      <span class="work-gauge-label">{props.label}</span>
      <Show when={props.caption}>
        <span class="work-gauge-caption">{props.caption}</span>
      </Show>
    </div>
  );
}

export function StatCard(props: {
  icon: JSX.Element;
  label: string;
  value: string | number;
  hint?: string;
  tone?: "accent" | "danger" | "warning" | "success" | "neutral";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      class="work-stat"
      data-tone={props.tone ?? "neutral"}
      disabled={!props.onClick}
      onClick={() => props.onClick?.()}
    >
      <span class="work-stat-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span class="work-stat-text">
        <span class="work-stat-label">{props.label}</span>
        <span class="work-stat-value">{props.value}</span>
        <Show when={props.hint}>
          <span class="work-stat-hint">{props.hint}</span>
        </Show>
      </span>
    </button>
  );
}

export function Card(props: { title: string; action?: JSX.Element; class?: string; children: JSX.Element }) {
  return (
    <section class={`work-card${props.class ? ` ${props.class}` : ""}`}>
      <header class="work-card-head">
        <h3>{props.title}</h3>
        <Show when={props.action}>{props.action}</Show>
      </header>
      <div class="work-card-body">{props.children}</div>
    </section>
  );
}

export const STATUS_COLORS = {
  backlog: "#8b8f98",
  todo: "#5b8def",
  doing: "#f2a541",
  done: "#3fb27f",
  cancelled: "#d65c5c",
} as const;
