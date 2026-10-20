import { ArrowUp, Crosshair, Loader2, RotateCcw, Square, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { resetChat, sendChat, type ChartSpec } from "../api";
import type { Live } from "../useLive";
import { buildTopicIndex, linkTopics, resolveTopic, TOPIC_HREF, type TopicIndex } from "../topicLinks";
import { HistoryChart } from "./HistoryChart";

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; ok?: boolean }
  | { kind: "chart"; chart: ChartSpec };

interface Msg {
  role: "user" | "assistant";
  parts: Part[];
  error?: string;
}

const SUGGESTIONS = [
  "Give me an overview of what's on the broker",
  "Is anything abnormal in the last 30 minutes?",
  "How has OEE compared between line 1 and line 2 over the last hour?",
  "When did packaging line 1 last go down, and for how long?",
  "Chart the oven zone temperatures for the last hour",
  "Which motors are running hottest right now?",
  "Have we missed any filler counter messages in the last hour?",
  "Is a network latency drift coming, and how well has it been predicted?",
  "Run SPC on the filler fill weights: are they in control, and what is the Cpk?",
];

function newSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const toolLabel = (name: string, input: Record<string, unknown>) => {
  const arg = input.topic ?? input.filter ?? (Array.isArray(input.topics) ? (input.topics as string[]).join(", ") : "");
  return `${name}${arg ? ` · ${arg}` : ""}`;
};

interface Props {
  live: Live;
  enabled: boolean;
  draft: string;
  onDraftUsed: () => void;
  /** Highlight a topic, branch or filter (comma-separated for several) in the graph. */
  onHighlight: (query: string) => void;
}

const shortTopic = (t: string) => (t.includes(",") ? `${t.split(",").length} × ${t.split(",")[0].trim().split("/").slice(-2).join("/")}` : t.split("/").slice(-3).join("/"));

/** Topics an answer mentions, plus the ones its tool calls looked at. */
function relatedTopics(m: Msg, index: TopicIndex): string[] {
  const out = new Set<string>();
  for (const p of m.parts) {
    if (p.kind === "text") linkTopics(p.text, index).topics.forEach((t) => out.add(t));
    else if (p.kind === "chart") p.chart.topics.forEach((t) => out.add(t));
    else if (p.kind === "tool") {
      const args = [p.input.topic, p.input.filter, ...(Array.isArray(p.input.topics) ? p.input.topics : [])];
      for (const a of args) {
        const t = typeof a === "string" && a !== "#" ? resolveTopic(a, index) : null;
        if (t) out.add(t);
      }
    }
  }
  return [...out];
}

