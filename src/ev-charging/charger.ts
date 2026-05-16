import type { Clock } from "../utils/timing-utils.ts";
import { Canceller } from "../utils/timing-utils.ts";

export interface ChargerDriver {
  send(on: boolean): Promise<void>;
}

/**
 * Wraps a ChargerDriver with a debounce: rapid successive send() calls within
 * delayMs collapse into a single command (the last one wins). The returned
 * send() resolves immediately (fire-and-forget); errors from the underlying
 * driver are passed to onError.
 */
export function makeDebouncedDriver(
  driver: ChargerDriver,
  clock: Clock,
  delayMs: number,
  onError: (err: unknown) => void,
): ChargerDriver {
  let canceller: Canceller | null = null;
  return {
    send(on: boolean): Promise<void> {
      if (canceller) canceller.abort();
      canceller = new Canceller();
      const signal = canceller.signal;
      clock
        .sleep(delayMs, signal)
        .then(() => {
          if (!signal.aborted) return driver.send(on);
        })
        .catch(onError);
      return Promise.resolve();
    },
  };
}

export interface WattsUpdate {
  watts: number;
  energyKwh?: number;
}

export interface WattsSource {
  subscribe(cb: (update: WattsUpdate) => void): () => void;
}

export interface HoldSource {
  subscribe(cb: (held: boolean) => void): () => void;
}

export interface ChargingSession {
  driver: ChargerDriver;
  wattsSource?: WattsSource;
  holdSource?: HoldSource;
  end(): void;
}
