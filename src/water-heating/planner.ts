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

  // Effective price per slot: 0 if any solar is forecast, otherwise spot + transport.
  const prices = pricedSlots.map((s) =>
    s.solarForecastW > 0 ? 0 : s.spotPriceEurPerKwh + s.transportCostEurPerKwh,
  );

  const dailyAvg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  log(
    `Water heating: planning ${pricedSlots.length} slots, avg ${(dailyAvg * 100).toFixed(2)} cts/kWh`,
  );

  return pricedSlots.map((s, i) => ({
    ...s,
    targetTemp:
      prices[i] === 0 || prices[i] < dailyAvg * whConfig.cheapFactor
        ? whConfig.targetTemperatureCheap
        : whConfig.targetTemperatureDefault,
  }));
}
