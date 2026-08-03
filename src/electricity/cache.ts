import { readFileSync, writeFileSync, renameSync } from "fs";

export function readCache<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// Write via a temp file + rename so a concurrent reader never sees a
// truncated file (the test suite runs fetchSlots from several processes
// against the same CACHE_DIR).
export function writeCache<T>(file: string, data: T): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
