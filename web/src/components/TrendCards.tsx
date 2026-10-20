import { LineChart as ChartIcon, MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { display, isAlarm } from "../api";
import type { Live } from "../useLive";
import { HistoryChart } from "./HistoryChart";
import { StateTimeline } from "./StateTimeline";

const RANGES = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "3h", minutes: 180 },
];

interface Props {
  live: Live;
  topics: string[];
  onClose: (topic: string) => void;
  onClear: () => void;
  onOpenTrends: (topics: string[]) => void;
  onAsk: (text: string) => void;
}

/** A stack of live trend cards over the topic graph, one per clicked tag. */
export function TrendCards({ live, topics, onClose, onClear, onOpenTrends, onAsk }: Props) {
  if (!topics.length) return null;
  return (
    <div className="cards">
      <div className="cards-head">
        <span className="small muted">{topics.length === 1 ? "1 card" : `${topics.length} cards`}</span>
        <span className="cards-actions">
          <button onClick={() => onOpenTrends(topics)} title="Chart all of these together in Explorer & trends">
            <ChartIcon size={12} /> Compare all
          </button>
          <button onClick={onClear}>Clear</button>
        </span>
      </div>
      <div className="cards-scroll">
        {topics.map((t) => (
          <TrendCard key={t} live={live} topic={t} onClose={() => onClose(t)} onOpenTrends={() => onOpenTrends([t])} onAsk={onAsk} />
        ))}
      </div>
    </div>
  );
}

function TrendCard({ live, topic, onClose, onOpenTrends, onAsk }: { live: Live; topic: string; onClose: () => void; onOpenTrends: () => void; onAsk: (text: string) => void }) {
  const [minutes, setMinutes] = useState(15);
  const row = live.topics.get(topic);
  if (!row) return null;
  const now = Date.now();
  return (
    <div className="card">
      <div className="card-head">
        <div className="mono small" title={topic}>{topic.split("/").slice(-3).join("/")}</div>
        <button className="icon" onClick={onClose} aria-label="Close card">
          <X size={14} />
        </button>
      </div>
      <div className="card-value-row">
        <div className={`card-value ${isAlarm(row) ? "bad" : ""}`}>{display(row)}</div>
        <div className="segmented mini">
          {RANGES.map((r) => (
            <button key={r.minutes} className={minutes === r.minutes ? "on" : ""} onClick={() => setMinutes(r.minutes)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {row.value != null ? (
        <HistoryChart topics={[topic]} from={now - minutes * 60_000} to={now} units={{ [topic]: row.unit }} live height={110} />
      ) : (
        <StateTimeline topics={[topic]} from={now - minutes * 60_000} to={now} live />
      )}
      <div className="card-foot">
        <span className="small muted">
          {row.rate.toFixed(0)} msg/min{row.source ? " · JSON field" : ""}
        </span>
        <span className="card-actions">
          <button className="icon" onClick={onOpenTrends} title="Open in trends" aria-label="Open in trends">
            <ChartIcon size={13} />
          </button>
          <button className="icon" onClick={() => onAsk(`What has ${topic} been doing over the last hour?`)} title="Ask about this" aria-label="Ask about this">
            <MessageSquare size={13} />
          </button>
        </span>
      </div>
    </div>
  );
}
