import { z } from "zod";

export const SensorConfig = z.strictObject({
  name: z.string(),
  type: z.string(),
  device: z.string(),
  location: z.string(),
  mqtt_topic: z.string(),
  unit: z.string(),
  json_field: z.string().optional(),
});
export type SensorConfig = z.infer<typeof SensorConfig>;

export const MqttToInfluxConfig = z.strictObject({
  sensors: z.array(SensorConfig),
});
export type MqttToInfluxConfig = z.infer<typeof MqttToInfluxConfig>;
