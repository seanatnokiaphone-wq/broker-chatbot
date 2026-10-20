import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { startEmbeddedBroker } from "./broker.js";
import { chat, resetSession, type ChatEvent } from "./chat.js";
import { config } from "./config.js";
import { startRecorder } from "./recorder.js";
import { Store, type TopicInfo } from "./store.js";

const embedded = config.mqttUrl ? null : await startEmbeddedBroker(config.embeddedPort);
const store = new Store(config.dbPath, config.retentionMinutes);
const recorder = startRecorder(store);

const app = express();
app.use(express.json());

const topicRow = (t: TopicInfo) => ({
  topic: t.topic, value: t.lastValue, payload: t.lastPayload.slice(0, 300), unit: t.unit,
  lastTs: t.lastTs, rate: Math.round(t.rate * 10) / 10, count: t.count,
});

app.get("/api/status", (_req, res) => {
  res.json({
    broker: recorder.status,
    embeddedBroker: embedded ? { clients: embedded.clients() } : null,
    topicCount: store.topics.size,
    messagesPerSecond: store.messagesPerSecond(),
    totalMessages: store.totalMessages,
    historyFrom: store.oldestTs(),
    retentionMinutes: config.retentionMinutes,
    model: config.model,
    chatEnabled: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  });
});

app.get("/api/topics", (_req, res) => {
  res.json([...store.topics.values()].map(topicRow));
});

app.get("/api/throughput", (_req, res) => {
  res.json(store.throughput);
});

app.get("/api/history", (req, res) => {
  const topics = ([] as string[]).concat((req.query.topic as string | string[]) ?? []);
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - Number(req.query.minutes ?? 60) * 60_000;
  const points = Math.min(1000, Number(req.query.points ?? 300));
  res.json(Object.fromEntries(topics.map((t) => [t, store.history(t, from, to, points)])));
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body as { sessionId?: string; message?: string };
  if (!sessionId || !message) {
    res.status(400).json({ error: "sessionId and message are required" });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const emit = (e: ChatEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await chat(sessionId, message, { store, recorder: recorder.status }, emit, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  res.end();
});

app.post("/api/chat/reset", (req, res) => {
  resetSession(String(req.body?.sessionId ?? ""));
  res.json({ ok: true });
});

// Serve the built frontend when it exists (npm run build && npm start).
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

const server = http.createServer(app);

// Live feed: a full snapshot on connect, then changed topics once a second.
const wss = new WebSocketServer({ server, path: "/ws" });
let lastPush = Date.now();
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", topics: [...store.topics.values()].map(topicRow), mps: store.messagesPerSecond(), ts: Date.now() }));
});
setInterval(() => {
  const since = lastPush;
  lastPush = Date.now();
  if (!wss.clients.size) return;
  const changed = [...store.topics.values()].filter((t) => t.lastTs > since).map(topicRow);
  const msg = JSON.stringify({ type: "update", topics: changed, mps: store.messagesPerSecond(), ts: lastPush });
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}, 1000).unref();

server.listen(config.port, () => {
  console.log(`[server] API on http://localhost:${config.port}, recording ${recorder.status.url}`);
});
