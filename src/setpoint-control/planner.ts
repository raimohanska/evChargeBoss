import type { Config } from "../config.ts";
import type { SetpointControlConfig } from "./config.ts";
import type { SetpointSlot } from "./types.ts";
import { fetchSlots } from "../electricity/index.ts";
import { log } from "../utils/log.ts";

export async function planSetpoint(
  from: Date,
  to: Date,
  spConfig: SetpointControlConfig,
  config: Config,
): Promise<SetpointSlot[]> {
  const pricedSlots = await fetchSlots(
    from,
    to,
    config.electricity,
    config.solar,
    undefined,
    config.influx,
  );

  // Effective price per slot: 0 if solar exceeds the configured threshold, otherwise spot + transport.
  const prices = pricedSlots.map((s) =>
    s.solarForecastW >= spConfig.solarWattsThresholdForCheap
      ? 0
      : s.spotPriceEurPerKwh + s.transportCostEurPerKwh,
  );

  const dailyAvg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  log(
    `[${spConfig.name}] Planning ${pricedSlots.length} slots, avg ${(dailyAvg * 100).toFixed(2)} cts/kWh`,
  );

  return pricedSlots.map((s, i) => {
    let setpoint: number;
    if (prices[i] === 0 || prices[i] < dailyAvg * spConfig.cheapFactor) {
      setpoint = spConfig.setpointCheap;
    } else if (
      spConfig.expensiveFactor != null &&
      spConfig.setpointExpensive != null &&
      prices[i] > dailyAvg * spConfig.expensiveFactor
    ) {
      setpoint = spConfig.setpointExpensive;
    } else {
      setpoint = spConfig.setpointDefault;
    }
    return { ...s, setpoint };
  });
}
