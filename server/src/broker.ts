import { createServer } from "node:net";
import { Aedes } from "aedes";

/** Starts an in-process MQTT broker so the app and simulator run without Mosquitto. */
export async function startEmbeddedBroker(port: number) {
  const aedes = await Aedes.createBroker();
  const server = createServer(aedes.handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  console.log(`[broker] embedded MQTT broker listening on mqtt://localhost:${port}`);
  return {
    clients: () => aedes.connectedClients,
    close: () => new Promise<void>((r) => server.close(() => aedes.close(() => r()))),
  };
}
