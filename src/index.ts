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
// hardware target for the charger topic. It also provides energy monitoring,
// which can be used to verify actual vs. planned charging and tune the plan.

import { CONFIG } from "./config.ts";
import { IncompleteDataError } from "./errors.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./printer.ts";
import { makeSimulateSession } from "./charger.ts";
import { makeMqttSession } from "./mqtt-client.ts";
import { STATUS, StatusPublisher, LoggingPublisher } from "./mqtt-status.ts";
import { log } from "./utils.ts";
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
  const { mode, from: initialFrom } = parseArgs();

  const modeLabel = mode === "charge" ? "charging" : mode;
  log(`=== EV Charger Planner [${modeLabel}] ===`);

  if (mode === "plan") {
    const targetTimeStr = CONFIG.charging.targetTime;
    const now = initialFrom ?? new Date();
    const targetDate = parseTargetTime(targetTimeStr, now);
    const slots = await plan(now, targetDate, CONFIG.charging.targetKwh);
    printPlan(slots);
    return;
  }

  // Create publisher: StatusPublisher (with async MQTT init) or LoggingPublisher
  const publisher = CONFIG.mqtt ? await StatusPublisher.create() : new LoggingPublisher();

  // Create session
  const session = mode === "simulate" ? makeSimulateSession() : await makeMqttSession(publisher);

  // Run main loop
  await runMainLoop(session, publisher, initialFrom, errorStatus);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}] Fatal: ${msg}`);
  process.exit(1);
});
