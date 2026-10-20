import { ArrowUp, Loader2, RotateCcw, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { resetChat, sendChat, type ChartSpec } from "../api";
import type { Live } from "../useLive";
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
}

/** Chat with Claude about the broker. Tool calls show as chips and charts render inline. */
export function Chat({ live, enabled, draft, onDraftUsed }: Props) {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
                    <Markdown>{p.text}</Markdown>
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
