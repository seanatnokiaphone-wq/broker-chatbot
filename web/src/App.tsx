import { Activity, Database, Network, Radio, Rows3 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { getStatus, isAlarm, textValue, type Status } from "./api";
import { SERIES, STATUS } from "./colors";
import { Chat } from "./components/Chat";
import { Explorer } from "./components/Explorer";
import { TrendCards } from "./components/TrendCards";
import { TopicGraph } from "./components/TopicGraph";
import { TopicTree } from "./components/TopicTree";
import { useLive } from "./useLive";

type View = "graph" | "explorer";
const MAX_CARDS = 8;

export default function App() {
  const live = useLive();
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<View>("graph");
  const [graphLayout, setGraphLayout] = useState<"network" | "tree">("network");
  // Trend cards open over the topic graph, newest first.
  const [cards, setCards] = useState<string[]>([]);
  const openCard = (topic: string) => setCards((cs) => [topic, ...cs.filter((c) => c !== topic)].slice(0, MAX_CARDS));
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
  const cardSet = new Set(cards);
  const rows = [...live.topics.values()];
  const fieldCount = rows.filter((r) => r.source).length;
  const topicCount = `${rows.length - fieldCount}${fieldCount ? ` + ${fieldCount} JSON fields` : ""}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Radio size={18} />
          Broker ChatBot
        </div>
        <div className="stats">
          <Stat icon={<span className={`led ${status?.broker.connected && live.connected ? "on" : ""}`} />} label="Broker" value={status?.broker.url ?? "…"} mono />
          <Stat icon={<Rows3 size={14} />} label="Topics" value={topicCount} title={fieldCount ? `${fieldCount} fields split out of nested JSON documents` : undefined} />
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
              <div className="graph-main">
                {graphLayout === "network" ? (
                  <TopicGraph live={live} selected={cardSet} onSelect={openCard} />
                ) : (
                  <TopicTree live={live} selected={cardSet} onSelect={openCard} />
                )}
              </div>
              <TrendCards
                live={live}
                topics={cards}
                onClose={(t) => setCards((cs) => cs.filter((c) => c !== t))}
                onClear={() => setCards([])}
                onOpenTrends={(ts) => (setChartTopics((cur) => [...new Set([...cur, ...ts])].slice(-6)), setView("explorer"))}
                onAsk={setDraft}
              />
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
