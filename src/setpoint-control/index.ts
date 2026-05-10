import type { Config } from "../config.ts";
import type { SetpointControlConfig } from "./config.ts";
import type { SetpointSlot } from "./types.ts";
import { z } from "zod";
import type { Clock } from "../utils/timing-utils.ts";
import { planSetpoint } from "./planner.ts";
import { printSetpointPlan } from "./print-plan.ts";
import { connectMqtt } from "../ev-charging/mqtt-client.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { log } from "../utils/log.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { SetpointStatusPublisher } from "./ha-status.ts";
import {
  findNewestPlanFile,
  readPlanFile,
  writePlanFile,
  planFilePath,
  timestampForFilename,
  cleanOldPlanFiles,
} from "../utils/plan-store.ts";

const SerializedSetpointSlotSchema = z.object({
  start: z.string(),
  end: z.string(),
  spotPriceEurPerKwh: z.number(),
  transportCostEurPerKwh: z.number(),
  solarForecastW: z.number(),
  setpoint: z.number(),
  costTier: z.enum(["cheap", "average", "expensive"]),
});

type SerializedSetpointSlot = z.infer<typeof SerializedSetpointSlotSchema>;

const SetpointPlanFileSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  config: z.object({
    setpointCheap: z.number(),
    setpointDefault: z.number(),
    setpointExpensive: z.number().optional(),
    expensiveFactor: z.number().optional(),
  }),
  slots: z.array(SerializedSetpointSlotSchema),
});

type SetpointPlanFile = z.infer<typeof SetpointPlanFileSchema>;

function serializeSetpointSlots(slots: SetpointSlot[]): SerializedSetpointSlot[] {
  return slots.map((s) => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() }));
}

function deserializeSetpointSlots(serialized: SerializedSetpointSlot[]): SetpointSlot[] {
  return serialized.map((s) => ({
    ...s,
    start: new Date(s.start),
    end: new Date(s.end),
  }));
}

