import type { Config } from "../config.ts";
import type { SetpointControlConfig } from "./config.ts";
import type { Clock } from "../utils/timing-utils.ts";
import { planSetpoint } from "./planner.ts";
import { printSetpointPlan } from "./print-plan.ts";
import { connectMqtt } from "../ev-charging/mqtt-client.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { log } from "../utils/log.ts";
import { localTimeShort } from "../utils/date-time-format.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Executes one 24-hour planning window: fetches slots, walks them in order,
 * and publishes the setpoint at each slot boundary. Exported for testing.
 */
export async function runSetpointControlLoop(
  from: Date,
  spConfig: SetpointControlConfig,
  config: Config,
  publish: (topic: string, payload: string) => void,
  clock: Clock,
): Promise<void> {
  const to = new Date(from.getTime() + WINDOW_MS);
  const slots = await planSetpoint(from, to, spConfig, config);
  printSetpointPlan(slots, spConfig);
  const { commandTopic } = spConfig.mqtt;

  for (const slot of slots) {
    const msUntilSlot = slot.start.getTime() - clock.now().getTime();
    if (msUntilSlot > 0) await clock.sleep(msUntilSlot);
    publish(commandTopic, String(slot.setpoint));
    log(`[${spConfig.name}] setpoint: ${slot.setpoint} at ${localTimeShort(slot.start)}`);
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
