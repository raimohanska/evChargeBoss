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
  expensiveFactor: z.number().positive().optional(),
  /** Device power consumption in watts, used to compute expected energy cost per 15-min slot. */
  defaultPowerConsumptionW: z.number().positive(),
  mqtt: SetpointControlMqttConfig,
});
export type SetpointControlConfig = z.infer<typeof SetpointControlConfig>;
