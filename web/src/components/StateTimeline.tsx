import { useEffect, useMemo, useState } from "react";
import { getChanges, isBadText, stateText } from "../api";
import { SERIES, STATUS } from "../colors";

interface Props {
  topics: string[];
  from: number;
  to: number;
  live?: boolean;
}

const short = (t: string) => t.split("/").slice(-3).join("/");
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** Trend for text topics: one row per topic, a coloured band for each state over the window. */
export function StateTimeline({ topics, from, to, live = false }: Props) {
  const [data, setData] = useState<Record<string, { ts: number; payload: string }[]>>({});
  const [end, setEnd] = useState(to);
  const span = to - from;
  const key = topics.join("|");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const e = live ? Date.now() : to;
      getChanges(topics, e - span, e).then((d) => !cancelled && (setData(d), setEnd(e)));
    };
    load();
    const timer = live ? setInterval(load, 5000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, live ? 0 : from, live ? 0 : to, live, span]);

  const start = end - span;
  const rows = useMemo(
    () =>
      topics.map((topic) => {
        const changes = data[topic] ?? [];
        const segs = changes.map((c, i) => ({ state: stateText(c.payload), from: Math.max(start, c.ts), to: changes[i + 1]?.ts ?? end }));
        const states = [...new Set(segs.map((s) => s.state))];
        const totals = states.map((st) => ({ state: st, ms: segs.filter((s) => s.state === st).reduce((a, s) => a + s.to - s.from, 0) }));
        return { topic, segs, states, totals };
      }),
    [data, key, start, end],
  );

  return (
    <div className="state-timeline">
      {rows.map(({ topic, segs, states, totals }) => {
        const color = (st: string) => (isBadText(st) ? STATUS.critical : SERIES[states.indexOf(st) % SERIES.length]);
        return (
          <div key={topic} className="st-row">
            <div className="st-label mono small">{short(topic)}</div>
            <div className="st-track">
              {segs.map((s, i) => (
                <div
                  key={i}
                  className="st-seg"
                  style={{ left: `${((s.from - start) / span) * 100}%`, width: `${Math.max(0.2, ((s.to - s.from) / span) * 100)}%`, background: color(s.state) }}
                  title={`${s.state} · ${time(s.from)}–${time(s.to)} (${dur(s.to - s.from)})`}
                />
              ))}
              {!segs.length && <div className="st-empty small muted">No history in this window</div>}
            </div>
            <div className="st-legend small">
              {totals.sort((a, b) => b.ms - a.ms).slice(0, 6).map((t) => (
                <span key={t.state}>
                  <i style={{ background: color(t.state) }} />
                  {t.state || "(empty)"} <span className="muted">{dur(t.ms)}</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
      <div className="st-axis small muted">
        <span>{time(start)}</span>
        <span>{time(start + span / 2)}</span>
        <span>{time(end)}</span>
      </div>
    </div>
  );
}
