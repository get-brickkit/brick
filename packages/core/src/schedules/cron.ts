/*
 * Cron expressions and intervals, without dependencies.
 *
 * A cron expression has five fields (minute hour day-of-month month
 * day-of-week) or six, with seconds first. Fields take `*`, numbers, ranges
 * (`1-5`), steps (`*\/15`, `0-30/10`, `5/10`), lists (`1,15`) and the names
 * `jan`-`dec` and `sun`-`sat`; day-of-week 7 is Sunday too. As in Vixie cron,
 * when both day fields are restricted a day matching either one matches. The
 * macros `@yearly`, `@monthly`, `@weekly`, `@daily` and `@hourly` work too.
 *
 * Times are wall-clock times in an IANA time zone. A time that does not exist
 * (it falls in the hour a DST change skips) runs when the clocks jump, shifted
 * by the gap; a time that happens twice (the hour a DST change repeats) runs
 * once, the first time.
 */

/** A parsed cron expression: the allowed values of each field. */
export interface CronExpression {
  readonly source: string;
  readonly seconds: ReadonlySet<number>;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 is Sunday. */
  readonly weekdays: ReadonlySet<number>;
  /** Both day fields are restricted: a day matches when either does. */
  readonly eitherDay: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = "jan feb mar apr may jun jul aug sep oct nov dec".split(
  " ",
);
const DAY_NAMES = "sun mon tue wed thu fri sat".split(" ");

function parseField(
  field: string,
  min: number,
  max: number,
  names: string[] = [],
  nameBase = 0,
): { values: Set<number>; star: boolean } {
  const value = (text: string): number => {
    const named = names.indexOf(text.toLowerCase());
    if (named >= 0) return named + nameBase;
    if (!/^\d+$/.test(text)) throw new Error(`'${text}' is not a number`);
    const number = Number(text);
    if (number < min || number > max)
      throw new Error(`${number} is outside ${min}-${max}`);
    return number;
  };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || !range)
      throw new Error(`'${part}' is not a valid field`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`'${stepText}' is not a valid step`);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [min, max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [from, to] = [value(a!), value(b!)];
      if (from > to) throw new Error(`'${range}' runs backwards`);
    } else {
      from = value(range);
      // `5/10` means from 5 to the end, every 10.
      to = stepText === undefined ? from : max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, star: field === "*" || field === "?" };
}

/**
 * Parse a cron expression.
 *
 * @throws When the expression is malformed.
 */
export function parseCron(expression: string): CronExpression {
  const source = expression.trim();
  const fields = (MACROS[source.toLowerCase()] ?? source).split(/\s+/);
  if (fields.length === 5) fields.unshift("0");
  if (fields.length !== 6)
    throw new Error(
      `Cron expression '${expression}' needs 5 fields (minute hour day month weekday), or 6 with seconds first`,
    );
  const [sec, min, hour, day, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  try {
    const days = parseField(day.replace("?", "*"), 1, 31);
    const weekdays = parseField(weekday.replace("?", "*"), 0, 7, DAY_NAMES);
    if (weekdays.values.delete(7)) weekdays.values.add(0);
    return {
      source,
      seconds: parseField(sec, 0, 59).values,
      minutes: parseField(min, 0, 59).values,
      hours: parseField(hour, 0, 23).values,
      days: days.values,
      months: parseField(month, 1, 12, MONTH_NAMES, 1).values,
      weekdays: weekdays.values,
      eitherDay: !days.star && !weekdays.star,
    };
  } catch (error) {
    throw new Error(
      `Cron expression '${expression}': ${(error as Error).message}`,
    );
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * @throws When `timeZone` is not an IANA time zone this runtime knows.
 */
export function checkTimeZone(timeZone: string): void {
  formatter(timeZone);
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    try {
      found = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new Error(`Unknown time zone '${timeZone}'`);
    }
    formatters.set(timeZone, found);
  }
  return found;
}

/** The wall-clock time at `instant` in `timeZone`, as if it were UTC (whole seconds). */
function wallClock(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
}

const DAY_MS = 86_400_000;

/** The offset of `timeZone` from UTC at `instant`, in milliseconds. */
const offsetAt = (instant: number, timeZone: string) =>
  wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;

/**
 * The first instant whose wall-clock time in `timeZone` is `wall`, or, when
 * a DST change skips `wall`, the instant the clocks jump past it, shifted by
 * the gap.
 */
function instantOf(wall: number, timeZone: string): number {
  const before = wall - offsetAt(wall - DAY_MS, timeZone);
  const after = wall - offsetAt(wall + DAY_MS, timeZone);
  const valid = [before, after].filter(
    (instant) => wallClock(instant, timeZone) === wall,
  );
  return valid.length ? Math.min(...valid) : before;
}

function dayMatches(cron: CronExpression, date: Date): boolean {
  const day = cron.days.has(date.getUTCDate());
  const weekday = cron.weekdays.has(date.getUTCDay());
  return cron.eitherDay ? day || weekday : day && weekday;
}

/** The first wall-clock time at or after `wall` that the expression matches, or undefined within eight years. */
function nextWall(cron: CronExpression, wall: number): number | undefined {
  const d = new Date(wall);
  const limit = d.getUTCFullYear() + 8;
  while (d.getUTCFullYear() <= limit) {
    if (!cron.months.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0);
    } else if (!dayMatches(cron, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0);
    } else if (!cron.hours.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0);
    } else if (!cron.minutes.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0);
    } else if (!cron.seconds.has(d.getUTCSeconds())) {
      d.setUTCSeconds(d.getUTCSeconds() + 1);
    } else return d.getTime();
  }
  return undefined;
}

/**
 * The first time after `after` that the expression fires in `timeZone`.
 *
 * @returns The instant, or `undefined` when it never fires (`0 0 31 2 *`).
 */
export function nextCron(
  cron: CronExpression,
  after: Date,
  timeZone = "UTC",
): Date | undefined {
  const from = after.getTime();
  // Whole seconds: the next one strictly after `from`.
  let wall = wallClock(from, timeZone) + 1000;
  for (;;) {
    const found = nextWall(cron, wall);
    if (found === undefined) return undefined;
    const instant = instantOf(found, timeZone);
    // A repeated hour: its wall times already ran the first time round.
    if (instant > from) return new Date(instant);
    wall = found + 1000;
  }
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: DAY_MS,
};

/**
 * A duration in milliseconds: a number of milliseconds, or text such as
 * `"90s"`, `"15m"`, `"6h"`, `"1d"` or `"1h30m"`.
 *
 * @throws When it is not a positive duration.
 */
export function parseDuration(duration: string | number): number {
  let ms = 0;
  if (typeof duration === "number") ms = duration;
  else {
    const text = duration.replace(/\s+/g, "");
    const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
    let match: RegExpExecArray | null;
    let read = 0;
    while ((match = pattern.exec(text))) {
      ms += Number(match[1]) * UNITS[match[2]!]!;
      read = pattern.lastIndex;
    }
    if (!text || read !== text.length) ms = NaN;
  }
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(
      `'${duration}' is not a duration: use milliseconds or text such as "15m", "6h" or "1h30m"`,
    );
  return Math.round(ms);
}
