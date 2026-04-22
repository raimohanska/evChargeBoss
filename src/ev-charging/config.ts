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

export const SolarConfigSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  declination: z.number(),
  azimuth: z.number(),
  kwp: z.number().positive(),
  treeShadingSchedule: z.array(
    z.strictObject({
      time: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
      outputFraction: z.number().min(0).max(1),
    }),
  ),
});

export const ElectricityConfigSchema = z.strictObject({
  transportCostEurKwh: z.number().nonnegative(),
});

export const TestConfigSchema = z
  .object({
    timeSpeedupFactor: z.number().positive().optional(),
  })
  .optional();

export type Mode = z.infer<typeof ModeSchema>;
export type MqttConfig = z.infer<typeof MqttConfigSchema>;
export type ChargingConfig = z.infer<typeof ChargingConfigSchema>;
export type EvChargingConfig = z.infer<typeof EvChargingConfigSchema>;
export type SolarConfig = z.infer<typeof SolarConfigSchema>;
export type ElectricityConfig = z.infer<typeof ElectricityConfigSchema>;
