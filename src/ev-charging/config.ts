import { z } from "zod";

export const ModeSchema = z.enum(["charge", "plan"]);

export const MqttConfigSchema = z.strictObject({
  brokerUrl: z.string(),
  username: z.string(),
  password: z.string(),
  powerTopic: z.string(),
  powerField: z.string(),
  powerThresholdW: z.number(),
  energyField: z.string().optional(),
  chargerTopic: z.string(),
  onPayload: z.string(),
  offPayload: z.string(),
});

export const ChargingConfigSchema = z.strictObject({
  targetKwh: z.number().positive(),
  powerKw: z.number().positive(),
  targetTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
  mqtt: MqttConfigSchema.optional(),
});

export const EvChargingConfigSchema = z.strictObject({
  mode: ModeSchema,
  charging: ChargingConfigSchema,
});

export type Mode = z.infer<typeof ModeSchema>;
export type MqttConfig = z.infer<typeof MqttConfigSchema>;
export type ChargingConfig = z.infer<typeof ChargingConfigSchema>;
export type EvChargingConfig = z.infer<typeof EvChargingConfigSchema>;
