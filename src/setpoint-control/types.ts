import type { PricedSlot } from "../electricity/types.ts";

export interface SetpointSlot extends PricedSlot {
  setpoint: number;
}
