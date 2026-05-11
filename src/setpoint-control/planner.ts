import type { Config } from "../config.ts";
import type { SetpointControlConfig } from "./config.ts";
import type { CostTier, SetpointSlot } from "./types.ts";
import type { PricedSlot } from "../electricity/types.ts";
import { fetchSlots } from "../electricity/index.ts";
import { IncompleteDataError } from "../electricity/IncompleteDataError.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("setpoint-control");

/** Energy cost of one 15-min slot in euros: (device kWh − solar kWh) × rate */
function slotCostEur(
  solarForecastW: number,
  spotPriceEurPerKwh: number,
  transportCostEurPerKwh: number,
  defaultPowerConsumptionW: number,
): number {
  const slotHours = 0.25;
  const deviceKwh = (defaultPowerConsumptionW * slotHours) / 1000;
  const solarKwh = (solarForecastW * slotHours) / 1000;
  return (deviceKwh - solarKwh) * (spotPriceEurPerKwh + transportCostEurPerKwh);
}

async function fetchAvailableSlots(
  from: Date,
  to: Date,
  spConfig: SetpointControlConfig,
  config: Config,
): Promise<PricedSlot[]> {
  try {
    return await fetchSlots(from, to, config.electricity, config.solar, config.influx);
  } catch (err) {
    if (!(err instanceof IncompleteDataError) || err.missingSlots.length === 0) throw err;
    const firstMissing = err.missingSlots[0];
    if (firstMissing.getTime() <= from.getTime()) throw err; // no usable data at all
    log(
      `[${spConfig.name}] Spot prices only available until ${localTimeShort(firstMissing)} — using shorter plan`,
    );
    return await fetchSlots(
      from,
      firstMissing,
      config.electricity,
      config.solar,
      config.influx,
    );
  }
}

export async function planSetpoint(
  from: Date,
  to: Date,
  spConfig: SetpointControlConfig,
  config: Config,
): Promise<SetpointSlot[]> {
  const pricedSlots = await fetchAvailableSlots(from, to, spConfig, config);

  const costs = pricedSlots.map((s) =>
    slotCostEur(
      s.solarForecastW,
      s.spotPriceEurPerKwh,
      s.transportCostEurPerKwh,
      spConfig.defaultPowerConsumptionW,
    ),
  );

  const avgCost = costs.reduce((sum, c) => sum + c, 0) / costs.length;
  log(
    `[${spConfig.name}] Planning ${pricedSlots.length} slots, avg slot cost ${(avgCost * 100).toFixed(2)} cts`,
  );

  // Identify expensive slots first, count = N.
  const hasExpensive = spConfig.expensiveFactor != null && spConfig.setpointExpensive != null;
  const expensiveThreshold = hasExpensive ? avgCost * spConfig.expensiveFactor! : Infinity;
  const expensiveIndices = new Set(
    costs
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c > expensiveThreshold)
      .map(({ i }) => i),
  );
  const n = expensiveIndices.size;

  // Pick the N cheapest non-expensive slots.
  const cheapIndices = new Set(
    costs
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !expensiveIndices.has(i))
      .sort((a, b) => a.c - b.c)
      .slice(0, n)
      .map(({ i }) => i),
  );

  return pricedSlots.map((s, i) => {
    let setpoint: number;
    let costTier: CostTier;
    if (expensiveIndices.has(i)) {
      setpoint = spConfig.setpointExpensive!;
      costTier = "expensive";
    } else if (cheapIndices.has(i)) {
      setpoint = spConfig.setpointCheap;
      costTier = "cheap";
    } else {
      setpoint = spConfig.setpointDefault;
      costTier = "average";
    }
    return { ...s, setpoint, costTier };
  });
}
