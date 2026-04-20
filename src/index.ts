#!/usr/bin/env -S node --experimental-strip-types

// ─── Main ─────────────────────────────────────────────────────────────────────
//
// PROGRAM PLAN
// ============
//
// 1. START
//    - Connect to MQTT broker (configured host/port/credentials)
//    - Publish ON state to configured charger topic/payload
//    - TODO: mqttClient.publish(CONFIG.mqtt.topic, CONFIG.mqtt.onPayload)
//
// 2. TRIGGER (TODO: MQTT)
//    - Subscribe to configured MQTT topic(s) for trigger events
//    - Example trigger: power consumption on the charger relay crosses a threshold
//      meaning a car has been plugged in and is ready to charge
//    - On trigger received → cancel any running plan and re-plan immediately
//    - TODO: mqttClient.subscribe(CONFIG.mqtt.triggerTopic)
//    - TODO: mqttClient.on("message", (topic, payload) => { ... replan ... })
//
// 3. PLANNING  ← current implementation starts here
//    - Determine time window: now → next day at CONFIG.charging.targetTime
//    - Split window into 15-minute slots
//    - Fetch spot electricity prices for all slots (api.spot-hinta.fi)
//      - Prices are native 15-min slots, available for today + tomorrow
//      - Tomorrow's prices published ~14:15 EET; plan should run after that
//      - Add static transport cost (siirto + verot) to each slot
//    - Fetch solar production forecast for all slots (api.forecast.solar)
//      - Free public API, no key needed for single-plane estimate
//      - Params: lat, lon, roof declination, azimuth, installed kWp
//      - Returns watts per 15-min slot
//    - Compute effective price per slot:
//      - If solarForecastW >= freeThresholdW → effectivePrice = 0  (charging is "free")
//      - Otherwise → effectivePrice = spotPrice + transportCost
//    - Select cheapest N slots: slotsNeeded = ceil(targetKwh / (powerKw * 0.25h))
//    - FAIL FAST: abort loudly if any slot is missing data from either API
//
// 4. CHARGING
//    - Loop through all slots in chronological order
//    - At each slot boundary, send ON or OFF to the charger:
//      - TODO: mqttClient.publish(CONFIG.mqtt.topic,
//          slot.charge ? Config.mqtt.onPayload : Config.mqtt.offPayload)
//      - Currently: log message only
//    - Wait until slot ends, then advance to next slot
//
// 5. DONE → go back to step 1
//    - Re-plan for the next charging session
//    - On any error: log and retry after 60s
//
// MQTT NOTES
// ==========
// Recommended package: mqtt (npm i mqtt) — supports MQTT 3.1.1 and 5.0
// Config to add to CONFIG object:
//
//   mqtt: {
//     brokerUrl: "mqtt://homeassistant.local:1883",
//     username: "...",
//     password: "...",
//     chargerTopic: "zigbee2mqtt/ev-relay/set",
//     onPayload:  JSON.stringify({ state: "ON" }),
//     offPayload: JSON.stringify({ state: "OFF" }),
//     triggerTopic: "zigbee2mqtt/ev-relay",         // subscribe for power readings
//     triggerThresholdW: 100,                        // car plugged in if above this
//   }
//
// The NOUS D3Z DIN-rail relay (25A, Zigbee) via Zigbee2MQTT is the intended
// hardware target for the charger topic. Add new modes (timer, webhook, etc.)
// by implementing ChargingSession. The main loop in src/main-loop.ts does not
// need to change.

import { loadConfig } from "./config.ts";
import { IncompleteDataError } from "./errors.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./printer.ts";
import { makeSimulateSession } from "./charger.ts";
import { connectMqtt, makeMqttSession } from "./mqtt-client.ts";
import type { MqttClient } from "./mqtt-client.ts";
import { STATUS, createPublisher } from "./mqtt-status.ts";
import { log, makeClock } from "./utils.ts";
import { parseArgs } from "./parseArgs.ts";
import { runMainLoop, parseTargetTime } from "./main-loop.ts";


function errorStatus(err: unknown): string {
  if (err instanceof IncompleteDataError) {
    const m = err.message;
    if (m.includes("spot price")) return STATUS.waitingForSpot;
    if (m.includes("solar"))      return STATUS.waitingForSolar;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("spot-hinta"))                                                    return STATUS.waitingForSpot;
  if (msg.includes("solar") || msg.includes("open-meteo") || msg.includes("forecast.solar")) return STATUS.waitingForSolar;
  if (msg.toLowerCase().includes("mqtt"))                                            return STATUS.mqttError;
  return STATUS.error(msg);
}

async function main() {
  const config = loadConfig();
  const { mode, from: initialFrom } = parseArgs(config.mode);

  const modeLabel = mode === "charge" ? "charging" : mode;
  log(`=== EV Charger Planner [${modeLabel}] ===`);

  if (mode === "plan") {
    const targetTimeStr = config.charging.targetTime;
    const now = initialFrom ?? new Date();
    const targetDate = parseTargetTime(targetTimeStr, now);
    const slots = await plan(now, targetDate, config.charging.targetKwh, config);
    printPlan(slots);
    return;
  }

  // Connect to MQTT if configured (shared client for publisher + session)
  let mqttClient: MqttClient | undefined;
  if (config.mqtt) {
    try {
      mqttClient = await connectMqtt(config.mqtt);
    } catch (err) {
      if (mode === "charge") throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log(`MQTT unavailable, using logging publisher: ${msg}`);
    }
  }

  const publisher = createPublisher(config, mqttClient);
  const session = mode === "simulate"
    ? makeSimulateSession()
    : makeMqttSession(mqttClient!, config.mqtt!, publisher);

  const clock = makeClock(config.test?.timeSpeedupFactor ?? 1, initialFrom);
  await runMainLoop(session, publisher, config, initialFrom, errorStatus, clock);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}] Fatal: ${msg}`);
  process.exit(1);
});
