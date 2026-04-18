import mqtt from "mqtt";
import { CONFIG } from "./config.ts";
import type { ChargerDriver } from "./charger.ts";
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

export async function waitForPlugIn(client: MqttClient): Promise<void> {
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

export function createMqttChargerDriver(client: MqttClient): ChargerDriver {
  const { chargerTopic, onPayload, offPayload } = CONFIG.mqtt;
  return {
    async send(on: boolean) {
      const payload = on ? onPayload : offPayload;
      return new Promise((resolve, reject) => {
        client.publish(chargerTopic, payload, (err) => {
          if (err) return reject(err);
          log(`[MQTT] → ${on ? "ON " : "OFF"} published to ${chargerTopic}`);
          resolve();
        });
      });
    },
  };
}
