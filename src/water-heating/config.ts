import { z } from "zod";

export const WaterHeatingMqttConfig = z.strictObject({
  commandTopic: z.string(),
});
export type WaterHeatingMqttConfig = z.infer<typeof WaterHeatingMqttConfig>;

export const WaterHeatingConfig = z.strictObject({
  targetTemperatureDefault: z.number(),
  targetTemperatureCheap: z.number(),
  cheapFactor: z.number().positive().default(0.5),
  solarWattsThresholdForCheap: z.number().nonnegative(),
  mqtt: WaterHeatingMqttConfig,
});
export type WaterHeatingConfig = z.infer<typeof WaterHeatingConfig>;
