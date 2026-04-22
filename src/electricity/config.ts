import { z } from "zod";

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
    })
  ),
});
export type SolarConfig = z.infer<typeof SolarConfig>;

export const ElectricityConfig = z.strictObject({
  transportCostEurKwh: z.number().nonnegative(),
});
export type ElectricityConfig = z.infer<typeof ElectricityConfig>;

