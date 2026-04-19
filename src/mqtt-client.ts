import mqtt from "mqtt";
import { CONFIG } from "./config.ts";
import type { ChargingSession, WattsSource } from "./charger.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
import { log } from "./utils.ts";

export type MqttClient = mqtt.MqttClient;

export async function connectMqtt(): Promise<MqttClient> {
  const { brokerUrl, username, password } = CONFIG.mqtt!;
  return new Promise((resolve, reject) => {
    const opts: mqtt.IClientOptions = {};
    if (username) opts.username = username;
    if (password) opts.password = password;

    log(`Connecting to MQTT broker at ${brokerUrl}...`);
    const client = mqtt.connect(brokerUrl, opts);

    client.once("connect", () => {
      log("MQTT connected.");
      resolve(client);
    });
    client.once("error", (err) => {
      client.end();
      reject(err);
    });
  });
}

async function waitForPlugIn(client: MqttClient): Promise<void> {
  const { powerTopic, powerField, powerThresholdW } = CONFIG.mqtt!;
  log(`Waiting for car plug-in (${powerTopic}.${powerField} > ${powerThresholdW} W)...`);

  return new Promise((resolve, reject) => {
    function onMessage(topic: string, message: Buffer) {
      if (topic !== powerTopic) return;
      try {
        const data = JSON.parse(message.toString()) as Record<string, unknown>;
        const watts = data[powerField];
        if (typeof watts === "number" && watts > powerThresholdW) {
          log(`Car detected: ${watts} W on ${topic} — starting plan`);
          client.off("message", onMessage);
          client.off("error", onError);
          resolve();
        }
      } catch (err) {
        log(`MQTT parse error on ${topic}: ${err}`);
      }
    }

    function onError(err: Error) {
      client.off("message", onMessage);
      reject(err);
    }

    client.on("message", onMessage);
    client.once("error", onError);
    client.subscribe(powerTopic, (err) => {
      if (err) reject(err);
    });
  });
}

// Returns a ChargingSession that connects to the broker once, then for each
// session waits until the power topic reports watts above the threshold
// (car plugged in), reconnecting automatically after any error.
export function makeMqttSession(publisher?: StatusPublisher): ChargingSession {
  if (!CONFIG.mqtt) throw new Error("mqtt config is required for charge mode");
  let client: MqttClient | undefined;
  const { chargerTopic, onPayload, offPayload, powerTopic, powerField } = CONFIG.mqtt;

  // Persistent watts listeners — kept alive for the whole session
  const wattsListeners: Array<(w: number) => void> = [];

  const wattsSource: WattsSource = {
    subscribe(cb) {
      wattsListeners.push(cb);
      return () => {
        const i = wattsListeners.indexOf(cb);
        if (i !== -1) wattsListeners.splice(i, 1);
      };
    },
  };

  const driver = {
    async send(on: boolean): Promise<void> {
      const payload = on ? onPayload : offPayload;
      return new Promise((resolve, reject) => {
        client!.publish(chargerTopic, payload, (err) => {
          if (err) return reject(err);
          log(`[MQTT] → ${on ? "ON " : "OFF"} published to ${chargerTopic}`);
          resolve();
        });
      });
    },
  };

  return {
    async waitForStart() {
      if (!client) {
        client = await connectMqtt();
        publisher?.setClient(client);
        // Forward all power-topic readings to watts listeners
        client.on("message", (topic: string, message: Buffer) => {
          if (topic !== powerTopic) return;
          try {
            const data = JSON.parse(message.toString()) as Record<string, unknown>;
            const w = data[powerField];
            if (typeof w === "number") {
              for (const l of wattsListeners) l(w);
            }
          } catch {}
        });
      }
      try {
        await driver.send(true);
        await waitForPlugIn(client);
      } catch (err) {
        client.end();
        client = undefined;
        throw err;
      }
    },
    driver,
    wattsSource,
  };
}
