import { localDateTimeString } from "./date-time-format.ts";

/**
 * Returns a logger bound to the given category.
 * Every log line is prefixed with a timestamp and the category so logs are
 * easily grep-able even across mixed output.  Multiline messages are split
 * and each line receives its own prefix.
 *
 * Usage (at module top-level):
 *   const log = makeLogger("ev-charging");
 */
export function makeLogger(category: string): (msg: string) => void {
  return (msg: string) => {
    const ts = localDateTimeString(new Date());
    for (const line of msg.split("\n")) {
      console.log(`[${ts}] [${category}] ${line}`);
    }
  };
}
