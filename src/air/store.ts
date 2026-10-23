import fs from "node:fs";
import path from "node:path";

/** The signed-in Bluewren member's account and the airline's operations for the demo, kept in one JSON file. */
export interface Traveler {
  id: string;
  name: string;
  first: string;
  age?: number;
  self?: boolean;
  aliases?: string[];
}

export interface Bag {
  tag: string;
  owner: string;
  fee: number;
  /** Set when the bag missed the flight: when it will be delivered, and on which flight it travels. */
  late?: { flightId: string; deliverBy: string };
  feeRefunded?: boolean;
}

export interface Trip {
  conf: string;
  travelers: string[];
  flightId: string;
  seats: Record<string, string>;
  farePerTraveler: number;
  bags: Bag[];
  status: "active" | "refunded" | "flown";
  /** The flight first booked, when Bluewren moved the trip to another one. */
  original?: string;
  /** Why the traveler was last moved: the flight they left was cancelled or delayed, and the cause. */
  movedBecause?: { what: "delay" | "cancellation"; cause?: "crew" | "mechanical" | "weather" };
  /** "Tell me if an earlier flight with seats together opens": watched until one does. */
  watch?: { together: boolean };
  /** Help at the airport, by traveler; it moves with the trip. */
  assistance?: { who: string; kind: AssistKind }[];
  bookedAt: string;
}

export interface Refund {
  id: string;
  conf: string;
  what: "ticket" | "bag_fee";
  amount: number;
  to: string;
  requested: string;
  expected: string;
}

export interface Voucher {
  id: string;
  conf: string;
  kind: "hotel" | "meal" | "ride";
  text: string;
}

/** What airline operations did to a flight (flight id → change). */
export interface Ops {
  cancelled?: boolean;
  delay?: number;
  cause?: "crew" | "mechanical" | "weather";
  /** Seats left: none, two apart, or a few together. */
  seats?: "full" | "apart" | "together";
  /** A new gate. */
  gate?: string;
}

export interface Alert {
  id: string;
  conf: string;
  kind: "cancelled" | "delayed" | "bag" | "gate" | "better";
  at: string;
  read?: boolean;
  /** The old gate (gate), or the flight that opened up (better). */
  detail?: string;
}

export type AssistKind = "wheelchair" | "vision" | "hearing" | "escort";

export interface Account {
  travelers: Traveler[];
  card: string;
  trips: Trip[];
  refunds: Refund[];
  vouchers: Voucher[];
  alerts: Alert[];
  ops: Record<string, Ops>;
  /** The numbered flights from the last rebooking_options, for "the second one". */
  options?: { conf: string; flights: string[] };
}

const dir = () => path.resolve(process.env.BW_STATE ?? "data/state");
const file = () => path.join(dir(), "account.json");

export function blank(): Account {
  return {
    travelers: [
      { id: "me", name: "Jordan Lee", first: "Jordan", self: true },
      { id: "maya", name: "Maya Lee", first: "Maya", age: 9, aliases: ["my daughter", "daughter", "my kid"] },
    ],
    card: "card ending 1881",
    trips: [],
    refunds: [],
    vouchers: [],
    alerts: [],
    ops: {},
  };
}

let cache: Account | undefined;

export function load(): Account {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), "utf8")) as Account;
  } catch {
    cache = blank();
  }
  return cache;
}

const listeners = new Set<() => void>();
/** Called after every change: MCP sessions tell subscribed clients that the trips changed. */
export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Saves the account; `quiet` skips telling listeners (reading alerts isn't news). */
export function save(acct: Account = load(), opts: { quiet?: boolean } = {}) {
  cache = acct;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(acct, null, 2));
  if (!opts.quiet) for (const fn of listeners) fn();
}

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newConf(): string {
  return Array.from({ length: 6 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
}
export const newId = () => Math.random().toString(36).slice(2, 10);
