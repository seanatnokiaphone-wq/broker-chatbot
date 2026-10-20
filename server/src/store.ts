import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { mqttMatch } from "./mqttMatch.js";

export interface TopicInfo {
  topic: string;
  lastPayload: string;
  lastValue: number | null;
  unit?: string;
  quality?: string;
  lastTs: number;
  firstTs: number;
  count: number;
  /** Messages per minute, smoothed. */
  rate: number;
  retained: boolean;
}

export interface Parsed {
  value: number | null;
  unit?: string;
  quality?: string;
}

const MAX_PAYLOAD = 2048;

/** Pulls a numeric value (and unit/quality, if present) out of common payload shapes. */
export function parsePayload(raw: string): Parsed {
  const s = raw.trim();
  if (s === "") return { value: null };
  if (s === "true" || s === "false") return { value: s === "true" ? 1 : 0 };
  const n = Number(s);
  if (!Number.isNaN(n)) return { value: n };
  if (s[0] !== "{") return { value: null };
  try {
    const o = JSON.parse(s);
    const v = o.value ?? o.Value ?? o.v ?? o.val;
    const value = typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;
    return { value, unit: typeof o.unit === "string" ? o.unit : undefined, quality: typeof o.quality === "string" ? o.quality : undefined };
  } catch {
    return { value: null };
  }
}

/** The part of a payload that represents its state, ignoring timestamps and other metadata. */
function stateKey(raw: string): string {
  if (raw.trim()[0] !== "{") return raw;
  try {
    const o = JSON.parse(raw);
    const v = o.value ?? o.Value ?? o.state ?? o.status;
    return v === undefined ? raw : JSON.stringify(v);
  } catch {
    return raw;
  }
}

/**
 * Rolling history of every message seen on the broker.
 * SQLite holds the time series; the topic tree and throughput live in memory.
 */
export class Store {
  private db: Database.Database;
  private pending: [number, string, number | null, string][] = [];
  private insert: Database.Statement;
  readonly topics = new Map<string, TopicInfo>();
  private sinceTick = new Map<string, number>();
  /** Broker-wide messages per 5 s bucket. */
  readonly throughput: { ts: number; count: number }[] = [];
  private bucketCount = 0;
  totalMessages = 0;

