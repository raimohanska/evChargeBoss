import { localDateString } from "../utils.ts";

export function datesInRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    dates.push(localDateString(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

export function slotsBetween(from: Date, to: Date): Date[] {
  const slots: Date[] = [];
  const t = new Date(from);
  // align to current 15-min boundary (floor) so the ongoing slot is included
  t.setMinutes(Math.floor(t.getMinutes() / 15) * 15, 0, 0);
  while (t < to) {
    slots.push(new Date(t));
    t.setMinutes(t.getMinutes() + 15);
  }
  return slots;
}
