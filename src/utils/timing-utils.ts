export function sleep(ms: number, signal?: CancelSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
} /** Minimal AbortController-like that works on Node 12. */
export class Canceller {
  private _listeners: Array<() => void> = [];
  readonly signal: CancelSignal = {
    aborted: false,
    addEventListener: (_ev: string, cb: () => void) => {
      if (this.signal.aborted) {
        cb();
        return;
      }
      this._listeners.push(cb);
    },
  };

  abort(): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    const ls = this._listeners.splice(0);
    for (const cb of ls) cb();
  }
}
export interface CancelSignal {
  aborted: boolean;
  addEventListener(ev: string, cb: () => void): void;
}
/**
 * A clock that can run faster than real time for testing.
 * now() returns a virtual timestamp; sleep/sleepAbortable durations are divided
 * by speedupFactor so a 15-minute slot can pass in milliseconds under test.
 */

export interface Clock {
  now(): Date;
  sleep(ms: number, signal?: CancelSignal): Promise<void>;
  /**
   * Jump virtual time forward to `target`, re-arming any in-flight sleep so it
   * still fires at its original virtual target (compressed to real time).
   * Test-only fast-forward for periods where no observable event (relay
   * command, MQTT message) is expected — the loop re-evaluates against the new
   * time on its next iteration.
   */
  jumpTo?(target: Date): void;
}
/**
 * Build a clock optionally anchored to a fixed start time and running at
 * speedupFactor × real speed. speedupFactor=1 and no startTime gives real-time behaviour.
 */

export function makeClock(speedupFactor = 1, startTime?: Date): Clock {
  let realStart = Date.now();
  let virtualNow = startTime?.getTime() ?? Date.now();
  const pendingSleeps: Array<{
    wake: () => void;
    virtualTarget: number;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  const tick = () => {
    const real = Date.now();
    virtualNow += (real - realStart) * speedupFactor;
    realStart = real;
  };

  const clearSleep = (s: (typeof pendingSleeps)[number]) => {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const i = pendingSleeps.indexOf(s);
    if (i !== -1) pendingSleeps.splice(i, 1);
  };

  return {
    now: () => {
      tick();
      return new Date(virtualNow);
    },
    sleep: (ms, signal) => {
      if (ms <= 0 || signal?.aborted) return Promise.resolve();
      tick();
      const virtualTarget = virtualNow + ms;
      return new Promise<void>((resolve) => {
        const s: (typeof pendingSleeps)[number] = {
          wake: () => {
            clearSleep(s);
            resolve();
          },
          virtualTarget,
          timer: null,
        };
        const arm = (remainingVirtualMs: number) => {
          s.timer = setTimeout(
            () => {
              if (signal?.aborted) return;
              s.wake();
            },
            Math.max(0, Math.ceil(remainingVirtualMs / speedupFactor)),
          );
        };
        pendingSleeps.push(s);
        arm(virtualTarget - virtualNow);
        signal?.addEventListener("abort", s.wake);
      });
    },
    jumpTo: (target) => {
      tick();
      if (target.getTime() <= virtualNow) return;
      virtualNow = target.getTime();
      // Re-arm in-flight sleeps against the jumped time so they still fire at
      // their original virtual target: sleeps whose target is already behind
      // fire immediately, others are compressed. This lets tests land *just
      // before* a sensitive boundary and let the loop reach it naturally.
      const sleeps = pendingSleeps.splice(0);
      for (const s of sleeps) {
        if (s.timer) {
          clearTimeout(s.timer);
          s.timer = null;
        }
        const remainingVirtualMs = s.virtualTarget - virtualNow;
        if (remainingVirtualMs <= 0) {
          s.wake();
        } else {
          s.timer = setTimeout(
            () => s.wake(),
            Math.max(0, Math.ceil(remainingVirtualMs / speedupFactor)),
          );
        }
      }
    },
  };
}

export const realClock: Clock = makeClock(1);
