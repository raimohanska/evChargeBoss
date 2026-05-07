import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";
import { localDateTimeString } from "./date-time-format.ts";
import { log } from "./log.ts";

function getPlansDir(): string {
  return path.join(process.env.PLANS_DIR ?? ".", ".plans");
}

function getRetentionMs(): number {
  const days = parseInt(process.env.PLANS_RETENTION_DAYS ?? "7", 10);
  return (isNaN(days) ? 7 : Math.max(0, days)) * 24 * 60 * 60 * 1000;
}

/** Format a Date as a filename-safe timestamp: YYYY-MM-DDTHH-MM-SS */
export function timestampForFilename(d: Date): string {
  return localDateTimeString(d).replace(/:/g, "-");
}

/** Resolve the full path for a plan file given a prefix and timestamp. */
export function planFilePath(prefix: string, timestamp: string): string {
  return path.join(getPlansDir(), `${prefix}-${timestamp}.json`);
}

/**
 * Return the path to the newest `{prefix}-*.json` file in the plans directory,
 * or null if none exist or the directory is not readable.
 */
export function findNewestPlanFile(prefix: string): string | null {
  try {
    const dir = getPlansDir();
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".json"))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Read, JSON-parse, and validate a plan file against a Zod schema.
 * Returns null (and logs a warning) on any error or schema mismatch.
 */
export function readPlanFile<T>(filePath: string, schema: z.ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    log(`Warning: plan file ${filePath} failed validation — ignoring. ${result.error.message}`);
    return null;
  }
  return result.data;
}

/** Write data as formatted JSON to filePath, creating parent directories as needed. */
export function writePlanFile(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Delete plan files older than PLANS_RETENTION_DAYS (default 7) days.
 * Errors are swallowed — cleanup is best-effort.
 */
export function cleanOldPlanFiles(): void {
  const cutoffMs = Date.now() - getRetentionMs();
  try {
    const dir = getPlansDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const fullPath = path.join(dir, f);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs < cutoffMs) unlinkSync(fullPath);
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // plans dir doesn't exist or is unreadable — nothing to clean
  }
}
