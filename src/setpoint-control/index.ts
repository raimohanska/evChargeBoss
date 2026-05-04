import type { Config } from "../config.ts";
import type { SetpointControlConfig } from "./config.ts";
import type { SetpointSlot } from "./types.ts";
import type { Clock } from "../utils/timing-utils.ts";
import { planSetpoint } from "./planner.ts";
import { printSetpointPlan } from "./print-plan.ts";
import { connectMqtt } from "../ev-charging/mqtt-client.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { log } from "../utils/log.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { IncompleteDataError } from "../electricity/IncompleteDataError.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;

type PlanFn = (
  from: Date,
  to: Date,
  spConfig: SetpointControlConfig,
  config: Config,
) => Promise<SetpointSlot[]>;

/**
 * Executes one 24-hour planning window, re-planning at every slot boundary.
 * On IncompleteDataError the most recently successful plan is kept; the slot
 * index advances so the correct setpoint is still published. Exported for testing.
 */
export async function runSetpointControlLoop(
  from: Date,
  spConfig: SetpointControlConfig,
  config: Config,
  publish: (topic: string, payload: string) => void,
  clock: Clock,
  planFn: PlanFn = planSetpoint,
): Promise<void> {
  const to = new Date(from.getTime() + WINDOW_MS);

  // Initial plan — if this fails propagate to the outer retry loop.
  const initialSlots = await planFn(from, to, spConfig, config);
  printSetpointPlan(initialSlots, spConfig);

  const { commandTopic } = spConfig.mqtt;

  // currentPlan = most recently successful plan.
  // planOffset = index into currentPlan for the current time slot; advances
  // when re-planning fails so the right slot is still used from the old plan.
  let currentPlan = initialSlots;
  let planOffset = 0;

  for (const initialSlot of initialSlots) {
    const msUntilSlot = initialSlot.start.getTime() - clock.now().getTime();
    if (msUntilSlot > 0) await clock.sleep(msUntilSlot);

    const now = clock.now();
    const newTo = new Date(now.getTime() + WINDOW_MS);
    try {
      currentPlan = await planFn(now, newTo, spConfig, config);
      printSetpointPlan(currentPlan, spConfig);
      planOffset = 0;
    } catch (err) {
      if (!(err instanceof IncompleteDataError)) throw err;
      log(`[${spConfig.name}] Re-plan skipped (incomplete data) — keeping current plan`);
    }

    const setpoint = currentPlan[planOffset]?.setpoint ?? spConfig.setpointDefault;
    publish(commandTopic, String(setpoint));
    log(`[${spConfig.name}] setpoint: ${setpoint} at ${localTimeShort(initialSlot.start)}`);

    if (planOffset < currentPlan.length - 1) planOffset++;
  }
}

export async function runSetpointControl(
  id: string,
  spConfig: SetpointControlConfig,
  config: Config,
): Promise<void> {
  if (!config.mqtt) {
    console.error(
      `ERROR: setpointControl["${id}"] requires mqtt broker to be configured in config.json`,
    );
    process.exit(1);
  }

  log(`=== Setpoint Control: ${spConfig.name} ===`);

  const mqttClient = await connectMqtt(config.mqtt);
  const clock = makeClock(config.test?.timeSpeedupFactor ?? 1);
  const publish = (topic: string, payload: string) => mqttClient.publish(topic, payload);

  while (true) {
    try {
      await runSetpointControlLoop(clock.now(), spConfig, config, publish, clock);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[${spConfig.name}] ERROR: ${msg}`);
      log("Retrying in 60s...");
      await clock.sleep(60_000);
    }
  }
}
