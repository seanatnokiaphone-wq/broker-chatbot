import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.js";
import type { RecorderStatus } from "./recorder.js";
import type { Store, TopicInfo } from "./store.js";

/** Tools that let Claude read the live topic tree and the recorded history. */

const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null);
const r = (v: number | null | undefined, dp = 3) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const Window = {
  minutes: z.number().positive().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
};
const windowProps = {
  minutes: { type: "number", description: "Look back this many minutes from now (default 60). Ignored if start is given." },
  start: { type: "string", description: "ISO 8601 start time (optional)." },
  end: { type: "string", description: "ISO 8601 end time (optional, default now)." },
} as const;

function resolveWindow(w: { minutes?: number; start?: string; end?: string }) {
  const to = w.end ? Date.parse(w.end) : Date.now();
  const from = w.start ? Date.parse(w.start) : to - (w.minutes ?? 60) * 60_000;
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("Could not parse start/end; use ISO 8601.");
  const earliest = Date.now() - config.retentionMinutes * 60_000;
  return { from: Math.max(from, earliest), to };
}

const summary = (t: TopicInfo) => ({
  topic: t.topic,
  value: t.lastValue ?? t.lastPayload.slice(0, 200),
  unit: t.unit,
  ageSeconds: Math.round((Date.now() - t.lastTs) / 1000),
  msgsPerMin: r(t.rate, 1),
  ...(t.doc ? { kind: "json document" } : t.source ? { fieldOf: t.source } : {}),
});

export interface ChartRequest {
  title: string;
  topics: string[];
  from: number;
  to: number;
}

interface ToolDef<S extends z.ZodTypeAny> {
  tool: Anthropic.Tool;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => unknown;
}

export interface ToolContext {
  store: Store;
  recorder: RecorderStatus;
  onChart: (c: ChartRequest) => void;
}

const def = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

