export const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

export function assertNotNull<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing value: ${label}`);
  return value;
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
