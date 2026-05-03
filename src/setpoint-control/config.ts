import { z } from "zod";

export const SetpointControlMqttConfig = z.strictObject({
  commandTopic: z.string(),
});
export type SetpointControlMqttConfig = z.infer<typeof SetpointControlMqttConfig>;

export const SetpointControlConfig = z.strictObject({
  /** Human-readable name used in log messages, e.g. "Water Heater". */
  name: z.string(),
  setpointDefault: z.number(),
  setpointCheap: z.number(),
  setpointExpensive: z.number().optional(),
  cheapFactor: z.number().positive().default(0.5),
  expensiveFactor: z.number().positive().optional(),
  solarWattsThresholdForCheap: z.number().nonnegative(),
  mqtt: SetpointControlMqttConfig,
});
export type SetpointControlConfig = z.infer<typeof SetpointControlConfig>;
