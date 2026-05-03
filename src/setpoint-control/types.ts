import type { PricedSlot } from "../electricity/types.ts";

export type CostTier = "cheap" | "average" | "expensive";

export interface SetpointSlot extends PricedSlot {
  setpoint: number;
  costTier: CostTier;
}