/** Chat with Claude about the broker. Tool calls show as chips and charts render inline. */
export function Chat({ live, enabled, draft, onDraftUsed, onHighlight }: Props) {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const topicKey = [...live.topics.keys()].sort().join("\n");
  const index = useMemo(() => buildTopicIndex(topicKey ? topicKey.split("\n") : []), [topicKey]);
  const mdComponents = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
        href?.startsWith(TOPIC_HREF) ? (
          <a
            href={href}
            className="topic-link"
            title="Highlight in the topic graph"
            onClick={(e) => {
              e.preventDefault();
              onHighlight(decodeURIComponent(href.slice(TOPIC_HREF.length)));
            }}
          >
            {children}
          </a>
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
    }),
    [onHighlight],
  );

  useEffect(() => {
    if (draft) {
      setInput(draft);
      onDraftUsed();
      inputRef.current?.focus();
    }
  }, [draft, onDraftUsed]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const update = (fn: (m: Msg) => Msg) => setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput("");
    setBusy(true);
    setMessages((ms) => [...ms, { role: "user", parts: [{ kind: "text", text }] }, { role: "assistant", parts: [] }]);
    abort.current = new AbortController();
    try {
      await sendChat(
        sessionId,
        text,
        (e) => {
          if (e.type === "text")
            update((m) => {
              const last = m.parts[m.parts.length - 1];
              if (last?.kind === "text") return { ...m, parts: [...m.parts.slice(0, -1), { kind: "text", text: last.text + e.text }] };
              return { ...m, parts: [...m.parts, { kind: "text", text: e.text }] };
            });
          else if (e.type === "tool") update((m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: e.id, name: e.name, input: e.input }] }));
          else if (e.type === "tool_result")
            update((m) => ({ ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.id === e.id ? { ...p, ok: e.ok } : p)) }));
          else if (e.type === "chart") update((m) => ({ ...m, parts: [...m.parts, { kind: "chart", chart: e.chart }] }));
          else if (e.type === "error") update((m) => ({ ...m, error: e.message }));
        },
        abort.current.signal,
      );
    } catch (err) {
      if (!abort.current.signal.aborted) update((m) => ({ ...m, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    abort.current?.abort();
    await resetChat(sessionId);
    setSessionId(newSessionId());
    setMessages([]);
  };

  return (
    <aside className="chat">
      <header className="chat-head">
        <div>
          <div className="title">Ask the broker</div>
          <div className="small muted">Live values and up to 3 hours of history</div>
        </div>
        <button className="icon" onClick={reset} title="New conversation">
          <RotateCcw size={16} />
        </button>
      </header>

      <div className="chat-scroll" ref={scroller}>
        {!messages.length && (
          <div className="suggestions">
            {!enabled && <div className="notice">Set ANTHROPIC_API_KEY in .env and restart the server to enable chat.</div>}
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={!enabled}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.parts.map((p, j) =>
              p.kind === "text" ? (
                m.role === "user" ? (
                  <p key={j}>{p.text}</p>
                ) : (
                  <div key={j} className="md">
                    <Markdown components={mdComponents}>{linkTopics(p.text, index).md}</Markdown>
                  </div>
                )
              ) : p.kind === "tool" ? (
                <div key={j} className={`tool-chip ${p.ok === false ? "bad" : ""}`}>
                  {p.ok === undefined ? <Loader2 size={12} className="spin" /> : <Wrench size={12} />}
                  <span className="mono">{toolLabel(p.name, p.input)}</span>
                </div>
              ) : (
                <div key={j} className="chat-chart">
                  <div className="chat-chart-title">{p.chart.title}</div>
                  <HistoryChart
                    topics={p.chart.topics}
                    from={p.chart.from}
                    to={p.chart.to}
                    units={Object.fromEntries(p.chart.topics.map((t) => [t, live.topics.get(t)?.unit]))}
                    height={200}
                  />
                </div>
              ),
            )}
            {m.role === "assistant" && busy && i === messages.length - 1 && !m.parts.length && (
              <div className="thinking">
                <Loader2 size={14} className="spin" /> Thinking…
              </div>
            )}
            {m.role === "assistant" && !(busy && i === messages.length - 1) && <Related topics={relatedTopics(m, index)} onHighlight={onHighlight} isTag={(t) => live.topics.has(t)} />}
            {m.error && <div className="error">{m.error}</div>}
          </div>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          placeholder={enabled ? "Ask about topics, trends, alarms…" : "Chat is disabled until an API key is set"}
          disabled={!enabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {busy ? (
          <button type="button" className="send" onClick={() => abort.current?.abort()} title="Stop">
            <Square size={14} />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!input.trim() || !enabled} title="Send">
            <ArrowUp size={16} />
          </button>
        )}
      </form>
    </aside>
  );
}

/** Chips for the topics an answer relates to; clicking one highlights it in the graph. */
function Related({ topics, onHighlight, isTag }: { topics: string[]; onHighlight: (query: string) => void; isTag: (t: string) => boolean }) {
  if (!topics.length) return null;
  const shown = topics.slice(0, 8);
  // Highlight all covers the tags and filters, not whole branches, which would light up everything under them.
  const all = topics.filter((t) => isTag(t) || /[+#,]/.test(t));
  return (
    <div className="related">
      <span className="small muted">Topics in this answer</span>
      {shown.map((t) => (
        <button key={t} className="related-chip mono" title={t} onClick={() => onHighlight(t)}>
          {shortTopic(t)}
        </button>
      ))}
      {all.length > 1 && (
        <button className="related-chip all" onClick={() => onHighlight(all.join(", "))} title="Highlight all of these in the topic graph">
          <Crosshair size={11} /> Highlight all
        </button>
      )}
    </div>
  );
}
