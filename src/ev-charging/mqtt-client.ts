import mqtt from "mqtt";
import type { EvChargingMqttConfig, EvChargingConfig } from "./config.ts";
import type { BrokerConfig } from "../config.ts";
import type { ChargingSession, WattsSource, WattsUpdate, HoldSource } from "./charger.ts";
import type { Publisher } from "./mqtt-status.ts";
import type { Clock } from "../utils/timing-utils.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("ev-charging");

export type MqttClient = mqtt.MqttClient;

// Parse a power reading from an MQTT message payload.
// When powerField is defined the payload is expected to be JSON; otherwise a plain number string.
function parseWatts(message: Buffer, powerField: string | undefined): number | null {
  try {
    if (powerField !== undefined) {
      const data = JSON.parse(message.toString()) as Record<string, unknown>;
      const w = data[powerField];
      return typeof w === "number" ? w : null;
    } else {
      const w = Number(message.toString());
      return isNaN(w) ? null : w;
    }
  } catch {
    return null;
  }
}

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

async function waitForPlugIn(
  client: MqttClient,
  mqttConfig: EvChargingMqttConfig,
): Promise<number> {
  const { powerTopic, powerField, powerThresholdW } = mqttConfig;
  const topicLabel = powerField ? `${powerTopic}.${powerField}` : powerTopic;
  log(`Waiting for car plug-in (${topicLabel} > ${powerThresholdW} W)...`);

  return new Promise((resolve, reject) => {
    function onMessage(topic: string, message: Buffer) {
      if (topic !== powerTopic) return;
      try {
        const watts = parseWatts(message, powerField);
        if (watts !== null && watts > powerThresholdW) {
          log(`Car detected: ${watts} W on ${topic}`);
          client.off("message", onMessage);
          client.off("error", onError);
          resolve(watts);
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
// clock is used to run the 15-second power-detection window at the correct speed.
export function makeMqttSession(
  client: MqttClient,
  mqttConfig: EvChargingMqttConfig,
  _publisher: Publisher,
  clock: Clock,
  holdWhenHeating?: EvChargingConfig["holdWhenHeating"],
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
      let w: number | null = null;
      let e: number | undefined;
      if (powerField !== undefined) {
        const data = JSON.parse(message.toString()) as Record<string, unknown>;
        const raw = data[powerField];
        if (typeof raw !== "number") return;
        w = raw;
        if (energyField !== undefined) {
          const eRaw = data[energyField];
          if (typeof eRaw === "number") e = eRaw;
        }
      } else {
        w = Number(message.toString());
        if (isNaN(w)) return;
      }
      for (const l of wattsListeners) l({ watts: w, ...(e !== undefined && { energyKwh: e }) });
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

  // Heating hold: when holdWhenHeating is configured, track heating power and
  // notify holdListeners whenever the held state changes.
  let heatingHeld = false;
  const holdListeners: Array<(held: boolean) => void> = [];
  let heatingCleanup: (() => void) | undefined;

  const holdSource: HoldSource | undefined = holdWhenHeating
    ? {
        subscribe(cb) {
          cb(heatingHeld); // emit current state immediately
          holdListeners.push(cb);
          return () => {
            const i = holdListeners.indexOf(cb);
            if (i !== -1) holdListeners.splice(i, 1);
          };
        },
      }
    : undefined;

  if (holdWhenHeating) {
    const { powerTopic: heatingTopic, powerField: heatingField } = holdWhenHeating.mqtt;
    const { thresholdW } = holdWhenHeating;
    const heatingMsgHandler = (topic: string, message: Buffer) => {
      if (topic !== heatingTopic) return;
      const w = parseWatts(message, heatingField);
      if (w === null) return;
      const held = w > thresholdW;
      if (held === heatingHeld) return;
      heatingHeld = held;
      log(`[HOLD] Heating power ${w} W — charging ${held ? "paused" : "resumed"}`);
      for (const l of holdListeners) l(held);
    };
    client.on("message", heatingMsgHandler);
    client.subscribe(heatingTopic, (err) => {
      if (err) log(`[HOLD] Failed to subscribe to ${heatingTopic}: ${err}`);
    });
    heatingCleanup = () => {
      client.off("message", heatingMsgHandler);
      client.unsubscribe(heatingTopic);
    };
  }

  return {
    end() {
      client.off("message", msgHandler);
      heatingCleanup?.();
      client.end();
    },
    async waitForStart(): Promise<number> {
      try {
        await driver.send(true);
        const initialWatts = await waitForPlugIn(client, mqttConfig);
        // Measure charging power for 15 virtual seconds to get a stable reading.
        // The initial detection reading is always included as a seed.
        const readings: number[] = [initialWatts];
        const unsub = wattsSource.subscribe(({ watts }) => {
          if (watts > 0) readings.push(watts);
        });
        await clock.sleep(15_000);
        unsub();
        const maxW = Math.max(...readings);
        const powerKw = maxW / 1000;
        log(
          `Detected charging power: ${powerKw.toFixed(2)} kW (max of ${readings.length} samples)`,
        );
        return powerKw;
      } catch (err) {
        client.end();
        throw err;
      }
    },
    driver,
    wattsSource,
    holdSource,
  };
}
