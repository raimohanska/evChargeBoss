import { z } from "zod";

export const ModeSchema = z.enum(["charge", "plan"]);

export const MqttConfigSchema = z.strictObject({
  powerTopic: z.string(),
  powerField: z.string(),
  powerThresholdW: z.number(),
  energyField: z.string().optional(),
  chargerTopic: z.string(),
  onPayload: z.string(),
  offPayload: z.string(),
});

export const EvChargingConfigSchema = z.strictObject({
  mode: ModeSchema,
  targetKwh: z.number().positive(),
  powerKw: z.number().positive(),
  targetTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
  mqtt: MqttConfigSchema.optional(),
});

export type Mode = z.infer<typeof ModeSchema>;
export type MqttConfig = z.infer<typeof MqttConfigSchema>;
export type EvChargingConfig = z.infer<typeof EvChargingConfigSchema>;
