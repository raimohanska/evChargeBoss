import { z } from "zod";

export const SetpointControlMqttConfig = z.strictObject({
  commandTopic: z.string(),
});
export type SetpointControlMqttConfig = z.infer<typeof SetpointControlMqttConfig>;

export const RoomTemperatureConfig = z.strictObject({
  targetTemperature: z.number(),
  allowedDeviationUp: z.number().nonnegative(),
  allowedDeviationDown: z.number().nonnegative(),
  influence: z.number().positive(),
  mqtt: z.strictObject({ temperatureTopic: z.string() }),
});
export type RoomTemperatureConfig = z.infer<typeof RoomTemperatureConfig>;

export const SetpointControlConfig = z.strictObject({
  /** Human-readable name used in log messages, e.g. "Water Heater". */
  name: z.string(),
  setpointDefault: z.number(),
  setpointCheap: z.number(),
  setpointExpensive: z.number().optional(),
  expensiveFactor: z.number().positive().optional(),
  /** Device power consumption in watts, used to compute expected energy cost per 15-min slot. */
  defaultPowerConsumptionW: z.number().positive(),
  /** Optional lower bound: published setpoint will never go below this value. */
  setpointMin: z.number().optional(),
  /** Optional upper bound: published setpoint will never exceed this value. */
  setpointMax: z.number().optional(),
  roomTemperature: RoomTemperatureConfig.optional(),
  mqtt: SetpointControlMqttConfig,
});
export type SetpointControlConfig = z.infer<typeof SetpointControlConfig>;
