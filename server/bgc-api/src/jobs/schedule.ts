// When a schedule is due, on a clock in the worker's time zone (4:00 means 4:00 in Michigan, as n8n's did).
import type { Schedule } from './types.js';

export type Clock = { day: string; minute: number; epoch: number }; // local date, minute of the local day, and ms since 1970

export function clock(now: Date, tz: string): Clock {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const p = (t: string) => parts.find((x) => x.type === t)?.value || '00';
  return { day: `${p('year')}-${p('month')}-${p('day')}`, minute: Number(p('hour')) * 60 + Number(p('minute')), epoch: now.getTime() };
}

export type LastRun = { day: string; minute: number; epoch: number } | null;

// Whether a job should run now, given when it last did. A daily job that was missed (the worker was down at 4:00) still
// runs if it's within two hours of its time; an hourly one within the hour.
export function isDue(s: Schedule, c: Clock, last: LastRun): boolean {
  if ('everyMinutes' in s) return !last || c.epoch - last.epoch >= s.everyMinutes * 60_000;
  if ('hourlyAt' in s) {
    const sameHour = !!last && last.day === c.day && Math.floor(last.minute / 60) === Math.floor(c.minute / 60);
    return !sameHour && c.minute % 60 >= s.hourlyAt;
  }
  const [h, m] = s.at.split(':').map(Number);
  const target = h * 60 + m;
  const today = !!last && last.day === c.day && last.minute >= target;
  return !today && c.minute >= target && c.minute < target + 120;
}
