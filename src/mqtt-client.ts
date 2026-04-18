import mqtt from "mqtt";
import { CONFIG } from "./config.ts";
import type { ChargingSession } from "./charger.ts";
import { log } from "./utils.ts";

export type MqttClient = mqtt.MqttClient;

export async function connectMqtt(): Promise<MqttClient> {
  const { brokerUrl, username, password } = CONFIG.mqtt;
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
  const { powerTopic, powerField, powerThresholdW } = CONFIG.mqtt;
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
export function makeMqttSession(): ChargingSession {
  let client: MqttClient | undefined;
  const { chargerTopic, onPayload, offPayload } = CONFIG.mqtt;

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
      if (!client) client = await connectMqtt();
      try {
        await driver.send(true)
        await waitForPlugIn(client);
      } catch (err) {
        client.end();
        client = undefined;
        throw err;
      }
    },
    driver,
  };
}
