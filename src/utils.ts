export const IS_TTY = process.stdout.isTTY === true;

export const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

/** Format a Date as YYYY-MM-DD in local time, without relying on Intl/locale data. */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a Date as YYYY-MM-DDTHH:MM:SS in local time, without relying on Intl/locale data. */
export function localDateTimeString(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${localDateString(d)}T${h}:${min}:${sec}`;
}

/** Format a Date as H:MM in local time (no leading zero on hour). */
export function localTimeShort(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function assertNotNull<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing value: ${label}`);
  return value;
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export interface CancelSignal {
  aborted: boolean;
  addEventListener(ev: string, cb: () => void): void;
}

/** Minimal AbortController-like that works on Node 12. */
export class Canceller {
  private _listeners: Array<() => void> = [];
  readonly signal: CancelSignal = {
    aborted: false,
    addEventListener: (_ev: string, cb: () => void) => {
      if (this.signal.aborted) { cb(); return; }
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

/** Like sleep(), but resolves early (without throwing) if the CancelSignal fires. */
export function sleepAbortable(ms: number, signal?: CancelSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); });
  });
}
