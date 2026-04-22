export interface SolarConfig {
  lat: number;
  lon: number;
  declination: number;
  azimuth: number;
  kwp: number;
  treeShadingSchedule: Array<{ time: string; outputFraction: number }>;
}

export interface FetchSlotsConfig {
  solar: SolarConfig;
  transportCostEurKwh: number;
}

export interface PricedSlot {
  start: Date;
  end: Date;
  spotPriceEurPerKwh: number;
  transportCostEurPerKwh: number;
  solarForecastW: number;
}
