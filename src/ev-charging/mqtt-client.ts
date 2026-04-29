import mqtt from "mqtt";
import type { EvChargingMqttConfig } from "./config.ts";
import type { BrokerConfig } from "../config.ts";
import type { ChargingSession, WattsSource, WattsUpdate } from "./charger.ts";
import type { Publisher } from "./mqtt-status.ts";
import { log } from "../utils/log.ts";

export type MqttClient = mqtt.MqttClient;

export async function connectMqtt(brokerConfig: BrokerConfig): Promise<MqttClient> {
  const { brokerUrl, username, password } = brokerConfig;
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

async function waitForPlugIn(client: MqttClient, mqttConfig: EvChargingMqttConfig): Promise<void> {
  const { powerTopic, powerField, powerThresholdW } = mqttConfig;
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

// Returns a ChargingSession that uses the provided MQTT client for charger commands
// and listens to power readings on the power topic.
export function makeMqttSession(
  client: MqttClient,
  mqttConfig: EvChargingMqttConfig,
  _publisher: Publisher,
): ChargingSession {
  const { chargerTopic, onPayload, offPayload, powerTopic, powerField, energyField } = mqttConfig;

  // Persistent watts listeners — kept alive for the whole session
  const wattsListeners: Array<(u: WattsUpdate) => void> = [];

  const wattsSource: WattsSource = {
    subscribe(cb) {
      wattsListeners.push(cb);
      return () => {
        const i = wattsListeners.indexOf(cb);
        if (i !== -1) wattsListeners.splice(i, 1);
      };
    },
  };

  // Persistent MQTT handler — routes powerTopic messages to wattsListeners for
  // the lifetime of the session.  Registered here so it survives waitForStart().
  const msgHandler = (topic: string, message: Buffer) => {
    if (topic !== powerTopic) return;
    try {
      const data = JSON.parse(message.toString()) as Record<string, unknown>;
      const w = data[powerField];
      if (typeof w !== "number") return;
      const e = energyField ? data[energyField] : undefined;
      for (const l of wattsListeners)
        l({ watts: w, ...(typeof e === "number" && { energyKwh: e }) });
    } catch {
      // ignore malformed JSON
    }
  };
  client.on("message", msgHandler);

  const driver = {
    async send(on: boolean): Promise<void> {
      const payload = on ? onPayload : offPayload;
      return new Promise((resolve, reject) => {
        client.publish(chargerTopic, payload, (err) => {
          if (err) return reject(err);
          log(`[MQTT] -> ${on ? "ON " : "OFF"} published to ${chargerTopic}`);
          resolve();
        });
      });
    },
  };

  return {
    end() {
      client.off("message", msgHandler);
      client.end();
    },
    async waitForStart() {
      try {
        await driver.send(true);
        await waitForPlugIn(client, mqttConfig);
      } catch (err) {
        client.end();
        throw err;
      }
    },
    driver,
    wattsSource,
  };
}
