import { DateTime } from 'luxon';
import type { Schedule, Slot } from '../shared/types.js';

const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** Generate wall-clock slots, choosing the first occurrence of a repeated time. */
export function slotsBetween(schedule: Schedule, from: Date, to: Date): Slot[] {
  const zone = schedule.timezone;
  let day = DateTime.fromJSDate(from, { zone }).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromJSDate(to, { zone }).startOf('day');
  const slots: Slot[] = [];
  for (; day.toMillis() <= lastDay.toMillis(); day = day.plus({ days: 1 })) {
    if (!schedule.nights.includes(day.weekday - 1)) continue;
    const start = DateTime.fromISO(day.toISODate()!, { zone: 'UTC' }).plus({ minutes: minutes(schedule.start) });
    const end = minutes(schedule.end) + (minutes(schedule.end) <= minutes(schedule.start) ? 1440 : 0);
    for (let offset = 0; minutes(schedule.start) + offset < end; offset += schedule.intervalMinutes) {
      const wall = start.plus({ minutes: offset });
      const label = wall.toFormat('yyyy-MM-dd HH:mm');
      const actual = DateTime.fromObject({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute }, { zone });
      if (!actual.isValid || actual.toFormat('yyyy-MM-dd HH:mm') !== label) continue; // Spring gap.
      const instant = actual.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
      if (instant.toMillis() <= from.getTime() || instant.toMillis() > to.getTime()) continue;
      slots.push({ at: instant.toUTC().toISO()!, local: label, key: `${schedule.id}:${schedule.revision}:${label}` });
    }
  }
  return slots.sort((a, b) => a.at.localeCompare(b.at));
}
export function nextSlots(schedule: Schedule, now: Date, count = 3): Slot[] {
  return slotsBetween(schedule, now, new Date(now.getTime() + 9 * 86400_000)).slice(0, count);
}
export function withinWindow(schedule: Schedule, now: Date): boolean {
  const local = DateTime.fromJSDate(now, { zone: schedule.timezone });
  const clock = local.hour * 60 + local.minute;
  const start = minutes(schedule.start), end = minutes(schedule.end);
  const overnight = start > end;
  if (!(overnight ? clock >= start || clock < end : clock >= start && clock < end)) return false;
  const night = overnight && clock < end ? local.minus({ days: 1 }) : local;
  return schedule.nights.includes(night.weekday - 1);
}
