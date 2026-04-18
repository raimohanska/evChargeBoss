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
//      - Returns watts per 15-min slot; multiply by efficiencyFactor (~0.85)
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

import { plan } from "./planner.ts";
import { printPlan } from "./printer.ts";
import { runCharging, simulateDriver } from "./charger.ts";
import { connectMqtt, waitForPlugIn, createMqttChargerDriver } from "./mqtt-client.ts";
import { log, sleep } from "./utils.ts";

type Mode = "charge" | "plan" | "simulate";

function parseArgs(): { mode: Mode; from?: Date } {
  const argv = process.argv.slice(2);

  const fromIdx = argv.indexOf("--from");
  let from: Date | undefined;
  if (fromIdx !== -1) {
    const raw = argv[fromIdx + 1];
    if (!raw) throw new Error("--from requires a value, e.g. --from 2026-04-18T08:00");
    from = new Date(raw);
    if (isNaN(from.getTime())) throw new Error(`--from: invalid date "${raw}"`);
  }

  let mode: Mode = "charge";
  if (argv.includes("--plan")) mode = "plan";
  else if (argv.includes("--simulate")) mode = "simulate";

  return { mode, from };
}

async function main() {
  const { mode, from: initialFrom } = parseArgs();

  const modeLabel = mode === "charge" ? "charging" : mode;
  log(`=== EV Charger Planner [${modeLabel}] ===`);

  if (mode === "plan") {
    const slots = await plan(initialFrom);
    printPlan(slots);
    return;
  }

  if (mode === "simulate") {
    let from = initialFrom;
    while (true) {
      if (from) log(`Planning from ${from.toISOString()}`);
      try {
        const slots = await plan(from);
        from = undefined;
        printPlan(slots);
        await runCharging(slots, simulateDriver);
      } catch (err) {
        log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
        log("Retrying in 60s...");
        await sleep(60_000);
      }
    }
  }

  // charge mode: connect to MQTT, wait for car plug-in, then plan and charge
  let mqttClient;
  while (true) {
    try {
      if (!mqttClient) mqttClient = await connectMqtt();
      const driver = createMqttChargerDriver(mqttClient);

      await waitForPlugIn(mqttClient);

      const slots = await plan();
      printPlan(slots);
      await runCharging(slots, driver);
    } catch (err) {
      log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      log("Retrying in 60s...");
      mqttClient = undefined; // reconnect on next iteration
      await sleep(60_000);
    }
  }
}

main();
