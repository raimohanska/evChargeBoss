export interface Slot {
  start: Date;
  end: Date;
  spotPriceEurPerKwh: number; // raw spot price €/kWh
  transportCostEurPerKwh: number; // transfer tariff + taxes €/kWh
  solarForecastW: number; // forecasted solar output during slot
  effectiveCostEur: number; // total cost for this slot (grid fraction * rate * 0.25h)
  charge: boolean;
  // true when holding (skipping) this charge slot still leaves enough future
  // charge slots in the plan to reach targetKwh.
  canHold: boolean;
}
