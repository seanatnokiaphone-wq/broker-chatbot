export interface TopicRow {
  topic: string;
  value: number | null;
  payload: string;
  unit?: string;
  lastTs: number;
  rate: number;
  count: number;
  /** A nested JSON document; its fields are their own topics underneath it. */
  doc?: boolean;
  /** For a field topic, the document it was split out of. */
  source?: string;
}

export interface Status {
  broker: { url: string; connected: boolean; subscriptions: string[]; since: number | null; lastError?: string };
  embeddedBroker: { clients: number } | null;
  topicCount: number;
  fieldCount: number;
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

export async function getChanges(topics: string[], from: number, to: number): Promise<Record<string, { ts: number; payload: string }[]>> {
  const q = new URLSearchParams({ from: String(from), to: String(to) });
  topics.forEach((t) => q.append("topic", t));
  return (await fetch(`/api/changes?${q}`)).json();
}

export interface Gaps {
  topic: string;
  received: number;
  missed: number;
  lossPct: number;
  gaps: { at: number; lastSeenAt: number; afterSeq: number; nextSeq: number; missed: number }[];
}

export async function getGaps(topic: string, from: number, to: number): Promise<Gaps | null> {
  const q = new URLSearchParams({ topic, from: String(from), to: String(to) });
  return (await fetch(`/api/gaps?${q}`)).json();
}

const SEQ_NAME = /^(seq|sequence|seq_no|seqNo|sequence_number)$/;
/** The topic whose sequence number covers this one: the seq field itself, or the document a field (or document) belongs to. */
export function seqSource(topics: Map<string, TopicRow>, topic: string): string | null {
  const row = topics.get(topic);
  const doc = row?.doc ? topic : row?.source;
  if (SEQ_NAME.test(topic.split("/").at(-1) ?? "")) return topic;
  if (!doc) return null;
  for (const t of topics.keys()) if (t.startsWith(doc + "/") && SEQ_NAME.test(t.slice(doc.length + 1))) return t;
  return null;
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

const BAD = /^(down|tripped|fault|alarm|error|stopped|warning)$/i;
export const isBadText = (s: string) => BAD.test(s);

/** Text of a state payload: the JSON value, or the raw text. */
export function stateText(payload: string): string {
  try {
    const v = JSON.parse(payload);
    if (v && typeof v === "object" && "value" in v) return String(v.value);
  } catch {}
  return payload;
}

/** Topics drawn as nodes: JSON documents are left out, since their fields hang underneath them. */
export const graphTopics = (topics: Map<string, TopicRow>) => [...topics.values()].filter((r) => !r.doc).map((r) => r.topic);
export const docTopics = (topics: Map<string, TopicRow>) => [...topics.values()].filter((r) => r.doc).map((r) => r.topic);
/** The JSON document a path is inside of (or is), if any. */
export const docOf = (docs: string[], id: string) => docs.find((d) => id === d || id.startsWith(d + "/"));
/** True for state/alarm topics that report a problem. */
export function isAlarm(row: TopicRow): boolean {
  const t = textValue(row);
  if (t == null) return false;
  if (row.topic.endsWith("/alarm/active")) return t !== "none" && t !== "";
  return BAD.test(t);
}

export type SpcChartType = "xbar-r" | "xbar-s" | "imr";
export interface Spc {
  chart: SpcChartType;
  n: number;
  every: number;
  points: { ts: number; x: number; r: number | null; rules: number[] }[];
  x: { cl: number; ucl: number; lcl: number; sigma: number };
  r: { cl: number; ucl: number; lcl: number; label: string };
  capability: { mean: number; sigmaWithin: number; sigmaOverall: number; cp: number | null; cpk: number | null; pp: number | null; ppk: number | null; outOfSpecPct: number | null; readings: number };
  spec: { lsl?: number; usl?: number; target?: number };
  violations: { ts: number; rule: number; text: string }[];
}

export async function getSpc(topic: string, from: number, to: number, chart: SpcChartType): Promise<Spc | null> {
  const q = new URLSearchParams({ topic, from: String(from), to: String(to), chart });
  return (await fetch(`/api/spc?${q}`)).json();
}
