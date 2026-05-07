#!/usr/bin/env -S node --experimental-strip-types

// ─── Main ─────────────────────────────────────────────────────────────────────
//
// HOW IT WORKS
// ============
//
// 1. WAIT FOR CAR
//    - Connect to the MQTT broker (config.mqtt: brokerUrl, username, password)
//    - Subscribe to evCharging.mqtt.powerTopic and wait for power to exceed
//      evCharging.mqtt.powerThresholdW — this signals a car has been plugged in
//
// 2. PLANNING
//    - Determine time window: now → evCharging.targetTime (next occurrence)
//    - Split window into 15-minute slots
//    - Fetch spot electricity prices for all slots (api.spot-hinta.fi)
//      - Prices are native 15-min slots, available for today + tomorrow
//      - Tomorrow's prices published ~14:15 EET; plan should run after that
//      - Add static transport cost (electricity.transportCostEurKwh) to each slot
//    - Fetch solar production forecast for all slots (api.forecast.solar or Open-Meteo)
//      - Params come from config.solar (lat, lon, declination, azimuth, kwp)
//      - Returns watts per 15-min slot
//    - Compute effective price per slot:
//      - Fraction of slot not covered by solar × (spotPrice + transportCost)
//    - Select cheapest N slots: slotsNeeded = ceil(targetKwh / (powerKw × 0.25 h))
//    - Missing data → IncompleteDataError; retry after 60 s
//
// 3. CHARGING
//    - Loop through slots in chronological order
//    - Send ON/OFF to evCharging.mqtt.chargerTopic at each slot boundary
//    - If evCharging.mqtt.energyField is set, track charged kWh from live readings;
//      otherwise accumulate based on powerKw × elapsed time
//    - Target-time changes (via MQTT text entity) trigger an immediate replan
//
// 4. DONE → go back to step 1
//    - Re-plan for the next charging session
//    - On any error: log and retry after 60 s
//
// CONFIG SHAPE
// ============
//
//   mqtt:        { brokerUrl, username, password }         ← broker credentials
//   evCharging:  { mode, targetKwh, powerKw, targetTime,
//                  mqtt: { powerTopic, powerField, powerThresholdW,
//                          energyField?,
//                          chargerTopic, onPayload, offPayload } }
//   solar:       { lat, lon, declination, azimuth, kwp, treeShadingSchedule }
//   electricity: { transportCostEurKwh }
//   test?:       { timeSpeedupFactor? }
//
// Add new trigger/charging modes by implementing ChargingSession (src/ev-charging/charger.ts).
// The main loop in src/ev-charging/main-loop.ts does not need to change.

import { loadConfig, getConfigPath } from "./config.ts";
import { runEvCharging } from "./ev-charging/index.ts";
import { runSetpointControl } from "./setpoint-control/index.ts";
import { runMqttToInflux } from "./mqtt-to-influx/index.ts";
import { runElectricityPoller } from "./electricity/poller.ts";

const configPath = getConfigPath();
const config = loadConfig();

const loops: Promise<void>[] = [runEvCharging(config)];
for (const [id, spConfig] of Object.entries(config.setpointControl ?? {}))
  loops.push(runSetpointControl(id, spConfig, config, configPath));
if (config.mqttToInflux) loops.push(runMqttToInflux(config));
if (config.influx) loops.push(runElectricityPoller(config));

Promise.all(loops).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}] Fatal: ${msg}`);
  process.exit(1);
});