  constructor(dbPath: string, private retentionMinutes: number) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, topic TEXT NOT NULL, value REAL, payload TEXT);
      CREATE INDEX IF NOT EXISTS samples_topic_ts ON samples(topic, ts);
      CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);
    `);
    this.insert = this.db.prepare("INSERT INTO samples (ts, topic, value, payload) VALUES (?, ?, ?, ?)");
    this.restoreTopics();
    setInterval(() => this.flush(), 250).unref();
    setInterval(() => this.tick(), 5000).unref();
    setInterval(() => this.prune(), 60_000).unref();
  }

  /** Rebuilds the topic tree from history so a restart doesn't start blank. */
  private restoreTopics() {
    const rows = this.db
      .prepare(
        `SELECT s.topic, s.ts, s.value, s.payload, agg.first, agg.n FROM samples s
         JOIN (SELECT topic, MAX(ts) AS last, MIN(ts) AS first, COUNT(*) AS n FROM samples GROUP BY topic) agg
         ON s.topic = agg.topic AND s.ts = agg.last`,
      )
      .all() as { topic: string; ts: number; value: number | null; payload: string; first: number; n: number }[];
    for (const r of rows) {
      const p = parsePayload(r.payload);
      this.topics.set(r.topic, {
        topic: r.topic, lastPayload: r.payload, lastValue: r.value, unit: p.unit, quality: p.quality,
        lastTs: r.ts, firstTs: r.first, count: r.n, rate: 0, retained: false,
      });
    }
  }

  record(topic: string, payload: Buffer, retained = false) {
    const ts = Date.now();
    const text = payload.toString("utf8").slice(0, MAX_PAYLOAD);
    const p = parsePayload(text);
    const info = this.topics.get(topic);
    if (info) {
      Object.assign(info, { lastPayload: text, lastValue: p.value, lastTs: ts, retained, count: info.count + 1 });
      if (p.unit) info.unit = p.unit;
      if (p.quality) info.quality = p.quality;
    } else {
      this.topics.set(topic, { topic, lastPayload: text, lastValue: p.value, unit: p.unit, quality: p.quality, lastTs: ts, firstTs: ts, count: 1, rate: 0, retained });
    }
    this.sinceTick.set(topic, (this.sinceTick.get(topic) ?? 0) + 1);
    this.pending.push([ts, topic, p.value, text]);
    this.bucketCount++;
    this.totalMessages++;
  }

  private flush() {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.db.transaction(() => {
      for (const row of batch) this.insert.run(...row);
    })();
  }

  private tick() {
    const now = Date.now();
    for (const info of this.topics.values()) {
      const perMin = ((this.sinceTick.get(info.topic) ?? 0) * 60) / 5;
      info.rate = info.rate === 0 ? perMin : info.rate * 0.7 + perMin * 0.3;
    }
    this.sinceTick.clear();
    this.throughput.push({ ts: now, count: this.bucketCount });
    this.bucketCount = 0;
    const cutoff = now - this.retentionMinutes * 60_000;
    while (this.throughput.length && this.throughput[0].ts < cutoff) this.throughput.shift();
  }

  private prune() {
    const cutoff = Date.now() - this.retentionMinutes * 60_000;
    this.db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
  }

  /** Messages per second across the broker, averaged over the last 15 s. */
  messagesPerSecond() {
    const last = this.throughput.slice(-3);
    if (!last.length) return 0;
    return last.reduce((a, b) => a + b.count, 0) / (last.length * 5);
  }

  oldestTs(): number | null {
    const r = this.db.prepare("SELECT MIN(ts) AS t FROM samples").get() as { t: number | null };
    return r.t;
  }

  match(filter: string): TopicInfo[] {
    return [...this.topics.values()].filter((t) => mqttMatch(filter, t.topic)).sort((a, b) => a.topic.localeCompare(b.topic));
  }

  /** Time-bucketed min/avg/max for a numeric topic. */
  history(topic: string, from: number, to: number, maxPoints = 120) {
    this.flush();
    const bucket = Math.max(1000, Math.ceil((to - from) / maxPoints));
    return this.db
      .prepare(
        `SELECT CAST(ts / @bucket AS INTEGER) * @bucket AS bucket_ts, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
         FROM samples WHERE topic = @topic AND ts BETWEEN @from AND @to AND value IS NOT NULL
         GROUP BY CAST(ts / @bucket AS INTEGER) ORDER BY bucket_ts`,
      )
      .all({ topic, from, to, bucket })
      .map((r) => {
        const { bucket_ts, ...rest } = r as { bucket_ts: number; avg: number; min: number; max: number; n: number };
        return { ts: bucket_ts, ...rest };
      });
  }

  /** Summary statistics for one topic over a window. */
  stats(topic: string, from: number, to: number) {
    this.flush();
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(value) AS numeric, MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg,
                AVG(value * value) AS avg2, MIN(ts) AS firstTs, MAX(ts) AS lastTs
         FROM samples WHERE topic = ? AND ts BETWEEN ? AND ?`,
      )
      .get(topic, from, to) as { n: number; numeric: number; min: number | null; max: number | null; avg: number | null; avg2: number | null; firstTs: number | null; lastTs: number | null };
    const edge = (order: "ASC" | "DESC") =>
      (this.db.prepare(`SELECT value FROM samples WHERE topic = ? AND ts BETWEEN ? AND ? AND value IS NOT NULL ORDER BY ts ${order} LIMIT 1`).get(topic, from, to) as { value: number } | undefined)?.value ?? null;
    const std = r.avg != null && r.avg2 != null ? Math.sqrt(Math.max(0, r.avg2 - r.avg * r.avg)) : null;
    return { count: r.n, numericCount: r.numeric, min: r.min, max: r.max, avg: r.avg, stddev: std, first: edge("ASC"), last: edge("DESC"), firstTs: r.firstTs, lastTs: r.lastTs };
  }

  /** Points where a topic's payload changed, for state/string topics. */
  changes(topic: string, from: number, to: number, limit = 100) {
    this.flush();
    const rows = this.db.prepare("SELECT ts, payload FROM samples WHERE topic = ? AND ts BETWEEN ? AND ? ORDER BY ts").all(topic, from, to) as { ts: number; payload: string }[];
    const out: { ts: number; payload: string }[] = [];
    let prev: string | undefined;
    for (const r of rows) {
      const key = stateKey(r.payload);
      if (key !== prev) out.push(r);
      prev = key;
    }
    return out.slice(-limit);
  }

  /** Values in a window, for anomaly checks. */
  values(topic: string, from: number, to: number) {
    this.flush();
    return this.db.prepare("SELECT ts, value FROM samples WHERE topic = ? AND ts BETWEEN ? AND ? AND value IS NOT NULL ORDER BY ts").all(topic, from, to) as { ts: number; value: number }[];
  }
}
