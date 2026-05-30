import type { Mode } from "../config.ts";

// Flags:
//   --config <path>   config file (default: config.json)  — consumed by config.ts at import time
//   --plan            plan once, print, and exit
export function parseArgs(defaultMode: Mode): { mode: Mode } {
  let mode: Mode = defaultMode;
  if (process.argv.includes("--plan")) mode = "plan";

  return { mode };
}
