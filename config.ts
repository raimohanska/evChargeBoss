export const CONFIG = {
  charging: {
    targetKwh: 7,         // energy needed
    powerKw: 3,           // charger power
    targetTime: "12:00",  // next-day deadline (local time)
  },
  solar: {
    lat: 61.5,
    lon: 24.7,
    declination: 35,      // roof pitch in degrees
    azimuth: 0,           // 0=south, -90=east, 90=west
    kwp: 7.5,             // installed kWp
    efficiencyFactor: 0.85,
    freeThresholdW: 400,  // slots above this W forecast are "free"
  },
  electricity: {
    transportCostEurKwh: 0.045, // sähkön siirto + verot, €/kWh
  },
};

export interface Slot {
  start: Date;
  end: Date;
  spotPriceEur: number;       // raw spot €/kWh
  transportCostEur: number;
  solarForecastW: number;
  effectivePriceEur: number;  // 0 if solar above threshold, else spot+transport
  charge: boolean;
}
