import type { Slot } from "./types.ts";
import { STATUS } from "./mqtt-status.ts";
import type { Publisher } from "./mqtt-status.ts";
import type { CancelSignal } from "../utils/timing-utils.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("ev-charging");
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
 * Wraps a ChargerDriver with heating-hold logic.
 *
 * When the holdSource fires held=true while charging is requested the relay is
 * turned OFF (or kept OFF) with a log message.  When heating releases the
 * relay is turned back ON.  No relay commands are emitted when the relay was
 * already off and charging had not been requested.
 *
 * Call dispose() when the slot ends to unsubscribe from the holdSource.
 */
export function makeHoldAwareDriver(
  inner: ChargerDriver,
  holdSource: HoldSource,
  callbacks: {
    /** Called when heating blocks or pauses a charge (relay goes/stays OFF). */
    onHeld(): void;
    /** Called when heating releases and the relay is turned back ON. */
    onReleased(): void;
  },
): { driver: ChargerDriver; readonly isHeld: boolean; dispose(): void } {
  let requestedOn = false;
  let isHeld = false;
  let actuallyOn = false;

  const dispose = holdSource.subscribe((held) => {
    isHeld = held;
    if (held) {
      if (actuallyOn) {
        log(`[HOLD] Heating — charging paused`);
        actuallyOn = false;
        inner.send(false).catch((err) => log(`[HOLD] relay OFF error: ${err}`));
        callbacks.onHeld();
      }
      // Relay already off and not requested — no command, no log.
    } else {
      if (requestedOn) {
        log(`[HOLD] Heating released — resuming charge`);
        actuallyOn = true;
        inner.send(true).catch((err) => log(`[HOLD] relay ON error: ${err}`));
        callbacks.onReleased();
      }
    }
  });

  const driver: ChargerDriver = {
    async send(on: boolean): Promise<void> {
      requestedOn = on;
      if (!on) {
        if (actuallyOn) {
          actuallyOn = false;
          await inner.send(false);
        }
      } else {
        if (isHeld) {
          log(`[HOLD] Would start charging, but heating is on — pausing`);
          callbacks.onHeld();
        } else {
          actuallyOn = true;
          await inner.send(true);
        }
      }
    },
  };

  return {
    driver,
    get isHeld() {
      return isHeld;
    },
    dispose,
  };
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
  let relayOn = false;

  // For charge slots with a holdSource, wrap the driver so that heating hold
  // is handled centrally with correct logging in all transitions.
  const holdHandle =
    slot.charge && holdSource
      ? makeHoldAwareDriver(driver, holdSource, {
          onHeld() {
            relayOn = false;
            publisher?.setStatus(STATUS.heatingHold);
          },
          onReleased() {
            relayOn = true;
            publisher?.setStatus(
              wattsSource
                ? STATUS.waitingForChargingToStart
                : STATUS.charging(localTimeShort(chargeRunEnd ?? slot.end)),
            );
          },
        })
      : undefined;
  const effectiveDriver = holdHandle ? holdHandle.driver : driver;

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
        } else if (chargeActive && !(holdHandle?.isHeld ?? false)) {
          carFinished = true;
          publisher.setStatus(STATUS.chargingFinished(lastSessionKwh));
        }
      })
    : undefined;

  if (slot.charge) {
    // Send ON through the effective driver (hold-aware when holdSource is present).
    // The hold-aware driver blocks the relay and logs when heating is active;
    // mid-slot hold/resume is handled by the holdSource subscription inside it.
    // A retained MQTT message on powerTopic is not required: the persistent
    // msgHandler in makeMqttSession() ensures live updates reach wattsListeners
    // without relying on broker retain.  Between consecutive charge slots the
    // relay is always sent OFF first, so the retained reading will already be
    // 0 W and the status correctly starts as waitingForChargingToStart.
    await effectiveDriver.send(true);
    if (!(holdHandle?.isHeld ?? false)) {
      relayOn = true;
      if (publisher) {
        publisher.setStatus(
          wattsSource
            ? STATUS.waitingForChargingToStart
            : STATUS.charging(localTimeShort(chargeRunEnd ?? slot.end)),
        );
      }
    }
  } else {
    await driver.send(false);
  }

  const msUntilEnd = slot.end.getTime() - clock.now().getTime();
  if (msUntilEnd > 0) await clock.sleep(msUntilEnd, signal);

  if (signal?.aborted && relayOn) {
    await effectiveDriver.send(false);
  }

  try {
    // Prefer relay-measured energy; fall back to a plan-based estimate.
    if (startEnergy !== null && lastEnergy !== null) {
      return { kwh: lastEnergy - startEnergy, carFinished };
    }
    if (!slot.charge) return { kwh: 0, carFinished };
    // No relay energy field: estimate from elapsed time (prorated on abort).
    const slotDurationMs = slot.end.getTime() - slot.start.getTime();
    const elapsedMs = Math.min(
      Math.max(0, clock.now().getTime() - slot.start.getTime()),
      slotDurationMs,
    );
    return { kwh: powerKw * (elapsedMs / 3_600_000), carFinished };
  } finally {
    unsubWatts?.();
    holdHandle?.dispose();
  }
}
