import { Activity, Database, MessageSquare, Network, Radio, Rows3, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { display, getStatus, isAlarm, textValue, type Status } from "./api";
import { SERIES, STATUS } from "./colors";
import { Chat } from "./components/Chat";
import { Explorer } from "./components/Explorer";
import { HistoryChart } from "./components/HistoryChart";
import { TopicGraph } from "./components/TopicGraph";
import { TopicTree } from "./components/TopicTree";
import { useLive } from "./useLive";

type View = "graph" | "explorer";

export default function App() {
  const live = useLive();
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<View>("graph");
  const [graphLayout, setGraphLayout] = useState<"network" | "tree">("network");
  const [selected, setSelected] = useState<string | null>(null);
  const [chartTopics, setChartTopics] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const load = () => getStatus().then(setStatus).catch(() => setStatus(null));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const toggleChart = (topic: string) =>
    setChartTopics((ts) => (ts.includes(topic) ? ts.filter((t) => t !== topic) : [...ts, topic].slice(-6)));

  const clearDraft = useCallback(() => setDraft(""), []);
  const alarms = [...live.topics.values()].filter(isAlarm);
  const mps = live.mps.length ? live.mps[live.mps.length - 1].v : 0;
  const historyMin = status?.historyFrom ? Math.round((Date.now() - status.historyFrom) / 60_000) : 0;
  const sel = selected ? live.topics.get(selected) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Radio size={18} />
          Broker ChatBot
        </div>
        <div className="stats">
          <Stat icon={<span className={`led ${status?.broker.connected && live.connected ? "on" : ""}`} />} label="Broker" value={status?.broker.url ?? "…"} mono />
          <Stat icon={<Rows3 size={14} />} label="Topics" value={String(live.topics.size)} />
          <div className="stat spark">
            <Activity size={14} />
            <div>
              <div className="stat-label">Msgs/s</div>
              <div className="stat-value">{mps.toFixed(1)}</div>
            </div>
            <div className="spark-chart">
              <ResponsiveContainer width="100%" height={28}>
                <AreaChart data={live.mps}>
                  <YAxis hide domain={[0, "dataMax"]} />
                  <Area dataKey="v" stroke={SERIES[0]} fill={SERIES[0]} fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <Stat icon={<Database size={14} />} label="History" value={`${historyMin} of ${status?.retentionMinutes ?? 180} min`} />
          <Stat
            icon={<span className="led" style={{ background: alarms.length ? STATUS.critical : STATUS.good }} />}
            label="Alarms"
            value={alarms.length ? `${alarms.length} active` : "None"}
            title={alarms.map((a) => `${a.topic}: ${textValue(a)}`).join("\n")}
          />
        </div>
      </header>

      <main className="main">
        <section className="workspace">
          <nav className="tabs">
            <button className={view === "graph" ? "on" : ""} onClick={() => setView("graph")}>
              <Network size={14} /> Topic graph
            </button>
            <button className={view === "explorer" ? "on" : ""} onClick={() => setView("explorer")}>
              <Rows3 size={14} /> Explorer & trends
            </button>
            {view === "graph" && (
              <div className="segmented layout-toggle" aria-label="Graph layout">
                <button className={graphLayout === "network" ? "on" : ""} onClick={() => setGraphLayout("network")}>
                  Network
                </button>
                <button className={graphLayout === "tree" ? "on" : ""} onClick={() => setGraphLayout("tree")}>
                  Tree →
                </button>
              </div>
            )}
          </nav>
          {view === "graph" ? (
            <div className="graph-view">
              {graphLayout === "network" ? (
                <TopicGraph live={live} selected={selected} onSelect={setSelected} />
              ) : (
                <TopicTree live={live} selected={selected} onSelect={setSelected} />
              )}
              {sel && (
                <div className="detail">
                  <div className="detail-head">
                    <div className="mono small">{sel.topic}</div>
                    <button className="icon" onClick={() => setSelected(null)}>
                      <X size={14} />
                    </button>
                  </div>
                  <div className={`detail-value ${isAlarm(sel) ? "bad" : ""}`}>{display(sel)}</div>
                  <div className="small muted">
                    {sel.rate.toFixed(0)} msg/min · {sel.count.toLocaleString()} recorded
                  </div>
                  {sel.value != null && <HistoryChart topics={[sel.topic]} from={Date.now() - 15 * 60_000} to={Date.now()} units={{ [sel.topic]: sel.unit }} live height={150} />}
                  <div className="detail-actions">
                    {sel.value != null && (
                      <button onClick={() => (toggleChart(sel.topic), setView("explorer"))}>Open in trends</button>
                    )}
                    <button onClick={() => setDraft(`What has ${sel.topic} been doing over the last hour?`)}>
                      <MessageSquare size={12} /> Ask about this
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Explorer live={live} chartTopics={chartTopics} onToggle={toggleChart} />
          )}
        </section>
        <Chat live={live} enabled={!!status?.chatEnabled} draft={draft} onDraftUsed={clearDraft} />
      </main>
    </div>
  );
}

function Stat({ icon, label, value, mono, title }: { icon: React.ReactNode; label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="stat" title={title}>
      {icon}
      <div>
        <div className="stat-label">{label}</div>
        <div className={`stat-value ${mono ? "mono" : ""}`}>{value}</div>
      </div>
    </div>
  );
}
