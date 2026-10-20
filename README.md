# broker-chatbot

Chat with a live MQTT broker. Ask questions about what's happening right now or over the last few hours, and explore the topic tree as a live graph.

- **Recorder** subscribes to the broker (`#` by default) and keeps a rolling history (3 hours by default) in SQLite, plus a live in-memory topic tree.
- **Chat assistant** uses Claude with tools over that data: overview, list topics, latest values, history, stats, state changes, anomaly scan, and inline charts.
- **Vite + React UI** with a force-directed topic graph (nodes pulse as messages arrive, alarms turn red), a tree explorer with trend charts over 15 min / 1 h / 3 h, and the chat panel.
- **Mock UNS generator** publishes 162 ISA-95 shaped tags (`acme/dublin/<area>/<line>/<cell>/<tag>`) across four packaging lines (each with filler, capper, labeler and palletizer), mixers, an oven, CIP and utilities, plus 12 nested JSON documents (including per-filler counters with sequence numbers), and per-area network health tags whose latency drifts every ~10 minutes, with a baseline predictor that forecasts the drift. Lines run state machines with OEE, and faults are injected every few minutes.

```
┌───────────────┐   MQTT    ┌──────────────────────────── server ─────────────────────────────┐
│ UNS simulator │──────────▶│ broker (embedded aedes, or yours) ─▶ recorder ─┬▶ SQLite (3 h)  │
└───────────────┘           │                                                └▶ InfluxDB (opt) │
                            │                                        │                         │
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

### Also storing to InfluxDB 2.x

SQLite keeps the rolling 3 hours the assistant reads from. To keep longer history for Grafana or Flux queries, the recorder can also write every message to InfluxDB 2.x:

```bash
docker compose up -d influxdb     # org "acme", bucket "uns" (30 day retention), token "broker-chatbot-dev-token"
cat >> .env <<'ENV'
INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=broker-chatbot-dev-token
INFLUX_ORG=acme
INFLUX_BUCKET=uns
ENV
npm run dev
```

Each message becomes one point in the `uns` measurement:

- **Tags:** `topic`, the ISA-95 levels from the path (`enterprise`, `site`, `area`, `line`, `cell`), the last segment as `tag`, plus `unit` and `quality` when the payload has them.
- **Fields:** `value` (float) for numeric and boolean payloads, otherwise `state` (string), e.g. `Running`.

```flux
from(bucket: "uns")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "uns" and r.line == "line1" and r.tag == "motor_temp")
  |> aggregateWindow(every: 1m, fn: mean)
```

Writes are batched (flushed every second, up to 50k points buffered with retries), so an Influx outage never blocks recording. Write counts and the last error show under `influx` in `/api/status`. Change the compose password and token before using it anywhere shared.

## Nested JSON payloads

Most tags publish the usual `{"value": 52.1, "unit": "°C", "quality": "GOOD", "timestamp": …}` envelope. Any other JSON object is treated as a document and split into one **field topic** per leaf, at `<document topic>/<json path>`:

```
acme/dublin/utilities/boiler/diagnostics   {"health": {"status": "OK", "score": 94.1}, "drum": {"pressure": {"value": 9.8, "unit": "bar"}}, …}
  …/diagnostics/health/status    "OK"       text field: state timeline, state changes
  …/diagnostics/health/score     94.1       numeric field: trend, stats, anomalies
  …/diagnostics/drum/pressure    9.8 bar    an inner {value, unit} object keeps its unit
