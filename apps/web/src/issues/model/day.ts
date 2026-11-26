// Calendar days as `YYYY-MM-DD` text, the form the database and the due-date field use. No time zones are involved: a day
// is a day, and "today" is read from the person's own clock once, by the caller.

/** `day` moved by `count` days (negative goes back). */
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}

/** The person's today, from their local clock. */
export function localDay(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
