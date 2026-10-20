import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
}

const short = (t: string) => t.split("/").slice(-3).join("/");
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Line chart of recorded history. Topics with different units get their own panel, so there is never a second y-axis. */
export function HistoryChart({ topics, from, to, units = {}, live = false, height = 220 }: Props) {
  const [data, setData] = useState<Record<string, HistoryPoint[]>>({});
  const span = to - from;
  const key = topics.join("|");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const end = live ? Date.now() : to;
      getHistory(topics, end - span, end, 240).then((d) => !cancelled && setData(d));
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
    <div className="history-chart">
      {groups.map(([unit, ts]) => {
        const rows = new Map<number, Record<string, number>>();
        for (const t of ts) for (const p of data[t] ?? []) rows.set(p.ts, { ...(rows.get(p.ts) ?? { ts: p.ts }), [t]: p.avg });
        const series = [...rows.values()].sort((a, b) => a.ts - b.ts);
        return (
          <div key={unit} className="chart-panel">
            {unit && <div className="chart-unit">{unit}</div>}
            <ResponsiveContainer width="100%" height={height / Math.max(1, groups.length > 1 ? 1.4 : 1)}>
              <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2c2c2a" vertical={false} />
                <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} tickFormatter={time} stroke="#383835" tick={{ fill: "#898781", fontSize: 11 }} minTickGap={40} />
                <YAxis stroke="#383835" tick={{ fill: "#898781", fontSize: 11 }} width={44} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "#1a1a19", border: "1px solid #383835", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#c3c2b7" }}
                  itemStyle={{ color: "#f0efec" }}
                  labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
                  formatter={(v, name) => [`${Number(v).toFixed(2)}${unit ? ` ${unit}` : ""}`, short(String(name))]}
                />
                {ts.length > 1 && <Legend formatter={(v) => <span style={{ color: "#c3c2b7", fontSize: 11 }}>{short(String(v))}</span>} />}
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
