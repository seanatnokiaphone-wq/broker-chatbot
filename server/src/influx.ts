import { InfluxDB, Point, type WriteApi } from "@influxdata/influxdb-client";
import { config } from "./config.js";
import { parsePayload } from "./store.js";

export interface InfluxStatus {
  url: string;
  org: string;
  bucket: string;
  measurement: string;
  written: number;
  failedBatches: number;
  lastError?: string;
  lastWriteTs: number | null;
}

const LEVELS = ["enterprise", "site", "area", "line", "cell"];

/** Text state for payloads that aren't numeric, e.g. "Running" or {"value":"Running"}. */
function stateText(raw: string): string {
  const s = raw.trim();
  if (s[0] !== "{") return s;
  try {
    const o = JSON.parse(s);
    const v = o.value ?? o.Value ?? o.state ?? o.status;
    return v === undefined ? s : typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return s;
  }
}

/**
 * One point per MQTT message. The full topic and its ISA-95 levels (enterprise/site/area/line/cell, then the
 * last segment as `tag`) become Influx tags; numeric values go to the `value` field, anything else to `state`.
 */
export function toPoint(measurement: string, topic: string, payload: Buffer, ts = new Date()): Point {
  const raw = payload.toString("utf8");
  const parsed = parsePayload(raw);
  const parts = topic.split("/");
  const p = new Point(measurement).tag("topic", topic).timestamp(ts);
  parts.slice(0, -1).forEach((seg, i) => i < LEVELS.length && seg && p.tag(LEVELS[i], seg));
  if (parts.at(-1)) p.tag("tag", parts.at(-1)!);
  if (parsed.unit) p.tag("unit", parsed.unit);
  if (parsed.quality) p.tag("quality", parsed.quality);
  if (parsed.value != null && Number.isFinite(parsed.value)) p.floatField("value", parsed.value);
  else p.stringField("state", stateText(raw).slice(0, 1024));
  return p;
}

/** Optional InfluxDB 2.x sink. Returns null unless INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG and INFLUX_BUCKET are set. */
export function startInflux() {
  const { url, token, org, bucket, measurement } = config.influx;
  if (!url || !token || !org || !bucket) return null;

  const status: InfluxStatus = { url, org, bucket, measurement, written: 0, failedBatches: 0, lastWriteTs: null };
  const writeApi: WriteApi = new InfluxDB({ url, token }).getWriteApi(org, bucket, "ms", {
    batchSize: 5000,
    flushInterval: 1000,
    maxBufferLines: 50_000,
    maxRetries: 3,
    writeSuccess(lines) {
      status.written += lines.length;
      status.lastWriteTs = Date.now();
      status.lastError = undefined;
    },
    writeFailed(err, lines, attempt, expires) {
      status.lastError = err.message;
      if (attempt === 1) console.warn(`[influx] write of ${lines.length} points failed: ${err.message}`);
      // Let the client retry until it gives up, then count the batch as lost.
      if (attempt > 3 || Date.now() > expires) status.failedBatches++;
      return undefined;
    },
  });
  console.log(`[influx] writing to ${url} org=${org} bucket=${bucket} measurement=${measurement}`);

  return {
    status,
    write(topic: string, payload: Buffer) {
      try {
        writeApi.writePoint(toPoint(measurement, topic, payload));
      } catch (err) {
        status.lastError = (err as Error).message;
      }
    },
    close: () => writeApi.close().catch((err: Error) => console.warn(`[influx] close: ${err.message}`)),
  };
}

export type Influx = NonNullable<ReturnType<typeof startInflux>>;
