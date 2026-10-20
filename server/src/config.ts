const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8787),
  /** When unset, an embedded MQTT broker is started on embeddedPort and recorded instead. */
  mqttUrl: process.env.MQTT_URL || "",
  mqttUsername: process.env.MQTT_USERNAME || undefined,
  mqttPassword: process.env.MQTT_PASSWORD || undefined,
  subscribe: (process.env.MQTT_SUBSCRIBE || "#").split(",").map((s) => s.trim()).filter(Boolean),
  embeddedPort: num(process.env.EMBEDDED_BROKER_PORT, 1883),
  retentionMinutes: num(process.env.RETENTION_MINUTES, 180),
  dbPath: process.env.DB_PATH || "../data/history.db",
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
};

export const brokerUrl = () => config.mqttUrl || `mqtt://localhost:${config.embeddedPort}`;
