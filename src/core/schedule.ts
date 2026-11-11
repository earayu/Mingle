import { MingleError } from "./errors.ts";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DURATION = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) throw new MingleError("invalid_duration", `use a number and a unit, like 30m, 6h or 2d (got "${input}")`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * Next time a recurring rule fires strictly after `after`, in the process's local time zone.
 * Rules: every:<duration> | daily@HH:MM | weekly:mon,fri@HH:MM
 */
export function nextFire(rule: string, after: number): number {
  if (rule.startsWith("every:")) return after + parseDuration(rule.slice(6));
  const daily = /^daily@(\d{1,2}):(\d{2})$/.exec(rule);
  const weekly = /^weekly:([a-z,]+)@(\d{1,2}):(\d{2})$/.exec(rule);
  const [hh, mm, days] = daily
    ? [Number(daily[1]), Number(daily[2]), [0, 1, 2, 3, 4, 5, 6]]
    : weekly
      ? [Number(weekly[2]), Number(weekly[3]), (weekly[1] as string).split(",").map((d) => DAYS.indexOf(d))]
      : [Number.NaN, Number.NaN, []];
  if (Number.isNaN(hh) || hh > 23 || mm > 59 || days.length === 0 || days.includes(-1)) {
    throw new MingleError("invalid_rule", `use every:30m, daily@09:00 or weekly:mon,fri@09:00 (got "${rule}")`);
  }
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() > after && days.includes(d.getDay())) return d.getTime();
  }
  throw new MingleError("invalid_rule", `could not schedule "${rule}"`);
}
