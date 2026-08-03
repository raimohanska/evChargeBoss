import { z } from "zod";

export const Mode = z.enum(["charge", "plan"]);
export type Mode = z.infer<typeof Mode>;

export const DayOfWeek = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type DayOfWeek = z.infer<typeof DayOfWeek>;

const TimeStrLoose = z.string().regex(/^\d{1,2}:\d{2}$/, 'must be "H:MM" or "HH:MM"');

export const WeeklySchedule = z.record(DayOfWeek, TimeStrLoose);
// z.record infers all keys as required; WeeklySchedule is intentionally partial
export type WeeklySchedule = Partial<Record<DayOfWeek, string>>;

export const EvChargingMqttConfig = z.strictObject({
  powerTopic: z.string(),
  powerField: z.string().optional(),
  powerThresholdW: z.number(),
  energyField: z.string().optional(),
  chargerTopic: z.string(),
  onPayload: z.string(),
  offPayload: z.string(),
  chargeLevelTopic: z.string().optional(),
  chargeLevelField: z.string().optional(),
});
export type EvChargingMqttConfig = z.infer<typeof EvChargingMqttConfig>;

const HoldWhenHeatingConfig = z.object({
  maxHoldPercentage: z.number().positive().max(100).optional(),
  holdMargin: z.number().nonnegative().optional(),
  statisticsPeriodHours: z.number().positive().optional(),
  mqtt: z.object({
    powerTopic: z.string(),
    powerField: z.string().optional(),
  }),
});
export type HoldWhenHeatingConfig = z.infer<typeof HoldWhenHeatingConfig>;

export const EvChargingConfig = z.strictObject({
  mode: Mode,
  targetKwh: z.number().positive(),
  powerKw: z.number().positive().optional(),
  targetTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
  weeklySchedule: WeeklySchedule.optional(),
  chargeNowHours: z.number().positive().optional(),
  plugInTimeoutMs: z.number().positive().optional(),
  /**
   * Topic prefix for all MQTT topics this instance publishes/subscribes to
   * (status, target_time, target_kwh, schedule, discovery). Defaults to
   * "evchargeboss". Lets multiple instances or test sessions run against the
   * same broker without topic collisions.
   */
  topicPrefix: z.string().optional(),
  mqtt: EvChargingMqttConfig.optional(),
  holdWhenHeating: HoldWhenHeatingConfig.optional(),
});
export type EvChargingConfig = z.infer<typeof EvChargingConfig>;
