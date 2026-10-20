export interface TopicRow {
  topic: string;
  value: number | null;
  payload: string;
  unit?: string;
  lastTs: number;
  rate: number;
  count: number;
}

export interface Status {
  broker: { url: string; connected: boolean; subscriptions: string[]; since: number | null; lastError?: string };
  embeddedBroker: { clients: number } | null;
  topicCount: number;
  messagesPerSecond: number;
  totalMessages: number;
  historyFrom: number | null;
  retentionMinutes: number;
  model: string;
  chatEnabled: boolean;
}

export interface HistoryPoint {
  ts: number;
  avg: number;
  min: number;
  max: number;
  n: number;
}

export interface ChartSpec {
  title: string;
  topics: string[];
  from: number;
  to: number;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; ok: boolean; preview: string }
  | { type: "chart"; chart: ChartSpec }
  | { type: "done" }
  | { type: "error"; message: string };

export async function getStatus(): Promise<Status> {
  return (await fetch("/api/status")).json();
}

export async function getThroughput(): Promise<{ ts: number; count: number }[]> {
  return (await fetch("/api/throughput")).json();
}

export async function getHistory(topics: string[], from: number, to: number, points = 300): Promise<Record<string, HistoryPoint[]>> {
  const q = new URLSearchParams({ from: String(from), to: String(to), points: String(points) });
  topics.forEach((t) => q.append("topic", t));
  return (await fetch(`/api/history?${q}`)).json();
}

/** Streams the assistant's reply as server-sent events. */
export async function sendChat(sessionId: string, message: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Chat failed: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}

export async function resetChat(sessionId: string) {
  await fetch("/api/chat/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
}

/** Formats a payload value for display. */
export function display(row: TopicRow): string {
  if (row.value != null) return `${Number.isInteger(row.value) ? row.value : row.value.toFixed(2)}${row.unit ? ` ${row.unit}` : ""}`;
  try {
    const v = JSON.parse(row.payload).value;
    if (v !== undefined) return String(v);
  } catch {}
  return row.payload.slice(0, 40);
}

/** Text value of a non-numeric topic, if any. */
export function textValue(row: TopicRow): string | null {
  if (row.value != null) return null;
  try {
    const v = JSON.parse(row.payload).value;
    return typeof v === "string" ? v : null;
  } catch {
    return row.payload;
  }
}

const BAD = /^(down|tripped|fault|alarm|error|stopped)$/i;
/** True for state/alarm topics that report a problem. */
export function isAlarm(row: TopicRow): boolean {
  const t = textValue(row);
  if (t == null) return false;
  if (row.topic.endsWith("/alarm/active")) return t !== "none" && t !== "";
  return BAD.test(t);
}
