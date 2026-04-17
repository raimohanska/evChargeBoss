import { readFileSync, writeFileSync } from "fs";

export function readCache<T>(file: string): T | null {
  try {
    const { date, data } = JSON.parse(readFileSync(file, "utf8"));
    if (date === new Date().toISOString().slice(0, 10)) return data as T;
  } catch { /* no cache or unreadable */ }
  return null;
}

export function writeCache<T>(file: string, data: T): void {
  writeFileSync(file, JSON.stringify({ date: new Date().toISOString().slice(0, 10), data }, null, 2));
}
