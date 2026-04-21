export interface Slot {
  start: Date;
  end: Date;
  spotPriceEurPerKwh: number; // raw spot price €/kWh
  transportCostEurPerKwh: number; // transfer tariff + taxes €/kWh
  solarForecastW: number; // forecasted solar output during slot
  effectiveCostEur: number; // total cost for this slot (grid fraction * rate * 0.25h)
  charge: boolean;
}