function isSetpointPlanApplicable(
  plan: SetpointPlanFile,
  now: Date,
  spConfig: SetpointControlConfig,
): boolean {
  if (plan.version !== 1) return false;
  if (plan.config.setpointCheap !== spConfig.setpointCheap) return false;
  if (plan.config.setpointDefault !== spConfig.setpointDefault) return false;
  if (plan.config.setpointExpensive !== spConfig.setpointExpensive) return false;
  if (plan.config.expensiveFactor !== spConfig.expensiveFactor) return false;
  if (plan.slots.length === 0) return false;
  const windowStart = new Date(plan.slots[0].start);
  const windowEnd = new Date(plan.slots[plan.slots.length - 1].end);
  return now >= windowStart && now < windowEnd;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

type PlanFn = (
  from: Date,
  to: Date,
  spConfig: SetpointControlConfig,
  config: Config,
) => Promise<SetpointSlot[]>;

/**
 * Plans once for up to 24 hours (or shorter if data is not available) and
 * executes every slot in that plan before returning. The outer retry loop
 * calls this again for the next window. Exported for testing.
 */
export async function runSetpointControlLoop(
  from: Date,
  spConfig: SetpointControlConfig,
  config: Config,
  publish: (topic: string, payload: string) => void,
  clock: Clock,
  planFn: PlanFn = planSetpoint,
  getTemperature?: () => number | undefined,
  isEnabled?: () => boolean,
  onSlot?: (slot: SetpointSlot, setpoint: number) => void,
  id?: string,
): Promise<void> {
  const to = new Date(from.getTime() + WINDOW_MS);

  let slots: SetpointSlot[];

  // Try to resume a persisted plan when an id is provided.
  if (id !== undefined) {
    const prefix = `setpoint-${id}`;
    const newestPlanPath = findNewestPlanFile(prefix);
    if (newestPlanPath !== null) {
      const savedPlan = readPlanFile<SetpointPlanFile>(newestPlanPath, SetpointPlanFileSchema);
      if (savedPlan !== null && isSetpointPlanApplicable(savedPlan, from, spConfig)) {
        log(`[${spConfig.name}] Resuming plan from ${newestPlanPath}`);
        slots = deserializeSetpointSlots(savedPlan.slots);
        printSetpointPlan(slots, spConfig);
      } else {
        slots = await planFn(from, to, spConfig, config);
        printSetpointPlan(slots, spConfig);
        try {
          writePlanFile(planFilePath(prefix, timestampForFilename(from)), {
            version: 1 as const,
            createdAt: from.toISOString(),
            config: {
              setpointCheap: spConfig.setpointCheap,
              setpointDefault: spConfig.setpointDefault,
              setpointExpensive: spConfig.setpointExpensive,
              expensiveFactor: spConfig.expensiveFactor,
            },
            slots: serializeSetpointSlots(slots),
          });
        } catch (writeErr) {
          log(`[${spConfig.name}] Warning: could not write plan file: ${writeErr}`);
        }
      }
    } else {
      slots = await planFn(from, to, spConfig, config);
      printSetpointPlan(slots, spConfig);
      try {
        writePlanFile(planFilePath(prefix, timestampForFilename(from)), {
          version: 1 as const,
          createdAt: from.toISOString(),
          config: {
            setpointCheap: spConfig.setpointCheap,
            setpointDefault: spConfig.setpointDefault,
            setpointExpensive: spConfig.setpointExpensive,
            expensiveFactor: spConfig.expensiveFactor,
          },
          slots: serializeSetpointSlots(slots),
        });
      } catch (writeErr) {
        log(`[${spConfig.name}] Warning: could not write plan file: ${writeErr}`);
      }
    }
  } else {
    // Plan once — propagate errors to the outer retry loop.
    slots = await planFn(from, to, spConfig, config);
    printSetpointPlan(slots, spConfig);
  }

  const { commandTopic } = spConfig.mqtt;

  let lastTempAdjustmentMsg: string | null = null;

  for (const slot of slots) {
    // Skip slots that have already ended (relevant when resuming a persisted plan).
    if (clock.now().getTime() >= slot.end.getTime()) continue;

    // Poll every 1 second while waiting for slot start — allows immediate cancellation.
    const slotStartMs = slot.start.getTime();
    while (clock.now().getTime() < slotStartMs) {
      if (isEnabled?.() === false) return;
      const remaining = slotStartMs - clock.now().getTime();
      await clock.sleep(Math.min(1_000, remaining));
    }
    if (isEnabled?.() === false) return;

    let setpoint = slot.setpoint;

    if (getTemperature !== undefined && spConfig.roomTemperature !== undefined) {
      const rtConfig = spConfig.roomTemperature;
      const temp = getTemperature();
      const low = rtConfig.targetTemperature - rtConfig.allowedDeviationDown;
      const high = rtConfig.targetTemperature + rtConfig.allowedDeviationUp;

      let tempAdjustmentMsg: string | null = null;
      if (temp === undefined) {
        tempAdjustmentMsg = `[${spConfig.name}] Room temperature unavailable at ${localTimeShort(slot.start)}, using planned setpoint ${setpoint}`;
      } else if (temp < low) {
        const adjusted = setpoint + rtConfig.influence;
        tempAdjustmentMsg = `[${spConfig.name}] Room ${temp.toFixed(1)}°C below range (${low.toFixed(1)}–${high.toFixed(1)}°C), raising setpoint by ${rtConfig.influence}: ${setpoint} → ${adjusted}`;
        setpoint = adjusted;
      } else if (temp > high) {
        const adjusted = setpoint - rtConfig.influence;
        tempAdjustmentMsg = `[${spConfig.name}] Room ${temp.toFixed(1)}°C above range (${low.toFixed(1)}–${high.toFixed(1)}°C), lowering setpoint by ${rtConfig.influence}: ${setpoint} → ${adjusted}`;
        setpoint = adjusted;
      } else {
        tempAdjustmentMsg = `[${spConfig.name}] Room ${temp.toFixed(1)}°C within range (${low.toFixed(1)}–${high.toFixed(1)}°C), no adjustment to planned setpoint ${setpoint}`;
      }
      if (tempAdjustmentMsg !== lastTempAdjustmentMsg) {
        log(tempAdjustmentMsg);
        lastTempAdjustmentMsg = tempAdjustmentMsg;
      }

      if (spConfig.setpointMin !== undefined && setpoint < spConfig.setpointMin) {
        log(`[${spConfig.name}] Setpoint ${setpoint} clamped to min ${spConfig.setpointMin}`);
        setpoint = spConfig.setpointMin;
      }
      if (spConfig.setpointMax !== undefined && setpoint > spConfig.setpointMax) {
        log(`[${spConfig.name}] Setpoint ${setpoint} clamped to max ${spConfig.setpointMax}`);
        setpoint = spConfig.setpointMax;
      }
    }

    publish(commandTopic, String(setpoint));
    log(`[${spConfig.name}] setpoint: ${setpoint} at ${localTimeShort(slot.start)}`);
    onSlot?.(slot, setpoint);
  }
}

export async function runSetpointControl(
  id: string,
  spConfig: SetpointControlConfig,
  config: Config,
  configPath: string,
): Promise<void> {
  if (!config.mqtt) {
    console.error(
      `ERROR: setpointControl["${id}"] requires mqtt broker to be configured in config.json`,
    );
    process.exit(1);
  }

  log(`=== Setpoint Control: ${spConfig.name} ===`);

  cleanOldPlanFiles();

  const mqttClient = await connectMqtt(config.mqtt);
  const clock = makeClock(config.test?.timeSpeedupFactor ?? 1);
  const publish = (topic: string, payload: string) => mqttClient.publish(topic, payload);

  const publisher = new SetpointStatusPublisher(mqttClient, id, spConfig, config, configPath);
  publisher.initDiscovery();

  let getTemperature: (() => number | undefined) | undefined;
  if (spConfig.roomTemperature) {
    const { temperatureTopic } = spConfig.roomTemperature.mqtt;
    let latestTemperature: number | undefined;

    mqttClient.subscribe(temperatureTopic);
    mqttClient.on("message", (topic: string, message: Buffer) => {
      if (topic !== temperatureTopic) return;
      const value = parseFloat(message.toString());
      if (!isNaN(value)) {
        latestTemperature = value;
      }
    });

    log(`[${spConfig.name}] Subscribed to room temperature topic: ${temperatureTopic}`);
    getTemperature = () => latestTemperature;

    // Give the broker a moment to deliver a retained message before the first plan.
    await clock.sleep(2_000);
    log(
      `[${spConfig.name}] Initial room temperature: ${latestTemperature !== undefined ? `${latestTemperature}°C` : "unavailable"}`,
    );
  }

  while (true) {
    if (!publisher.isEnabled()) {
      publisher.setStatus("Disabled");
      await clock.sleep(5_000);
      continue;
    }
    publisher.setStatus("Planning...");
    try {
      await runSetpointControlLoop(
        clock.now(),
        spConfig,
        config,
        publish,
        clock,
        planSetpoint,
        getTemperature,
        publisher.isEnabled.bind(publisher),
        (slot, setpoint) => {
          const until = localTimeShort(new Date(slot.start.getTime() + 15 * 60 * 1000));
          publisher.setCurrentSlot(slot.costTier, slot.setpoint, setpoint, until);
        },
        id,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[${spConfig.name}] ERROR: ${msg}`);
      publisher.setStatus(`Error: ${msg}`);
      log("Retrying in 60s...");
      await clock.sleep(60_000);
    }
  }
}
