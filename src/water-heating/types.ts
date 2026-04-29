import type { PricedSlot } from "../electricity/types.ts";

export interface WaterHeatingSlot extends PricedSlot {
  targetTemp: number;
}
