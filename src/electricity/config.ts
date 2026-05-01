import { z } from "zod";

const InfluxMeasurementConfig = z.strictObject({
  measurement: z.string(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type InfluxMeasurementConfig = z.infer<typeof InfluxMeasurementConfig>;

export const SolarConfig = z.strictObject({
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
  influx: InfluxMeasurementConfig.optional(),
});
export type SolarConfig = z.infer<typeof SolarConfig>;

export const ElectricityConfig = z.strictObject({
  transportCostEurKwh: z.number().nonnegative(),
  influx: InfluxMeasurementConfig.optional(),
});
export type ElectricityConfig = z.infer<typeof ElectricityConfig>;
