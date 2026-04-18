export const CONFIG = {
  mqtt: {
    brokerUrl: "mqtt://homeassistant.local:1883",
    username: "",           // leave empty if no auth required
    password: "",
    // Topic that publishes power readings (JSON with a numeric field)
    powerTopic: "zigbee2mqtt/ev-relay",
    powerField: "power",    // JSON key containing watts, e.g. {"power": 150}
    powerThresholdW: 10,    // watts above which we consider a car plugged in
    // Topic and payloads for switching the charger relay
    chargerTopic: "zigbee2mqtt/ev-relay/set",
    onPayload:  JSON.stringify({ state: "ON" }),
    offPayload: JSON.stringify({ state: "OFF" }),
  },
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
    // Tree shading: waypoints mapping local time → remaining output fraction.
    // Values are linearly interpolated. Before the first entry: no shading (1.0).
    // After the last entry: last fraction is held constant.
    treeShadingSchedule: [
      { time: "13:00", outputFraction: 1.0 },  // shading begins
      { time: "14:30", outputFraction: 0.5 },  // 50% output
      { time: "16:30", outputFraction: 0.1 },  // 90% reduction
    ],
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
