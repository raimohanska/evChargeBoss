import { readFileSync, writeFileSync } from 'fs';

export function readCache<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache<T>(file: string, data: T): void {
  writeFileSync(file, JSON.stringify(data, null, 2));
}
