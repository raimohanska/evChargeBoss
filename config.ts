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
  },
  electricity: {
    transportCostEurKwh: 0.045, // sähkön siirto + verot, €/kWh
  },
};

export interface Slot {
  start: Date;
  end: Date;
  spotPriceEurPerKwh: number;       // raw spot price €/kWh
  transportCostEurPerKwh: number;   // transfer tariff + taxes €/kWh
  solarForecastW: number;           // forecasted solar output during slot
  effectiveCostEur: number;         // total cost for this slot (grid fraction * rate * 0.25h)
  charge: boolean;
}