```

Each field gets its own history, so it can be trended, searched, shown in the graph and tree (document branches are marked JSON), and queried in chat. Text fields chart as state timelines. `get_latest` on the document topic returns the whole document. The simulator publishes eight examples: an MES work order per packaging line, a batch record per mixer, a palletizer robot snapshot and boiler diagnostics.

## Sequence numbers and missed data

Each packaging line's filler publishes `acme/dublin/packaging/<line>/filler/counts` once a second:

```json
{"seq": 18234, "good_count": 40330, "reject_count": 162, "total_count": 40492, "state": "Filling", "timestamp": "…"}
```

The simulator loses some of these on purpose: about 1% at random, plus a network blip every 8 to 20 minutes that drops everything for 5 to 30 seconds. The counters and `seq` keep counting regardless, so every loss shows up as a jump in `seq`. The recorder finds those jumps. Trend cards for the counts (or their raw JSON) show how many messages were missed with red markers where each gap happened, `/api/gaps?topic=` returns the details, and the chat has a `check_sequence_gaps` tool ("Have we missed any filler counter messages in the last hour?"). A drop back to a lower `seq`, or a jump far too big for the time elapsed, is treated as a publisher restart rather than a loss.

## Network drift prediction

Each area (packaging, processing, utilities) publishes network health under `acme/dublin/<area>/network/`: `latency_ms` and `jitter_ms` every second, `packet_loss_pct` and `throughput_mbps` every 2 s, `retransmits_per_min` and `link_state` every 5 s. Latency normally sits around 2500 ms (0 to 5000), but roughly every 10 minutes it drifts out to about 9000 ms for a few minutes. Most drifts (85%) come with early-warning signs one to three minutes beforehand: jitter, packet loss and retransmits creep up and throughput sags.

`server/src/predictor.ts` (baseline-v1) runs every 5 s per area and combines three signals into a drift risk:

- **Early warning:** robust z-scores of jitter, loss, retransmits and throughput drop (last 30 s against the 30-minute median and MAD).
- **Trend:** the latency slope over 90 s, projected 2 minutes ahead.
- **Rhythm:** past drift onsets in the last hour give the typical period, so it knows when the next one is due.

It publishes `acme/dublin/<area>/network/prediction` (status Normal / Watch / Drift likely / Drifting, `drift_risk_pct`, `forecast_2m_ms`, `next_drift_due_s`, the reasons) and scores itself: drifts seen, predicted in advance (risk ≥ 60% within 10 minutes before onset), missed, false alarms and median lead time. Because it is an ordinary JSON document, the risk can be trended next to latency in the cards, and the chat has a `predict_network_drift` tool. Set `PREDICTOR=off` to disable it. In a 70-minute simulated run it flagged all 20 drifts with a median lead of 75 to 125 s and a few false alarms. It is a deliberately simple baseline to compare a trained model against.

The simulator's random faults (and the demo's **Inject fault** menu) include network incidents: a drift that starts immediately with no early warning, a packet-loss storm that looks like a precursor but never becomes a drift (a false-alarm test), and a packaging link outage during which the network tags go quiet, the prediction reports No data, and filler counter messages are lost.

## SPC charts

Any numeric trend card has an **SPC** button that swaps the trend for a control chart over the card's time window (zoom and pan still apply): X̄-R (default), X̄-S or I-MR. X̄ charts use rational subgroups of 5 readings taken each minute; I-MR takes one reading every 10 s. The chart shows UCL, CL and LCL, marks points that break the Western Electric rules (beyond 3σ, 2 of 3 beyond 2σ, 4 of 5 beyond 1σ, 8 on one side, 6 trending, and range above its UCL), and lists capability (Cp, Cpk, Ppk, % out of spec) when the tag has spec limits.

Filler `fill_weight` has spec 495 to 505 g with a 500 g target (set in `SPC_SPECS` in `server/src/spc.ts`; readings at 0 while the filler is stopped are ignored). It runs at σ ≈ 1 g, and every 12 to 30 minutes picks up a special cause: a step shift in the mean, a slow drift, or a burst of extra variation. `/api/spc?topic=&chart=` returns the chart data, and the chat has an `spc_analysis` tool ("Run SPC on the filler fill weights: are they in control, and what is the Cpk?").

## Things to ask

- "Give me an overview of what's on the broker"
- "Is anything abnormal in the last 30 minutes?"
- "When did packaging line 1 last go down, and for how long?"
- "Compare OEE for line 1 and line 2 over the last hour and chart it"
- "Which motors are running hottest right now?"
- "Is a network latency drift coming, and how well has it been predicted?"
- "Run SPC on the filler fill weights: are they in control, and what is the Cpk?"

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
| `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET` | | Also write every message to InfluxDB 2.x (all four required) |
| `INFLUX_MEASUREMENT` | `uns` | Influx measurement name |
| `PREDICTOR` | on | `off` disables the network-drift predictor |

## Layout

```
server/src
  index.ts          HTTP API, SSE chat endpoint, WebSocket live feed
  recorder.ts       MQTT subscriber → store
  store.ts          SQLite history, topic tree, throughput
  influx.ts         Optional InfluxDB 2.x writer
  tools.ts          Claude tool definitions and handlers
  chat.ts           Streaming tool-use loop
  broker.ts         Embedded aedes broker
  simulator/        Mock ISA-95 plant (162 tags + 12 JSON documents)
  predictor.ts      Baseline network-drift predictor
  spc.ts            SPC charts, Western Electric rules, capability
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

- At about 40 msg/s the mock plant writes roughly 430k rows per 3 hours, which SQLite handles comfortably. For much busier brokers, swap `store.ts` for TimescaleDB or the InfluxDB bucket; the tools only depend on its `history`, `stats`, `changes` and `values` methods.
- Payloads are parsed as plain numbers, booleans, or JSON with a `value` field (plus optional `unit` and `quality`). Anything else is stored as text and is still searchable through state changes and latest values.
