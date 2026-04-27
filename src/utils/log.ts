import { localDateTimeString } from "./date-time-format.ts";

export const log = (msg: string) => console.log(`[${localDateTimeString(new Date())}] ${msg}`);
