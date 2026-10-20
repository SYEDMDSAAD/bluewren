import { airport, AIRPORTS, distanceKm } from "./airports.js";
import { addMinutes, atLocal } from "./clock.js";
import { load } from "./store.js";

/**
 * Bluewren's simulated timetable and seat maps. The routes in the demo story have fixed times;
 * any other pair of airports gets a few flights a day from a fixed seed, so answers repeat.
 */
export interface Flight {
  id: string; // "412-AUS-ORD-2026-10-20"
  number: number;
  from: string;
  to: string;
  date: string; // local date at the origin
  dep: Date;
  arr: Date;
}

const FIXED: Record<string, [number, string][]> = {
  "AUS-ORD": [[402, "06:30"], [412, "11:05"], [416, "13:20"], [418, "15:45"], [422, "18:10"], [426, "20:45"]],
  "AUS-MDW": [[1508, "09:50"], [1512, "14:05"], [1516, "19:30"]],
  "ORD-AUS": [[413, "07:15"], [417, "12:30"], [423, "17:55"]],
  "MDW-AUS": [[1509, "08:40"], [1513, "16:20"]],
};
const SLOTS = ["06:45", "09:30", "12:15", "15:05", "17:50", "20:30"];

export function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)), ((s ^= s >>> 16) >>> 0) / 4294967296);
}

/** Block time: cruising at about 780 km/h, plus taxi and climb, in 5-minute steps. */
function blockMinutes(from: string, to: string): number {
  return Math.round((distanceKm(airport(from), airport(to)) / 780) * 12 + 7) * 5;
}

function flight(number: number, from: string, to: string, date: string, time: string): Flight {
  const dep = atLocal(date, time, airport(from).tz);
  return { id: `${number}-${from}-${to}-${date}`, number, from, to, date, dep, arr: addMinutes(dep, blockMinutes(from, to)) };
}

/** Bluewren's flights from one airport to another on a local date. */
export function departures(from: string, to: string, date: string): Flight[] {
  if (from === to || !AIRPORTS.has(from) || !AIRPORTS.has(to)) return [];
  const fixed = FIXED[`${from}-${to}`];
  if (fixed) return fixed.map(([n, t]) => flight(n, from, to, date, t));
  const h = hash(`${from}-${to}`);
  const count = 3 + (h % 3);
  const step = SLOTS.length / count;
  return Array.from({ length: count }, (_, i) => flight(2000 + (h % 700) * 10 + i, from, to, date, SLOTS[Math.floor(i * step)]));
}

export function flightById(id: string): Flight {
  const m = id.match(/^(\d+)-([A-Z]{3})-([A-Z]{3})-(\d{4}-\d{2}-\d{2})$/);
  if (!m) throw new Error(`Bad flight id ${id}`);
  const f = departures(m[2], m[3], m[4]).find((x) => x.number === Number(m[1]));
  if (!f) throw new Error(`No flight ${id}`);
  return f;
}

export const label = (f: Flight) => `Bluewren ${f.number}`;

/** Where the flight stands: cancelled, or delayed, and its estimated times. */
export interface Status {
  cancelled: boolean;
  delay: number;
  cause?: "crew" | "mechanical" | "weather";
  dep: Date;
  arr: Date;
  gate: string;
}

export function status(f: Flight): Status {
  const o = load().ops[f.id] ?? {};
  const delay = o.cancelled ? 0 : o.delay ?? 0;
  const h = hash(f.id);
  return { cancelled: !!o.cancelled, delay, cause: o.cause, dep: addMinutes(f.dep, delay), arr: addMinutes(f.arr, delay), gate: `${"ABC"[h % 3]}${2 + (h % 28)}` };
}

// ---------- seats ----------

const ROWS = 30;
const SEAT_LETTERS = "ABCDEF";

/** Free seats on a flight: a seeded map, the demo's overrides, minus seats our travelers hold. */
export function freeSeats(f: Flight): string[] {
  const acct = load();
  const o = acct.ops[f.id]?.seats;
  let free: string[];
  if (o === "full") free = [];
  else if (o === "apart") free = ["9B", "27E"];
  else if (o === "together") free = ["14A", "14B", "26F"];
  else {
    const r = rng(hash(f.id));
    const occupancy = 0.72 + r() * 0.2;
    free = [];
    for (let row = 1; row <= ROWS; row++) for (const l of SEAT_LETTERS) if (r() > occupancy) free.push(`${row}${l}`);
  }
  const held = new Set(acct.trips.filter((t) => t.status === "active" && t.flightId === f.id).flatMap((t) => Object.values(t.seats)));
  return free.filter((s) => !held.has(s));
}

/** Seats for a party: side by side in one row block if possible, else any free seats. */
export function pickSeats(f: Flight, n: number): { seats: string[]; together: boolean } | undefined {
  const free = new Set(freeSeats(f));
  if (free.size < n) return undefined;
  if (n === 1) return { seats: [[...free][0]], together: true };
  for (let row = 1; row <= ROWS; row++)
    for (const block of ["ABC", "DEF"])
      for (let i = 0; i + n <= 3; i++) {
        const seats = [...block.slice(i, i + n)].map((l) => `${row}${l}`);
        if (seats.every((s) => free.has(s))) return { seats, together: true };
      }
  return { seats: [...free].slice(0, n), together: false };
}
