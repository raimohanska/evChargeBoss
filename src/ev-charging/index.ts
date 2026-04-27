import type { Config } from "../config.ts";
import { IncompleteDataError } from "../electricity/IncompleteDataError.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./print-plan.ts";
import { connectMqtt, makeMqttSession } from "./mqtt-client.ts";
import { STATUS, createPublisher } from "./mqtt-status.ts";
import { log } from "../utils/log.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { parseArgs } from "./parse-args.ts";
import { runSession, parseTargetTime } from "./main-loop.ts";
import { writeSessionSummary } from "../influx.ts";

function errorStatus(err: unknown): string {
  if (err instanceof IncompleteDataError) {
    const m = err.message;
    if (m.includes("spot price")) return STATUS.waitingForSpot;
    if (m.includes("solar")) return STATUS.waitingForSolar;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("spot-hinta")) return STATUS.waitingForSpot;
  if (msg.includes("solar") || msg.includes("open-meteo") || msg.includes("forecast.solar"))
    return STATUS.waitingForSolar;
  if (msg.toLowerCase().includes("mqtt")) return STATUS.mqttError;
  return STATUS.error(msg);
}

export async function runEvCharging(config: Config): Promise<void> {
  const { mode, from: initialFrom } = parseArgs(config.evCharging.mode);

  const modeLabel = mode === "charge" ? "charging" : mode;
  log(`=== EV Charger Planner [${modeLabel}] ===`);

  if (mode === "plan") {
    const targetTimeStr = config.evCharging.targetTime;
    const now = initialFrom ?? new Date();
    const targetDate = parseTargetTime(targetTimeStr, now);
    const slots = await plan(now, targetDate, config.evCharging.targetKwh, config);
    printPlan(slots);
    return;
  }

  if (!config.mqtt) {
    console.error("ERROR: charge mode requires mqtt (broker) to be configured in config.json");
    process.exit(1);
  }

  if (!config.evCharging.mqtt) {
    console.error("ERROR: charge mode requires evCharging.mqtt to be configured in config.json");
    process.exit(1);
  }

  const mqttClient = await connectMqtt(config.mqtt);
  const publisher = createPublisher(config.evCharging, mqttClient);
  const session = makeMqttSession(mqttClient, config.evCharging.mqtt, publisher);
  const clock = makeClock(config.test?.timeSpeedupFactor ?? 1, initialFrom);
  const onSessionEnd = config.influx
    ? (summary: Parameters<typeof writeSessionSummary>[1]) =>
        writeSessionSummary(config.influx!, summary)
    : undefined;

  // Charge loop: run sessions indefinitely, retrying on error.
  let from: Date | undefined = initialFrom;
  while (true) {
    if (from) log(`Planning from ${from.toISOString()}`);
    try {
      await runSession(session, publisher, config, from, clock, onSessionEnd);
      from = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}`);
      publisher.setError(errorStatus(err));
      log("Retrying in 60s...");
      await clock.sleep(60_000);
    }
  }
}
