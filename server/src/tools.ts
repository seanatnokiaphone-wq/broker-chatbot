import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.js";
import type { RecorderStatus } from "./recorder.js";
import { RULES, spc, specFor } from "./spc.js";
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
      name: "check_sequence_gaps",
      description:
        "Find missed (dropped) messages using sequence numbers. Works on topics carrying a seq field, e.g. the filler counters at acme/dublin/packaging/+/filler/counts. Returns per topic how many messages were received vs missed, the loss %, and when each gap happened. Use for data quality, 'did we lose any data' or 'can I trust these counts' questions.",
      input_schema: {
        type: "object",
        properties: { filter: { type: "string", description: "Topic or MQTT filter (default: every topic with a sequence number)." }, ...windowProps, max_gaps: { type: "number", description: "Gaps to list per topic, most recent first (default 10)." } },
      },
    },
    schema: z.object({ filter: z.string().default("#"), ...Window, max_gaps: z.number().int().positive().max(100).default(10) }),
    run: ({ filter, max_gaps, ...w }, { store }) => {
      const { from, to } = resolveWindow(w);
      const seen = new Set<string>();
      const results = [];
      for (const t of store.match(filter)) {
        const seqTopic = store.seqTopic(t.topic);
        if (!seqTopic || seen.has(seqTopic)) continue;
        seen.add(seqTopic);
        const g = store.sequenceGaps(seqTopic, from, to)!;
        results.push({
          topic: seqTopic.replace(/\/[^/]+$/, ""), seqTopic, received: g.received, missed: g.missed, lossPct: r(g.lossPct, 2), restarts: g.restarts, gapCount: g.gaps.length,
          longestGap: g.gaps.length ? (() => { const x = g.gaps.reduce((a, b) => (b.missed > a.missed ? b : a)); return { at: iso(x.at), missed: x.missed, seconds: r((x.at - x.lastSeenAt) / 1000, 1) }; })() : null,
          recentGaps: g.gaps.slice(-max_gaps).reverse().map((x) => ({ at: iso(x.at), lastSeenAt: iso(x.lastSeenAt), afterSeq: x.afterSeq, nextSeq: x.nextSeq, missed: x.missed })),
        });
      }
      if (!results.length) return { from: iso(from), to: iso(to), note: "No topics with a sequence number match that filter." };
      results.sort((a, b) => b.missed - a.missed);
      return { from: iso(from), to: iso(to), topics: results };
    },
  }),
  def({
    tool: {
      name: "predict_network_drift",
      description:
        "Current network-drift prediction for each area (from the baseline predictor publishing <area>/network/prediction): status, drift risk %, latency now and 2-minute forecast, when the next drift is due, the reasons, and the predictor's own track record (drifts seen, predicted in advance, missed, false alarms, median warning lead time). Use for questions about network latency drift, whether a drift is coming, or how good the prediction is. For history of the risk, use get_history on <area>/network/prediction/drift_risk_pct.",
      input_schema: { type: "object", properties: { area: { type: "string", description: "Optional area name, e.g. packaging." } } },
    },
    schema: z.object({ area: z.string().optional() }),
    run: ({ area }, { store }) => {
      const preds = store.match("#").filter((t) => t.doc && t.topic.endsWith("/network/prediction") && (!area || t.topic.includes(`/${area}/`)));
      if (!preds.length) return { note: "No predictions yet. The predictor needs a minute or two of network data, and several drifts before its rhythm signal kicks in." };
      return {
        method: "baseline-v1: early-warning z-scores (jitter, packet loss, retransmits, throughput vs 30-min median/MAD), latency trend projected 2 min, and the learned drift rhythm, combined into one risk. Drift = latency above 5000 ms.",
        areas: preds.map((t) => {
          let doc: unknown = t.lastPayload;
          try { doc = JSON.parse(t.lastPayload); } catch {}
          return { topic: t.topic, updated: iso(t.lastTs), prediction: doc };
        }),
      };
    },
  }),
  def({
    tool: {
      name: "spc_analysis",
      description:
        "Statistical process control for numeric topics, e.g. acme/dublin/packaging/+/filler/fill_weight. Builds an X̄-R (default), X̄-S or I-MR chart over the window, with control limits, Western Electric rule violations (1: beyond 3σ, 2: 2 of 3 beyond 2σ, 3: 4 of 5 beyond 1σ, 4: 8 in a row one side, 5: 6 trending, 6: range above UCL) and capability (Cp, Cpk, Pp, Ppk, % out of spec) against spec limits. fill_weight has spec 495-505 g, target 500 g; pass lsl/usl/target for other tags. Use for SPC, 'is the process in control', capability or Cpk questions.",
      input_schema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Topic or MQTT filter." },
          chart: { type: "string", enum: ["xbar-r", "xbar-s", "imr"] },
          n: { type: "number", description: "Subgroup size 2-10 (default 5)." },
          every: { type: "number", description: "Seconds between subgroups (default 60; I-MR default 10)." },
          lsl: { type: "number" },
          usl: { type: "number" },
          target: { type: "number" },
          ...windowProps,
          max_violations: { type: "number", description: "Most recent violations to list per topic (default 10)." },
        },
        required: ["filter"],
      },
    },
    schema: z.object({
      filter: z.string(),
      chart: z.enum(["xbar-r", "xbar-s", "imr"]).default("xbar-r"),
      n: z.number().optional(),
      every: z.number().positive().optional(),
      lsl: z.number().optional(),
      usl: z.number().optional(),
      target: z.number().optional(),
      ...Window,
      max_violations: z.number().int().positive().max(50).default(10),
    }),
    run: ({ filter, chart, n, every, lsl, usl, target, max_violations, ...w }, { store }) => {
      const { from, to } = resolveWindow(w);
      const results = [];
      for (const t of store.match(filter).filter((x) => x.lastValue != null).slice(0, 12)) {
        const spec = specFor(t.topic);
        const res = spc(store.values(t.topic, from, to), { ...spec, chart, n, every, lsl: lsl ?? spec.lsl, usl: usl ?? spec.usl, target: target ?? spec.target });
        if (!res) {
          results.push({ topic: t.topic, note: "Too few readings in this window." });
          continue;
        }
        const c = res.capability;
        const byRule: Record<string, number> = {};
        for (const v of res.violations) byRule[`${v.rule}: ${v.text}`] = (byRule[`${v.rule}: ${v.text}`] ?? 0) + 1;
        results.push({
          topic: t.topic,
          unit: t.unit,
          chart: res.chart,
          subgroupSize: res.n,
          everySeconds: res.every,
          subgroups: res.points.length,
          status: res.violations.length ? "Out of control" : "In control",
          limits: { x: { cl: r(res.x.cl), ucl: r(res.x.ucl), lcl: r(res.x.lcl) }, [res.r.label]: { cl: r(res.r.cl), ucl: r(res.r.ucl), lcl: r(res.r.lcl) } },
          spec: { lsl: res.spec.lsl, target: res.spec.target, usl: res.spec.usl },
          capability: { mean: r(c.mean), sigmaWithin: r(c.sigmaWithin), sigmaOverall: r(c.sigmaOverall), cp: r(c.cp, 2), cpk: r(c.cpk, 2), pp: r(c.pp, 2), ppk: r(c.ppk, 2), outOfSpecPct: r(c.outOfSpecPct, 2), readings: c.readings },
          violationsByRule: byRule,
          recentViolations: res.violations.slice(-max_violations).reverse().map((v) => ({ at: iso(v.ts), rule: v.rule, text: v.text, value: r(res.points.find((p) => p.ts === v.ts)?.x) })),
        });
      }
      if (!results.length) return { note: "No numeric topics match that filter.", rules: RULES };
      return { from: iso(from), to: iso(to), topics: results };
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
