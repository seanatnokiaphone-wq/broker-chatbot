import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getHistory, type HistoryPoint } from "../api";
import { SERIES } from "../colors";

interface Props {
  topics: string[];
  from: number;
  to: number;
  units?: Record<string, string | undefined>;
  /** Re-fetch every few seconds and slide the window forward. */
  live?: boolean;
  height?: number;
  /** Enables drag-to-zoom: called with the selected time range. */
  onZoom?: (from: number, to: number) => void;
  /** Times to mark with a red line, e.g. where messages were missed. */
  markers?: number[];
}

const short = (t: string) => t.split("/").slice(-3).join("/");
const timeFmt = (span: number) => (ts: number) =>
  new Date(ts).toLocaleTimeString([], span < 15 * 60_000 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** Line chart of recorded history. Topics with different units get their own panel, so there is never a second y-axis. */
export function HistoryChart({ topics, from, to, units = {}, live = false, height = 220, onZoom, markers = [] }: Props) {
  const [data, setData] = useState<Record<string, HistoryPoint[]>>({});
  const [win, setWin] = useState({ from, to });
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Mouse position to a timestamp, from the plot area: y-axis width 44 on the left, margin 12 on the right.
  const tsAt = (ev?: { clientX: number }) => {
    const r = wrap.current?.getBoundingClientRect();
    const w = r?.width ?? 0;
    if (!ev || !r || w <= 60) return null;
    const chartX = ev.clientX - r.left;
    const f = Math.min(1, Math.max(0, (chartX - 44) / (w - 56)));
    return win.from + f * (win.to - win.from);
  };
  const span = to - from;
  const time = timeFmt(span);
  const key = topics.join("|");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const end = live ? Date.now() : to;
      getHistory(topics, end - span, end, 240).then((d) => !cancelled && (setData(d), setWin({ from: end - span, to: end })));
    };
    load();
    const timer = live ? setInterval(load, 5000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, live ? 0 : from, live ? 0 : to, live, span]);

  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const t of topics) {
      const u = units[t] ?? "";
      g.set(u, [...(g.get(u) ?? []), t]);
    }
    return [...g];
  }, [key, units]);

  return (
    <div className="history-chart" ref={wrap}>
      {groups.map(([unit, ts]) => {
        const rows = new Map<number, Record<string, number>>();
        for (const t of ts) for (const p of data[t] ?? []) rows.set(p.ts, { ...(rows.get(p.ts) ?? { ts: p.ts }), [t]: p.avg });
        const series = [...rows.values()].sort((a, b) => a.ts - b.ts);
        return (
          <div key={unit} className="chart-panel">
            {unit && <div className="chart-unit">{unit}</div>}
            <ResponsiveContainer width="100%" height={height / Math.max(1, groups.length > 1 ? 1.4 : 1)}>
              <LineChart
                data={series}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                style={onZoom ? { cursor: "crosshair", userSelect: "none" } : undefined}
                onMouseDown={(_, ev) => {
                  const t = onZoom ? tsAt(ev as unknown as MouseEvent) : null;
                  if (t != null) setDrag({ a: t, b: t });
                }}
                onMouseMove={(_, ev) => {
                  const t = drag ? tsAt(ev as unknown as MouseEvent) : null;
                  if (drag && t != null) setDrag({ ...drag, b: t });
                }}
                onMouseUp={() => {
                  if (drag && onZoom) onZoom(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b));
                  setDrag(null);
                }}
                onMouseLeave={() => setDrag(null)}
              >
                <CartesianGrid stroke="#2c2c2a" vertical={false} />
                <XAxis dataKey="ts" type="number" domain={[win.from, win.to]} allowDataOverflow tickFormatter={time} stroke="#383835" tick={{ fill: "#898781", fontSize: 11 }} minTickGap={40} />
                <YAxis stroke="#383835" tick={{ fill: "#898781", fontSize: 11 }} width={44} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "#1a1a19", border: "1px solid #383835", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#c3c2b7" }}
                  itemStyle={{ color: "#f0efec" }}
                  labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                  formatter={(v, name) => [`${Number(v).toFixed(2)}${unit ? ` ${unit}` : ""}`, short(String(name))]}
                />
                {ts.length > 1 && <Legend formatter={(v) => <span style={{ color: "#c3c2b7", fontSize: 11 }}>{short(String(v))}</span>} />}
                {markers.map((m) => (
                  <ReferenceLine key={m} x={m} stroke="#d03b3b" strokeDasharray="3 3" strokeOpacity={0.8} ifOverflow="hidden" />
                ))}
                {drag && drag.a !== drag.b && <ReferenceArea x1={drag.a} x2={drag.b} fill="#3987e5" fillOpacity={0.15} stroke="#3987e5" strokeOpacity={0.5} />}
                {ts.map((t) => (
                  <Line key={t} dataKey={t} stroke={SERIES[topics.indexOf(t) % SERIES.length]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}
