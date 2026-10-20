import { Braces, Check, Copy, LineChart as ChartIcon, MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { display, isAlarm, seqSource, type Gaps } from "../api";
import { useGaps } from "../useGaps";
import type { Live } from "../useLive";
import { useTimeWindow } from "../useTimeWindow";
import { HistoryChart } from "./HistoryChart";
import { ZoomControls } from "./ZoomControls";
import { JsonView } from "./JsonView";
import { SpcChart } from "./SpcChart";
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
  /** Opens another card, e.g. a field's raw JSON document. */
  onOpen: (topic: string) => void;
}

/** A stack of live trend cards over the topic graph, one per clicked tag. */
export function TrendCards({ live, topics, onClose, onClear, onOpenTrends, onAsk, onOpen }: Props) {
  if (!topics.length) return null;
  return (
    <div className="cards">
      <div className="cards-head">
        <span className="small muted">{topics.length === 1 ? "1 card" : `${topics.length} cards`}</span>
        <span className="cards-actions">
          <button onClick={() => onOpenTrends(topics.filter((t) => !live.topics.get(t)?.doc))} title="Chart all of these together in Explorer & trends">
            <ChartIcon size={12} /> Compare all
          </button>
          <button onClick={onClear}>Clear</button>
        </span>
      </div>
      <div className="cards-scroll">
        {topics.map((t) =>
          live.topics.get(t)?.doc ? (
            <RawJsonCard key={t} live={live} topic={t} onClose={() => onClose(t)} onAsk={onAsk} />
          ) : (
            <TrendCard key={t} live={live} topic={t} onClose={() => onClose(t)} onOpenTrends={() => onOpenTrends([t])} onAsk={onAsk} onOpen={onOpen} />
          ),
        )}
      </div>
    </div>
  );
}

/** The whole latest message of a JSON document topic, updated live. */
function RawJsonCard({ live, topic, onClose, onAsk }: { live: Live; topic: string; onClose: () => void; onAsk: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const now = Date.now();
  const gaps = useGaps(seqSource(live.topics, topic), now - 15 * 60_000, now, true);
  const row = live.topics.get(topic);
  if (!row) return null;
  const fields = [...live.topics.values()].filter((r) => r.source === topic).length;
  const copy = () => navigator.clipboard?.writeText(row.payload).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <div className="card">
      <div className="card-head">
        <div className="mono small" title={topic}>{topic.split("/").slice(-3).join("/")}</div>
        <button className="icon" onClick={onClose} aria-label="Close card">
          <X size={14} />
        </button>
      </div>
      <div className="small muted">
        <Braces size={12} style={{ verticalAlign: "-2px" }} /> Raw JSON · {fields} fields · updated {Math.max(0, Math.round((Date.now() - row.lastTs) / 1000))} s ago
      </div>
      <JsonView text={row.payload} />
      {gaps && <GapSummary gaps={gaps} label="last 15 min" />}
      <div className="card-foot">
        <span className="small muted">{row.rate.toFixed(0)} msg/min</span>
        <span className="card-actions">
          <button className="icon" onClick={copy} title="Copy JSON" aria-label="Copy JSON">
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button className="icon" onClick={() => onAsk(`Summarise the latest ${topic} document and anything unusual in it.`)} title="Ask about this" aria-label="Ask about this">
            <MessageSquare size={13} />
          </button>
        </span>
      </div>
    </div>
  );
}

/** Missed-message summary from sequence-number jumps; red lines on the chart mark each gap. */
function GapSummary({ gaps, label }: { gaps: Gaps; label?: string }) {
  if (!gaps.received) return null;
  const biggest = gaps.gaps.reduce<Gaps["gaps"][number] | null>((a, g) => (!a || g.missed > a.missed ? g : a), null);
  return gaps.missed ? (
    <div className="gap-summary bad small" title={gaps.gaps.slice(-8).map((g) => `${new Date(g.at).toLocaleTimeString()}: seq ${g.afterSeq} → ${g.nextSeq} (${g.missed} missed)`).join("\n")}>
      ⚠ {gaps.missed} missed of {gaps.missed + gaps.received} ({gaps.lossPct.toFixed(1)}%) · {gaps.gaps.length} gap{gaps.gaps.length === 1 ? "" : "s"}
      {biggest && biggest.missed > 1 ? ` · longest ${Math.round((biggest.at - biggest.lastSeenAt) / 1000)} s` : ""}
      {label ? ` · ${label}` : ""}
    </div>
  ) : (
    <div className="gap-summary small">✓ No missed messages{label ? ` · ${label}` : ""}</div>
  );
}

function TrendCard({ live, topic, onClose, onOpenTrends, onAsk, onOpen }: { live: Live; topic: string; onClose: () => void; onOpenTrends: () => void; onAsk: (text: string) => void; onOpen: (topic: string) => void }) {
  const win = useTimeWindow(15);
  const [spc, setSpc] = useState(false);
  const gaps = useGaps(seqSource(live.topics, topic), win.from, win.to, win.live);
  const row = live.topics.get(topic);
  if (!row) return null;
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
            <button key={r.minutes} className={!win.zoomed && win.minutes === r.minutes ? "on" : ""} onClick={() => win.setMinutes(r.minutes)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {row.value != null && spc ? (
        <SpcChart topic={topic} from={win.from} to={win.to} live={win.live} unit={row.unit} />
      ) : row.value != null ? (
        <HistoryChart topics={[topic]} from={win.from} to={win.to} units={{ [topic]: row.unit }} live={win.live} height={110} onZoom={win.zoomTo} markers={gaps?.gaps.map((g) => g.at)} />
      ) : (
        <StateTimeline topics={[topic]} from={win.from} to={win.to} live={win.live} />
      )}
      {gaps && <GapSummary gaps={gaps} />}
      <ZoomControls win={win} compact />
      <div className="card-foot">
        <span className="small muted">
          {row.rate.toFixed(0)} msg/min{row.source ? " · JSON field" : ""}
        </span>
        <span className="card-actions">
          {row.value != null && (
            <button className={`text-toggle ${spc ? "on" : ""}`} onClick={() => setSpc(!spc)} title="Statistical process control: control limits, rule violations and capability">
              SPC
            </button>
          )}
          {row.source && (
            <button className="icon" onClick={() => onOpen(row.source!)} title="Show the raw JSON document" aria-label="Show the raw JSON document">
              <Braces size={13} />
            </button>
          )}
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
