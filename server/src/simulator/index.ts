import mqtt from "mqtt";
import { brokerUrl, config } from "../config.js";
import { Plant } from "./model.js";

const plant = new Plant();
const url = brokerUrl();
const client = mqtt.connect(url, {
  username: config.mqttUsername,
  password: config.mqttPassword,
  clientId: `uns-simulator-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 2000,
});

console.log(`[sim] ${plant.tags.length} UNS topics, publishing to ${url}`);

const start = Date.now();
let timer: NodeJS.Timeout | undefined;
let first = true;

client.on("connect", () => {
  console.log("[sim] connected");
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    const t = Math.floor((now - start) / 1000);
    plant.tick(now);
    for (const tag of plant.tags) {
      if (!first && t % tag.every !== 0) continue;
      const payload = JSON.stringify({ value: tag.read(t), unit: tag.unit, quality: "GOOD", timestamp: new Date(now).toISOString() });
      // Retained state tags go at QoS 1: they matter more, and aedes drops QoS 0 retained publishes to live subscribers.
      client.publish(tag.topic, payload, { qos: tag.retain ? 1 : 0, retain: !!tag.retain });
    }
    first = false;
  }, 1000);
});
client.on("error", (err) => console.warn(`[sim] ${err.message}`));

process.on("SIGINT", () => {
  clearInterval(timer);
  client.end(false, () => process.exit(0));
});
