export function assertNotNull<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing value: ${label}`);
  return value;
}
