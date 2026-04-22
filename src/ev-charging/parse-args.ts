import type { Mode } from "../config.ts";

// Flags:
//   --config <path>   config file (default: config.json)  — consumed by config.ts at import time
//   --plan            plan once, print, and exit
//   --from <date>     start planning from a past date (e.g. 2026-04-18T08:00)
export function parseArgs(defaultMode: Mode): { mode: Mode; from?: Date } {
  const argv = process.argv.slice(2);

  const fromIdx = argv.indexOf("--from");
  let from: Date | undefined;
  if (fromIdx !== -1) {
    const raw = argv[fromIdx + 1];
    if (!raw) throw new Error("--from requires a value, e.g. --from 2026-04-18T08:00");
    from = new Date(raw);
    if (isNaN(from.getTime())) throw new Error(`--from: invalid date "${raw}"`);
  }

  let mode: Mode = defaultMode;
  if (argv.includes("--plan")) mode = "plan";

  return { mode, from };
}
