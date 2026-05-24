import mqtt from "mqtt";
import type { EvChargingMqttConfig, EvChargingConfig } from "./config.ts";
import type { BrokerConfig } from "../config.ts";
import type { ChargingSession, WattsSource, WattsUpdate, HoldSource } from "./charger.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
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

    //log(`Connecting to MQTT broker at ${brokerUrl}...`);
    const client = mqtt.connect(brokerUrl, opts);

    client.once("connect", () => {
      //log("MQTT connected.");
      resolve(client);
    });
    client.once("error", (err) => {
      client.end();
      reject(err);
    });
  });
}

// Returns a ChargingSession that uses the provided MQTT client for charger commands
// and listens to power readings on the power topic.
export function makeMqttSession(
  client: MqttClient,
  mqttConfig: EvChargingMqttConfig,
  _publisher: StatusPublisher,
  _clock: Clock,
  holdWhenHeating?: EvChargingConfig["holdWhenHeating"],
  _plugInTimeoutMs?: number,
  getHoldThreshold?: () => number | null,
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
  // the lifetime of the session.
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
  client.subscribe(powerTopic, (err) => {
    if (err) log(`[MQTT] Failed to subscribe to ${powerTopic}: ${err}`);
  });

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
  // Also expose raw heating watts via heatingWattsSource for statistics tracking.
  let heatingHeld = false;
  const holdListeners: Array<(held: boolean) => void> = [];
  const heatingWattsListeners: Array<(u: WattsUpdate) => void> = [];
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

  const heatingWattsSource: WattsSource | undefined = holdWhenHeating
    ? {
        subscribe(cb) {
          heatingWattsListeners.push(cb);
          return () => {
            const i = heatingWattsListeners.indexOf(cb);
            if (i !== -1) heatingWattsListeners.splice(i, 1);
          };
        },
      }
    : undefined;

  if (holdWhenHeating) {
    const { powerTopic: heatingTopic, powerField: heatingField } = holdWhenHeating.mqtt;
    const heatingMsgHandler = (topic: string, message: Buffer) => {
      if (topic !== heatingTopic) return;
      const w = parseWatts(message, heatingField);
      if (w === null) return;
      for (const l of heatingWattsListeners) l({ watts: w });
      const threshold = getHoldThreshold?.() ?? null;
      const held = threshold !== null && w > threshold;
      if (held === heatingHeld) return;
      heatingHeld = held;
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
      client.unsubscribe(powerTopic);
      heatingCleanup?.();
      client.end();
    },
    driver,
    wattsSource,
    holdSource,
    heatingWattsSource,
  };
}