const definitions = [
  def({
    tool: {
      name: "broker_overview",
      description:
        "Overview of the MQTT broker being recorded: connection, topic count, throughput, how far back history goes, busiest topics and the top levels of the topic tree. Call this first when you don't yet know what's on the broker.",
      input_schema: { type: "object", properties: {} },
    },
    schema: z.object({}),
    run: (_i, { store, recorder }) => {
      const topics = [...store.topics.values()];
      const branches = new Map<string, number>();
      for (const t of topics) {
        const key = t.topic.split("/").slice(0, 3).join("/");
        branches.set(key, (branches.get(key) ?? 0) + 1);
      }
      return {
        broker: recorder.url,
        connected: recorder.connected,
        subscriptions: recorder.subscriptions,
        now: iso(Date.now()),
        topicCount: topics.filter((t) => !t.source).length,
        jsonDocuments: topics.filter((t) => t.doc).map((t) => t.topic),
        jsonFieldTopics: topics.filter((t) => t.source).length,
        messagesPerSecond: r(store.messagesPerSecond(), 1),
        historyFrom: iso(store.oldestTs()),
        retentionMinutes: config.retentionMinutes,
        busiestTopics: topics.sort((a, b) => b.rate - a.rate).slice(0, 10).map(summary),
        branches: Object.fromEntries([...branches].sort()),
      };
    },
  }),
  def({
    tool: {
      name: "list_topics",
      description:
        "List topics matching an MQTT filter (+ and # wildcards) with their latest value, unit and age. Use to explore the tree, e.g. 'acme/dublin/packaging/#' or '+/+/+/+/+/motor_temp'.",
      input_schema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "MQTT topic filter, default '#'." },
          limit: { type: "number", description: "Max topics to return (default 150)." },
        },
      },
    },
    schema: z.object({ filter: z.string().default("#"), limit: z.number().int().positive().default(150) }),
    run: ({ filter, limit }, { store }) => {
      const all = store.match(filter);
      return { matched: all.length, topics: all.slice(0, limit).map(summary) };
    },
  }),
  def({
    tool: {
      name: "get_latest",
      description: "Full latest payload for one or more topics or filters, including the raw payload text.",
      input_schema: {
        type: "object",
        properties: { topics: { type: "array", items: { type: "string" }, description: "Topics or MQTT filters." } },
        required: ["topics"],
      },
    },
    schema: z.object({ topics: z.array(z.string()).min(1) }),
    run: ({ topics }, { store }) =>
      topics.flatMap((f) => store.match(f)).slice(0, 100).map((t) => ({
        topic: t.topic, payload: t.lastPayload, value: t.lastValue, unit: t.unit, quality: t.quality,
        receivedAt: iso(t.lastTs), retained: t.retained, messagesRecorded: t.count,
      })),
  }),
  def({
    tool: {
      name: "get_history",
      description:
        "Time series for one numeric topic over a window, bucketed to at most max_points points with avg/min/max per bucket. Use for trends and 'what happened in the last hour' questions.",
      input_schema: {
        type: "object",
        properties: { topic: { type: "string" }, ...windowProps, max_points: { type: "number", description: "Default 60, max 500." } },
        required: ["topic"],
      },
    },
    schema: z.object({ topic: z.string(), ...Window, max_points: z.number().int().positive().max(500).default(60) }),
    run: ({ topic, max_points, ...w }, { store }) => {
      const { from, to } = resolveWindow(w);
      const points = store.history(topic, from, to, max_points);
      return {
        topic, unit: store.topics.get(topic)?.unit, from: iso(from), to: iso(to),
        points: points.map((p) => ({ t: iso(p.ts), avg: r(p.avg), min: r(p.min), max: r(p.max), n: p.n })),
      };
    },
  }),
  def({
    tool: {
      name: "get_stats",
      description:
        "Summary statistics (min, max, avg, stddev, first, last, change, sample count) over a window for every topic matching a filter. Good for comparing machines, e.g. all motor temperatures.",
      input_schema: { type: "object", properties: { filter: { type: "string" }, ...windowProps }, required: ["filter"] },
    },
    schema: z.object({ filter: z.string(), ...Window }),
    run: ({ filter, ...w }, { store }) => {
      const { from, to } = resolveWindow(w);
      const topics = store.match(filter).slice(0, 60);
      return {
        from: iso(from), to: iso(to), matched: topics.length,
        stats: topics.map((t) => {
          const s = store.stats(t.topic, from, to);
          if (!s.numericCount) return { topic: t.topic, samples: s.count, numeric: false, latest: t.lastPayload.slice(0, 120) };
          return {
            topic: t.topic, unit: t.unit, samples: s.count, min: r(s.min), max: r(s.max), avg: r(s.avg), stddev: r(s.stddev),
            first: r(s.first), last: r(s.last), change: s.first != null && s.last != null ? r(s.last - s.first) : null,
          };
        }),
      };
    },
  }),
  def({
    tool: {
      name: "get_state_changes",
      description:
        "Transitions of a state/text topic (e.g. line state, alarms, batch phase) over a window, with timestamps and durations. Use for 'when did line 2 go down' or 'how long was it stopped'.",
      input_schema: { type: "object", properties: { topic: { type: "string" }, ...windowProps }, required: ["topic"] },
    },
    schema: z.object({ topic: z.string(), ...Window }),
    run: ({ topic, ...w }, { store }) => {
      const { from, to } = resolveWindow(w);
      const ch = store.changes(topic, from, to);
      return {
        topic, from: iso(from), to: iso(to),
        changes: ch.map((c, i) => {
          let value: unknown = c.payload;
          try { value = JSON.parse(c.payload).value ?? c.payload; } catch {}
          const next = ch[i + 1]?.ts ?? to;
          return { at: iso(c.ts), value, durationMinutes: r((next - c.ts) / 60_000, 1) };
        }),
      };
    },
  }),
  def({
    tool: {
      name: "find_anomalies",
      description:
        "Scan numeric topics matching a filter for anomalies over a window: spikes or dips whose z-score exceeds the threshold, sharp recent shifts versus the window average, and topics that have gone quiet (stale). Use for 'is anything wrong?' questions.",
      input_schema: {
        type: "object",
        properties: { filter: { type: "string", description: "Default '#'." }, ...windowProps, z_threshold: { type: "number", description: "Default 3." } },
      },
    },
    schema: z.object({ filter: z.string().default("#"), ...Window, z_threshold: z.number().positive().default(3) }),
    run: ({ filter, z_threshold, ...w }, { store }) => {
      const { from, to } = resolveWindow(w);
      const findings: Record<string, unknown>[] = [];
      const now = Date.now();
      for (const t of store.match(filter)) {
        const typicalGap = t.rate > 0 ? 60_000 / t.rate : null;
        if (typicalGap && now - t.lastTs > Math.max(30_000, typicalGap * 5)) {
          findings.push({ topic: t.topic, kind: "stale", lastUpdate: iso(t.lastTs), silentSeconds: Math.round((now - t.lastTs) / 1000) });
        }
        const vals = store.values(t.topic, from, to);
        if (vals.length < 20) continue;
        const mean = vals.reduce((a, b) => a + b.value, 0) / vals.length;
        const std = Math.sqrt(vals.reduce((a, b) => a + (b.value - mean) ** 2, 0) / vals.length);
        if (std < 1e-9) continue;
        let peak = vals[0];
        for (const v of vals) if (Math.abs(v.value - mean) > Math.abs(peak.value - mean)) peak = v;
        const peakZ = (peak.value - mean) / std;
        const recent = vals.filter((v) => v.ts > to - 5 * 60_000);
        const recentMean = recent.length ? recent.reduce((a, b) => a + b.value, 0) / recent.length : mean;
        const shiftZ = (recentMean - mean) / std;
        if (Math.abs(peakZ) >= z_threshold || Math.abs(shiftZ) >= z_threshold / 2) {
          findings.push({
            topic: t.topic, kind: Math.abs(shiftZ) >= z_threshold / 2 ? "recent_shift" : "spike", unit: t.unit,
            windowMean: r(mean), windowStd: r(std), peak: r(peak.value), peakAt: iso(peak.ts), peakZ: r(peakZ, 2),
            last5MinMean: r(recentMean), shiftZ: r(shiftZ, 2),
          });
        }
      }
      findings.sort((a, b) => Math.abs(Number(b.peakZ ?? 99)) - Math.abs(Number(a.peakZ ?? 99)));
      return { from: iso(from), to: iso(to), count: findings.length, findings: findings.slice(0, 40) };
    },
  }),
  def({
    tool: {
      name: "show_chart",
      description:
        "Display an interactive line chart in the user's chat for up to 6 numeric topics over a window. Use whenever a trend or comparison would be clearer as a picture; the chart is drawn from the recorded history.",
      input_schema: {
        type: "object",
        properties: { title: { type: "string" }, topics: { type: "array", items: { type: "string" } }, ...windowProps },
        required: ["title", "topics"],
      },
    },
    schema: z.object({ title: z.string(), topics: z.array(z.string()).min(1).max(6), ...Window }),
    run: ({ title, topics, ...w }, { store, onChart }) => {
      const { from, to } = resolveWindow(w);
      const known = topics.filter((t) => store.topics.has(t));
      if (!known.length) throw new Error(`None of these topics exist: ${topics.join(", ")}`);
      onChart({ title, topics: known, from, to });
      return { shown: true, topics: known };
    },
  }),
];

export const tools: Anthropic.Tool[] = definitions.map((d) => d.tool);

/** Validates the model's input against the tool's schema, then runs it. */
export function runTool(name: string, input: unknown, ctx: ToolContext): { content: string; isError: boolean } {
  const d = definitions.find((x) => x.tool.name === name);
  if (!d) return { content: `Unknown tool ${name}`, isError: true };
  const parsed = d.schema.safeParse(input ?? {});
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true };
  try {
    return { content: JSON.stringify((d.run as (i: unknown, c: ToolContext) => unknown)(parsed.data, ctx)), isError: false };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
