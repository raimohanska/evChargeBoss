import { z } from "zod";

export const Mode = z.enum(["charge", "plan"]);
export type Mode = z.infer<typeof Mode>;

export const EvChargingMqttConfig = z.strictObject({
  powerTopic: z.string(),
  powerField: z.string(),
  powerThresholdW: z.number(),
  energyField: z.string().optional(),
  chargerTopic: z.string(),
  onPayload: z.string(),
  offPayload: z.string(),
});
export type EvChargingMqttConfig = z.infer<typeof EvChargingMqttConfig>;

export const EvChargingConfig = z.strictObject({
  mode: Mode,
  targetKwh: z.number().positive(),
  powerKw: z.number().positive().optional(),
  targetTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
  chargeNowHours: z.number().positive().optional(),
  mqtt: EvChargingMqttConfig.optional(),
});
export type EvChargingConfig = z.infer<typeof EvChargingConfig>;
