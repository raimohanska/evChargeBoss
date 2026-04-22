export interface PricedSlot {
  start: Date;
  end: Date;
  spotPriceEurPerKwh: number;
  transportCostEurPerKwh: number;
  solarForecastW: number;
}
