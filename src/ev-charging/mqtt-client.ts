import mqtt from "mqtt";
import type { EvChargingMqttConfig, EvChargingConfig } from "./config.ts";
import type { BrokerConfig } from "../config.ts";
import type {
  ChargingSession,
  WattsSource,
  WattsUpdate,
  HoldSource,
  ChargeLevelSource,
} from "./charger.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
import type { Clock } from "../utils/timing-utils.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("ev-charging");

export type MqttClient = mqtt.MqttClient;

// Parse a numeric value (integer or decimal) from an MQTT message payload.
// When field is defined the payload is expected to be JSON; otherwise a plain number string.
function parseNumericField(message: Buffer, field: string | undefined): number | null {
  try {
    if (field !== undefined) {
      const data = JSON.parse(message.toString()) as Record<string, unknown>;
      const v = data[field];
      return typeof v === "number" ? v : null;
    } else {
      const v = Number(message.toString());
      return isNaN(v) ? null : v;
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

      // Connection lifecycle logging (post-connection)
      let wasConnected = true;
      client.on("offline", () => log("MQTT offline"));
      client.on("reconnect", () => log("MQTT reconnecting..."));
      client.on("connect", () => {
        if (wasConnected) return;
        wasConnected = true;
        log("MQTT reconnected");
      });
      client.on("error", (err) => log(`MQTT error: ${err.message}`));
      client.on("close", () => {
        wasConnected = false;
        log("MQTT connection closed");
      });

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
      const w = parseNumericField(message, heatingField);
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

  // Charge level: optional subscription to car's state of charge (%).
  // Store the latest value so new subscribers get it immediately.
  let latestChargeLevel: number | undefined;
  const chargeLevelListeners: Array<(pct: number) => void> = [];
  let chargeLevelCleanup: (() => void) | undefined;

  const chargeLevelSource: ChargeLevelSource | undefined = mqttConfig.chargeLevelTopic
    ? {
        subscribe(cb) {
          if (latestChargeLevel !== undefined) {
            cb(latestChargeLevel); // emit current value immediately
          }
          chargeLevelListeners.push(cb);
          return () => {
            const i = chargeLevelListeners.indexOf(cb);
            if (i !== -1) chargeLevelListeners.splice(i, 1);
          };
        },
      }
    : undefined;

  if (mqttConfig.chargeLevelTopic) {
    const chargeLevelTopic = mqttConfig.chargeLevelTopic;
    const chargeLevelField = mqttConfig.chargeLevelField;
    log(
      `[CHARGE_LEVEL] Subscribing to ${chargeLevelTopic}${chargeLevelField ? ` (field: ${chargeLevelField})` : ""}`,
    );
    const chargeLevelMsgHandler = (topic: string, message: Buffer) => {
      if (topic !== chargeLevelTopic) return;
      const pct = parseNumericField(message, chargeLevelField);
      if (pct === null) {
        log(`[CHARGE_LEVEL] Received invalid message: ${message.toString().slice(0, 100)}`);
        return;
      }
      if (pct < 0 || pct > 100) {
        log(`[CHARGE_LEVEL] Received out-of-range value: ${pct}%`);
        return;
      }
      log(`[CHARGE_LEVEL] Received: ${pct}%`);
      latestChargeLevel = pct;
      for (const l of chargeLevelListeners) l(pct);
    };
    client.on("message", chargeLevelMsgHandler);
    client.subscribe(chargeLevelTopic, (err) => {
      if (err) log(`[CHARGE_LEVEL] Failed to subscribe to ${chargeLevelTopic}: ${err}`);
    });
    chargeLevelCleanup = () => {
      client.off("message", chargeLevelMsgHandler);
      client.unsubscribe(chargeLevelTopic);
    };
  }

  return {
    end() {
      client.off("message", msgHandler);
      client.unsubscribe(powerTopic);
      heatingCleanup?.();
      chargeLevelCleanup?.();
      client.end();
    },
    driver,
    wattsSource,
    holdSource,
    heatingWattsSource,
    chargeLevelSource,
  };
}
