# broker-chatbot

Chat with a live MQTT broker. Ask questions about what's happening right now or over the last few hours, and explore the topic tree as a live graph.

- **Recorder** subscribes to the broker (`#` by default) and keeps a rolling history (3 hours by default) in SQLite, plus a live in-memory topic tree.
- **Chat assistant** uses Claude with tools over that data: overview, list topics, latest values, history, stats, state changes, anomaly scan, and inline charts.
- **Vite + React UI** with a force-directed topic graph (nodes pulse as messages arrive, alarms turn red), a tree explorer with trend charts over 15 min / 1 h / 3 h, and the chat panel.
- **Mock UNS generator** publishes 100 ISA-95 shaped topics (`acme/dublin/<area>/<line>/<cell>/<tag>`) with line state machines, OEE, batches, utilities and injected faults every few minutes.

```
┌───────────────┐   MQTT    ┌──────────────────────────── server ─────────────────────────────┐
│ UNS simulator │──────────▶│ broker (embedded aedes, or yours) ─▶ recorder ─▶ SQLite (3 h)   │
└───────────────┘           │                                        │                         │
                            │                     REST + WebSocket ◀─┴─▶ Claude tool loop      │
                            └──────────────────────────────┬──────────────────────────────────┘
                                                           ▼
                                           Vite UI: topic graph · explorer · chat
```

## Quick start

Requires Node 22+.

```bash
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm install
npm run dev                 # server + simulator + UI
```

Open http://localhost:5173. With no `MQTT_URL` set, the server starts an embedded broker on port 1883 and the simulator publishes into it, so nothing else is needed.

### Using a real broker

Set `MQTT_URL` (and `MQTT_USERNAME` / `MQTT_PASSWORD` if needed) in `.env`, then run `npm run dev:nosim` to skip the mock data. `MQTT_SUBSCRIBE` takes a comma-separated list of filters if you don't want everything.

To run Mosquitto locally instead of the embedded broker:

```bash
docker compose up -d
echo "MQTT_URL=mqtt://localhost:1883" >> .env
npm run dev
```

## Things to ask

- "Give me an overview of what's on the broker"
- "Is anything abnormal in the last 30 minutes?"
- "When did packaging line 1 last go down, and for how long?"
- "Compare OEE for line 1 and line 2 over the last hour and chart it"
- "Which motors are running hottest right now?"

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Enables the chat assistant |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used by the assistant |
| `MQTT_URL` | embedded broker | Broker to record |
| `MQTT_SUBSCRIBE` | `#` | Topic filters to record |
| `RETENTION_MINUTES` | `180` | How much history to keep |
| `PORT` | `8787` | API port (Vite proxies `/api` and `/ws` to it) |
| `DB_PATH` | `../data/history.db` | SQLite file, relative to `server/` |

## Layout

```
server/src
  index.ts          HTTP API, SSE chat endpoint, WebSocket live feed
  recorder.ts       MQTT subscriber → store
  store.ts          SQLite history, topic tree, throughput
  tools.ts          Claude tool definitions and handlers
  chat.ts           Streaming tool-use loop
  broker.ts         Embedded aedes broker
  simulator/        Mock ISA-95 plant (100 topics)
web/src
  App.tsx           Layout, status bar, topic detail
  components/       TopicGraph, Explorer, HistoryChart, Chat
  useLive.ts        WebSocket live feed hook
```

## Browser-only demo

`demo/broker-demo.html` is a self-contained version that runs the simulator, history, graph, trends and chat entirely in the browser (published as a claude.ai artifact, where the chat uses the viewer's own Claude access). It only shows mock data.

## Production build

```bash
npm run build
npm start -w server   # serves the built UI from web/dist on PORT
```

## Notes

- At about 40 msg/s the mock plant writes roughly 430k rows per 3 hours, which SQLite handles comfortably. For much busier brokers, swap `store.ts` for TimescaleDB or InfluxDB; the tools only depend on its `history`, `stats`, `changes` and `values` methods.
- Payloads are parsed as plain numbers, booleans, or JSON with a `value` field (plus optional `unit` and `quality`). Anything else is stored as text and is still searchable through state changes and latest values.
