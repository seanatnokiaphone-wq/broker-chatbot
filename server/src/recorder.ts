import mqtt from "mqtt";
import { brokerUrl, config } from "./config.js";
import type { Influx } from "./influx.js";
import type { Store } from "./store.js";

export interface RecorderStatus {
  url: string;
  connected: boolean;
  subscriptions: string[];
  since: number | null;
  lastError?: string;
}

/** Subscribes to the broker and writes every message into the store, and into InfluxDB when configured. */
export function startRecorder(store: Store, influx?: Influx | null) {
  const url = brokerUrl();
  const status: RecorderStatus = { url, connected: false, subscriptions: config.subscribe, since: null };
  const client = mqtt.connect(url, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    clientId: `broker-chatbot-recorder-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 2000,
  });

  client.on("connect", () => {
    status.connected = true;
    status.since = Date.now();
    status.lastError = undefined;
    client.subscribe(config.subscribe, { qos: 0 }, (err) => {
      if (err) status.lastError = err.message;
    });
    console.log(`[recorder] connected to ${url}, subscribed to ${config.subscribe.join(", ")}`);
  });
  client.on("close", () => (status.connected = false));
  client.on("error", (err) => {
    status.lastError = err.message;
    console.warn(`[recorder] ${err.message}`);
  });
  client.on("message", (topic, payload, packet) => {
    store.record(topic, payload, packet.retain);
    influx?.write(topic, payload);
  });

  return { status, client };
}
