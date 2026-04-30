import type { Config } from "../config.ts";
import type { WaterHeatingSlot } from "./types.ts";
import { fetchSlots } from "../electricity/index.ts";
import { log } from "../utils/log.ts";

export async function planWaterHeating(
  from: Date,
  to: Date,
  config: Config,
): Promise<WaterHeatingSlot[]> {
  const whConfig = config.waterHeating!;
  const pricedSlots = await fetchSlots(from, to, config.electricity, config.solar);

  // Effective price per slot: 0 if solar exceeds the configured threshold, otherwise spot + transport.
  const prices = pricedSlots.map((s) =>
    s.solarForecastW >= whConfig.solarWattsThresholdForCheap
      ? 0
      : s.spotPriceEurPerKwh + s.transportCostEurPerKwh,
  );

  const dailyAvg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  log(
    `Water heating: planning ${pricedSlots.length} slots, avg ${(dailyAvg * 100).toFixed(2)} cts/kWh`,
  );

  return pricedSlots.map((s, i) => {
    let targetTemp: number;
    if (prices[i] === 0 || prices[i] < dailyAvg * whConfig.cheapFactor) {
      targetTemp = whConfig.targetTemperatureCheap;
    } else if (
      whConfig.expensiveFactor != null &&
      whConfig.targetTemperatureExpensive != null &&
      prices[i] > dailyAvg * whConfig.expensiveFactor
    ) {
      targetTemp = whConfig.targetTemperatureExpensive;
    } else {
      targetTemp = whConfig.targetTemperatureDefault;
    }
    return { ...s, targetTemp };
  });
}
