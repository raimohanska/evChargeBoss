/** Format a Date as YYYY-MM-DD in local time, without relying on Intl/locale data. */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a Date as YYYY-MM-DDTHH:MM:SS in local time, without relying on Intl/locale data. */
export function localDateTimeString(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${localDateString(d)}T${h}:${min}:${sec}`;
}

/** Format a Date as H:MM in local time (no leading zero on hour). */
export function localTimeShort(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
