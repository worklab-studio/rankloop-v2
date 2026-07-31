"use client";

/** Chart wrappers (recharts) styled with OpenSEO's trend CSS variables
 * (--trend-grid-color, --trend-axis-color, tooltip vars) so charts match
 * their Search Performance look in both themes. */

import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { PositionPoint, TrafficPoint } from "@/lib/types";

const PRIMARY = "var(--color-primary)";
const SUCCESS = "var(--color-success)";

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  background: "var(--trend-tooltip-bg)",
  border: "1px solid var(--trend-tooltip-border)",
  boxShadow: "0 2px 8px var(--trend-tooltip-shadow)",
  color: "var(--color-base-content)",
} as const;

const axisTick = { fontSize: 10, fill: "var(--trend-axis-color)" } as const;

export function TrafficChart({ data }: { data: TrafficPoint[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="impr" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PRIMARY} stopOpacity="var(--trend-fill-start-opacity)" />
              <stop offset="100%" stopColor={PRIMARY} stopOpacity="var(--trend-fill-end-opacity)" />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--trend-grid-color)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date" tick={axisTick} tickLine={false} axisLine={false}
            tickFormatter={(d: string) => d.slice(5)} minTickGap={24}
          />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={44} />
          <Tooltip contentStyle={tooltipStyle} labelStyle={{ fontWeight: 600 }} />
          <Area type="monotone" dataKey="impressions" stroke={PRIMARY} fill="url(#impr)" strokeWidth={2} />
          <Line type="monotone" dataKey="clicks" stroke={SUCCESS} strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Position over time, y-axis reversed (position 1 on top), with a
 * publish-date marker — the receipts visual. */
export function PositionChart({
  points, publishedAt,
}: {
  points: PositionPoint[]; publishedAt: string;
}) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="var(--trend-grid-color)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date" tick={axisTick} tickLine={false} axisLine={false}
            tickFormatter={(d: string) => d.slice(5)} minTickGap={24}
          />
          <YAxis
            reversed domain={[1, "dataMax + 4"]} tick={axisTick} tickLine={false}
            axisLine={false} width={36} allowDecimals={false}
          />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`#${v}`, "position"]} />
          <ReferenceLine
            x={publishedAt} stroke="var(--color-warning)" strokeDasharray="4 2"
            label={{ value: "published", fontSize: 10, fill: "var(--trend-axis-color)", position: "top" }}
          />
          <Line type="monotone" dataKey="position" stroke={PRIMARY} strokeWidth={2} connectNulls dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendBar({ label, spent, budget }: { label: string; spent: number; budget: number }) {
  const pct = Math.min(100, Math.round((spent / budget) * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-base-content/60">
          ${spent.toFixed(2)} / ${budget.toFixed(0)}
        </span>
      </div>
      <progress
        className={`progress w-full ${pct > 80 ? "progress-warning" : "progress-primary"}`}
        value={pct}
        max={100}
      />
    </div>
  );
}
