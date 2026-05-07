import type { Slot } from "./types.ts";
import { STATUS } from "./mqtt-status.ts";
import type { Publisher } from "./mqtt-status.ts";
import type { CancelSignal } from "../utils/timing-utils.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import type { Clock } from "../utils/timing-utils.ts";

export interface ChargerDriver {
  send(on: boolean): Promise<void>;
}

export interface WattsUpdate {
  watts: number;
  energyKwh?: number; // cumulative relay energy reading, if available
}

export interface WattsSource {
  subscribe(cb: (update: WattsUpdate) => void): () => void;
}

// Emits the current "held" state immediately on subscribe, then on every change.
// When held is true the relay should be kept OFF regardless of the charge schedule.
export interface HoldSource {
  subscribe(cb: (held: boolean) => void): () => void;
}

// A session encapsulates how to wait for "ready to charge" and which driver to use.
// waitForStart() resolves when it is time to plan and begin charging.
// It returns the detected charging power in kW (measured from the relay during plug-in).
export interface ChargingSession {
  waitForStart(): Promise<number>;
  driver: ChargerDriver;
  wattsSource?: WattsSource;
  holdSource?: HoldSource;
  end(): void;
}

/**
 * Parameters for {@link runSlot}.
 *
 * chargeRunEnd: end of the consecutive charging run this slot belongs to,
 *   used only for "Charging until …" status display.  Pass null for
 *   non-charge slots or when the look-ahead value is unavailable.
 * prevChargedKwh: energy already delivered earlier in this session, used
 *   for the cumulative display via publisher.setChargedEnergy.
 */
export interface RunSlotParams {
  slot: Slot;
  chargeRunEnd: Date | null;
  driver: ChargerDriver;
  publisher: Publisher | undefined;
  signal: CancelSignal | undefined;
  wattsSource: WattsSource | undefined;
  holdSource: HoldSource | undefined;
  prevChargedKwh: number;
  powerThresholdW: number;
  powerKw: number;
  clock: Clock;
}

/**
 * Executes a single slot in the charging schedule.
 *
 * The caller is responsible for sleeping to the slot start time before
 * calling this function.  This function sends the ON/OFF command to the
 * driver, waits for the slot to finish (or signal abort), and returns the
 * energy delivered.
 *
 * Returns kWh delivered:
 *   - relay energy delta when the relay reports cumulative energy, otherwise
 *   - powerKw × 0.25 h when the slot completed normally, 0 when aborted.
 */
export async function runSlot({
  slot,
  chargeRunEnd,
  driver,
  publisher,
  signal,
  wattsSource,
  holdSource,
  prevChargedKwh,
  powerThresholdW,
  powerKw,
  clock,
}: RunSlotParams): Promise<{ kwh: number; carFinished: boolean }> {
  const label = slot.charge
    ? slot.effectiveCostEur === 0
      ? "solar-free"
      : `${slot.effectiveCostEur.toFixed(3)} €`
    : "too expensive";
  log(
    `[${slot.charge ? "ON " : "OFF"}] ${localTimeShort(slot.start)}-${localTimeShort(slot.end)} | ${label}`,
  );

  let startEnergy: number | null = null;
  let lastEnergy: number | null = null;
  let chargeActive = false;
  let carFinished = false;
  let lastSessionKwh: number | undefined = undefined;
  let isHeld = false;
  let relayOn = false;

  const unsubWatts = slot.charge
    ? wattsSource?.subscribe(({ watts, energyKwh }) => {
        if (energyKwh !== undefined) {
          if (startEnergy === null) startEnergy = energyKwh;
          lastEnergy = energyKwh;
          lastSessionKwh = prevChargedKwh + energyKwh - startEnergy;
          publisher?.setChargedEnergy(lastSessionKwh);
        }
        if (!publisher) return;
        const runEnd = chargeRunEnd ?? slot.end;
        if (watts > powerThresholdW) {
          chargeActive = true;
          publisher.setStatus(STATUS.charging(localTimeShort(runEnd)));
        } else if (chargeActive && !isHeld) {
          carFinished = true;
          publisher.setStatus(STATUS.chargingFinished(lastSessionKwh));
        }
      })
    : undefined;

  // When holdSource is present for a charge slot it fires immediately with the
  // current held state, driving both the initial relay command and any mid-slot
  // hold/resume transitions.  Without holdSource the original await-send path is used.
  let unsubHold: (() => void) | undefined;
  if (slot.charge && holdSource) {
    unsubHold = holdSource.subscribe((held) => {
      isHeld = held;
      if (held) {
        relayOn = false;
        driver.send(false).catch((err) => log(`[HOLD] relay OFF error: ${err}`));
        publisher?.setStatus(STATUS.heatingHold);
      } else {
        relayOn = true;
        driver.send(true).catch((err) => log(`[HOLD] relay ON error: ${err}`));
        publisher?.setStatus(
          wattsSource
            ? STATUS.waitingForChargingToStart
            : STATUS.charging(localTimeShort(chargeRunEnd ?? slot.end)),
        );
      }
    });
  } else {
    // Set initial status before sending the relay command.  A retained MQTT
    // message on powerTopic is not required: the persistent msgHandler in
    // makeMqttSession() ensures live updates reach wattsListeners without
    // relying on broker retain.  Between consecutive charge slots the relay is
    // always sent OFF first, so the retained reading (if any) will already be
    // 0 W and the status correctly starts as waitingForChargingToStart.
    if (slot.charge && publisher) {
      publisher.setStatus(
        wattsSource
          ? STATUS.waitingForChargingToStart
          : STATUS.charging(localTimeShort(chargeRunEnd ?? slot.end)),
      );
    }
    await driver.send(slot.charge);
    if (slot.charge) relayOn = true;
  }

  const msUntilEnd = slot.end.getTime() - clock.now().getTime();
  if (msUntilEnd > 0) await clock.sleep(msUntilEnd, signal);

  if (signal?.aborted && relayOn) {
    await driver.send(false);
  }

  unsubWatts?.();
  unsubHold?.();

  // Prefer relay-measured energy; fall back to a plan-based estimate.
  if (startEnergy !== null && lastEnergy !== null) {
    return { kwh: lastEnergy - startEnergy, carFinished };
  }
  if (signal?.aborted || !slot.charge) return { kwh: 0, carFinished };
  return { kwh: powerKw * 0.25, carFinished };
}
