/**
 * The demo's clock. It runs in real time from a moment the demo scenes set ("7:30 am at home"),
 * so the same story plays the same way on any day. BW_NOW pins the start, e.g. 2026-10-20T12:30Z.
 */
let offset = process.env.BW_NOW ? Date.parse(process.env.BW_NOW) - Date.now() : 0;

export const now = (): Date => new Date(Date.now() + offset);
export function setNow(d: Date) {
  offset = d.getTime() - Date.now();
}

function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}

/** The local date at a place, YYYY-MM-DD. */
export function localDate(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Minutes after local midnight. */
export function localMinutes(d: Date, tz: string): number {
  const p = parts(d, tz);
  return p.h * 60 + p.min;
}

/** The moment a local date and time ("2026-10-20", "15:45") happens at a place. */
export function atLocal(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (t: number) => {
    const p = parts(new Date(t), tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t;
  };
  return new Date(guess - off(guess - off(guess)));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

export const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);

/** "3:45 pm" */
export function timeSpoken(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(" AM", " am").replace(" PM", " pm");
}

/** "today", "tomorrow", "yesterday" or "Thursday, October 22", seen from that place. */
export function daySpoken(d: Date, tz: string): string {
  const day = localDate(d, tz);
  const today = localDate(now(), tz);
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  if (day === addDays(today, -1)) return "yesterday";
  return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
}

/** "3:45 pm today" */
export const when = (d: Date, tz: string) => `${timeSpoken(d, tz)} ${daySpoken(d, tz)}`;

/** "3 hours 40 minutes" */
export function durationSpoken(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hs = h ? `${h} hour${h > 1 ? "s" : ""}` : "";
  const ms = m ? `${m} minute${m > 1 ? "s" : ""}` : "";
  return [hs, ms].filter(Boolean).join(" ") || "0 minutes";
}

/** n business days after a moment (Saturdays and Sundays skipped). */
export function businessDaysAfter(d: Date, n: number): Date {
  const out = new Date(d);
  while (n > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    const wd = out.getUTCDay();
    if (wd !== 0 && wd !== 6) n--;
  }
  return out;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A day as the user said it ("today", "tomorrow", "friday"), as a local date at a place. */
export function parseDay(text: string, tz: string): string | undefined {
  const t = text.trim().toLowerCase();
  const today = localDate(now(), tz);
  if (/^(today|tonight|this (morning|afternoon|evening))$/.test(t)) return today;
  if (/^tomorrow/.test(t)) return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const wd = WEEKDAYS.findIndex((w) => t.startsWith(w));
  if (wd >= 0) {
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, (wd - cur + 7) % 7 || 7);
  }
  return undefined;
}
