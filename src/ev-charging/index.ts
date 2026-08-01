import type { Config } from "../config.ts";
import { IncompleteDataError } from "../electricity/IncompleteDataError.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./print-plan.ts";
import { connectMqtt, makeMqttSession } from "./mqtt-client.ts";
import { StatusPublisher } from "./mqtt-status.ts";
import { makeLogger } from "../utils/log.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { parseArgs } from "./parse-args.ts";
import { runSession } from "./coordinator.ts";
import { resolveTargetTime } from "./helpers.ts";
import { writeSessionSummary, checkInfluxHealth } from "../influx.ts";
import { HeatingTracker, loadHeatingStatistics } from "./heating-tracker.ts";

const log = makeLogger("ev-charging");

function errorStatus(err: unknown): string {
  if (err instanceof IncompleteDataError) {
    const m = err.message;
    if (m.includes("spot price")) return "Waiting for spot prices";
    if (m.includes("solar")) return "Waiting for solar forecast";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("spot-hinta")) return "Waiting for spot prices";
  if (msg.includes("solar") || msg.includes("open-meteo") || msg.includes("forecast.solar"))
    return "Waiting for solar forecast";
  if (msg.toLowerCase().includes("mqtt")) return "MQTT connection error";
  return msg;
}

export async function runEvCharging(config: Config, configPath?: string): Promise<void> {
  const { mode } = parseArgs(config.evCharging.mode);
  if (mode === "plan") {
    const powerKw = config.evCharging.powerKw;
    if (!powerKw) {
      console.error(
        "ERROR: plan mode requires evCharging.powerKw to be set in config (charge mode detects it automatically)",
      );
      process.exit(1);
    }
    const targetTimeStr = config.evCharging.targetTime;
    const now = new Date();
    const targetDate = resolveTargetTime(targetTimeStr, config.evCharging.weeklySchedule, now);
    const persistedStats = loadHeatingStatistics();
    const effectivePowerKw =
      config.evCharging.holdWhenHeating && persistedStats
        ? powerKw * persistedStats.powerHoldFactor
        : powerKw;
    if (effectivePowerKw !== powerKw) {
      log(
        `Applying holdFactor=${persistedStats!.powerHoldFactor.toFixed(3)} -> effective powerKw=${effectivePowerKw.toFixed(3)} kW`,
      );
    }
    const slots = await plan(
      now,
      targetDate,
      config.evCharging.targetKwh,
      effectivePowerKw,
      config,
    );
    printPlan(slots, {
      powerKw: effectivePowerKw,
      targetTime: targetDate,
      targetKwh: config.evCharging.targetKwh,
      chargedKwh: 0,
    });
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
  const publisher = new StatusPublisher(mqttClient, config.evCharging, configPath);
  // Wait for the broker to deliver any retained target-time, target-kWh, and
  // per-day schedule state before planning, so they survive a restart.
  await publisher.waitForInitialTargetTime(2000);
  await publisher.waitForInitialTargetKwh(2000);
  await publisher.waitForInitialWeeklySchedule(2000);
  const clock = makeClock(config.test?.timeSpeedupFactor ?? 1);

  // Declare tracker before makeMqttSession so the getHoldThreshold closure can
  // reference it — tracker is assigned synchronously after the MQTT session is
  // created, before any MQTT messages are processed.
  let tracker: HeatingTracker | null = null;
  const holdWhenHeating = config.evCharging.holdWhenHeating;
  const getHoldThreshold: (() => number | null) | undefined = holdWhenHeating
    ? () => tracker?.getLatest()?.powerHoldThreshold ?? null
    : undefined;

  const session = makeMqttSession(
    mqttClient,
    config.evCharging.mqtt,
    publisher,
    clock,
    holdWhenHeating,
    config.evCharging.plugInTimeoutMs,
    getHoldThreshold,
  );

  if (config.influx) await checkInfluxHealth(config.influx);

  const onSessionEnd = config.influx
    ? (summary: Parameters<typeof writeSessionSummary>[1]) =>
        writeSessionSummary(config.influx!, summary)
    : undefined;

  const persistedStats = loadHeatingStatistics();
  if (persistedStats) {
    log(
      `Heating statistics (persisted): holdPowerLevel=${persistedStats.holdPowerLevel}W threshold=${persistedStats.powerHoldThreshold}W holdFactor=${persistedStats.powerHoldFactor.toFixed(3)} (${persistedStats.periodStart} -> ${persistedStats.periodEnd})`,
    );
  }
  const holdCfg = config.evCharging.holdWhenHeating;
  tracker =
    session.heatingWattsSource && holdCfg
      ? new HeatingTracker(
          {
            maxHoldPercentage: holdCfg.maxHoldPercentage ?? 20,
            holdMargin: holdCfg.holdMargin ?? 100,
            statisticsPeriodHours: holdCfg.statisticsPeriodHours ?? 24,
          },
          persistedStats,
        )
      : null;
  let unsubTracker: (() => void) | undefined;
  if (session.heatingWattsSource && tracker) {
    unsubTracker = session.heatingWattsSource.subscribe(({ watts }) =>
      tracker.onHeatingWatts(watts),
    );
  }
  const samplingInterval =
    tracker !== null ? setInterval(() => tracker.takeSample(new Date()), 60_000) : undefined;

  // Charge loop: run sessions indefinitely, retrying on error.
  log("Starting charging loop");
  try {
    while (true) {
      try {
        await runSession(session, publisher, config, undefined, clock, onSessionEnd, tracker);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERROR: ${msg}`);
        publisher.setError(errorStatus(err));
        log("Retrying in 60s...");
        await clock.sleep(60_000);
      }
    }
  } finally {
    if (samplingInterval !== undefined) clearInterval(samplingInterval);
    unsubTracker?.();
  }
}
