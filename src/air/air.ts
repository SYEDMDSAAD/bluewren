import { airport, findAirports, sameCity } from "./airports.js";
import { addDays, businessDaysAfter, daySpoken, durationSpoken, localDate, localMinutes, minutesBetween, now, parseDay, timeSpoken, when } from "./clock.js";
import { departures, flightById, label, pickSeats, status, type Flight, type Status } from "./schedule.js";
import { load, newId, save, type Trip } from "./store.js";

/** A tool's answer: what to say, and the data behind it. `next` is what a plain "yes" should do. */
export interface Answer {
  speech: string;
  needs?: "input" | "confirmation";
  data?: unknown;
  next?: { tool: string; args: Record<string, unknown> };
}

/** U.S. DOT refund rule (14 CFR 260, in force since October 28, 2024), for domestic flights. */
export const SIGNIFICANT_DELAY_MIN = 180;
export const BAG_LATE_MIN = 12 * 60;
export const MEAL_VOUCHER = 15;
export const RIDE_COVER = 40;
export const HOTEL = "Prairie Gate Inn";

const CAUSE = { crew: "a crew shortage", mechanical: "a mechanical problem", weather: "weather" } as const;
/** Problems the airline caused, where its customer service commitments cover meals and hotels. */
export const controllable = (c?: string) => c === "crew" || c === "mechanical";

export const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---------- trips ----------

function names(t: Trip): string[] {
  const acct = load();
  return t.travelers.map((id) => acct.travelers.find((p) => p.id === id)!).map((p) => (p.self ? "you" : p.first));
}
/** "you", "you and Maya" */
const party = (t: Trip) => list(names(t));

export function flightView(f: Flight) {
  const s = status(f);
  const from = airport(f.from);
  const to = airport(f.to);
  return {
    id: f.id,
    flight: label(f),
    from: f.from,
    to: f.to,
    fromCity: from.city,
    toCity: to.city,
    toShort: to.short,
    dep: s.dep.toISOString(),
    arr: s.arr.toISOString(),
    depLocal: timeSpoken(s.dep, from.tz),
    arrLocal: timeSpoken(s.arr, to.tz),
    day: daySpoken(s.dep, from.tz),
    scheduledDep: timeSpoken(f.dep, from.tz),
    status: s.cancelled ? "Cancelled" : s.delay ? `Delayed ${durationSpoken(s.delay)}` : "On time",
    gate: s.gate,
    tz: to.tz,
  };
}

export function tripView(t: Trip) {
  const acct = load();
  return {
    conf: t.conf,
    status: t.status,
    flight: flightView(flightById(t.flightId)),
    travelers: t.travelers.map((id) => ({ name: acct.travelers.find((p) => p.id === id)!.name, seat: t.seats[id] })),
    bags: t.bags.length,
    moved: !!t.original,
  };
}

/** The trip a request means: a confirmation code, a flight number, a city; else the next one. */
export function findTrip(ref?: string, pick?: (t: Trip) => boolean): Trip | undefined {
  const trips = load().trips.filter((t) => t.status !== "refunded");
  const q = (ref ?? "").trim();
  if (q) {
    const code = trips.find((t) => t.conf.toLowerCase() === q.toLowerCase());
    if (code) return code;
    const num = q.match(/\b(\d{3,4})\b/);
    if (num) {
      const byNum = trips.find((t) => flightById(t.flightId).number === Number(num[1]) || (t.original && flightById(t.original).number === Number(num[1])));
      if (byNum) return byNum;
    }
    const places = new Set(findAirports(q.replace(/\b(my|the|trip|flight|to|from|back|home)\b/gi, " ")).map((a) => a.code));
    const byPlace = trips.find((t) => places.has(flightById(t.flightId).to));
    if (byPlace) return byPlace;
    // A number or code that matches nothing must not quietly become "the next trip".
    if (/\d/.test(q)) return undefined;
  }
  const candidates = trips.filter((t) => (pick ? pick(t) : t.status === "active"));
  // A trip that has gone wrong is the one people mean by "my flight".
  const rank = (t: Trip) => (t.status === "active" && disruption(t).kind !== "none" ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b) || flightById(a.flightId).dep.getTime() - flightById(b.flightId).dep.getTime())[0];
}

const NO_TRIP: Answer = { speech: "I couldn't find that trip. You can say the confirmation code, the flight number or where you're flying to.", needs: "input" };

export type Disruption = { kind: "none" } | { kind: "cancelled"; cause?: Status["cause"] } | { kind: "delay"; minutes: number; cause?: Status["cause"] };

/** A cancellation, or a delay long enough to be a significant change under the DOT rule. */
export function disruption(t: Trip): Disruption {
  const s = status(flightById(t.flightId));
  if (s.cancelled) return { kind: "cancelled", cause: s.cause };
  if (s.delay >= SIGNIFICANT_DELAY_MIN) return { kind: "delay", minutes: s.delay, cause: s.cause };
  return { kind: "none" };
}

export function myTrips(): Answer {
  const trips = load().trips.filter((t) => t.status === "active").sort((a, b) => flightById(a.flightId).dep.getTime() - flightById(b.flightId).dep.getTime());
  if (!trips.length) return { speech: "You don't have any upcoming Bluewren trips.", data: [] };
  const said = trips.map((t) => {
    const v = flightView(flightById(t.flightId));
    const st = v.status === "On time" ? "" : `, ${v.status.toLowerCase()}`;
    return `${v.fromCity} to ${v.toCity}, ${v.flight} at ${v.scheduledDep} ${v.day}${st}`;
  });
  return { speech: `You have ${trips.length} upcoming trip${trips.length > 1 ? "s" : ""}: ${said.join("; ")}.`, data: trips.map(tripView) };
}

/** What a flight is doing, in one or two sentences. */
export function statusSpeech(f: Flight): string {
  const s = status(f);
  const from = airport(f.from);
  const to = airport(f.to);
  const name = `${label(f)} to ${to.city}`;
  if (s.cancelled) return `${name}, ${when(f.dep, from.tz)}, is cancelled because of ${CAUSE[s.cause ?? "crew"]}.`;
  if (s.arr < now()) return `${name} landed at ${to.short} at ${timeSpoken(s.arr, to.tz)} ${daySpoken(s.arr, to.tz)}.`;
  if (s.dep < now()) return `${name} is in the air and lands at ${to.short} at ${timeSpoken(s.arr, to.tz)}.`;
  if (s.delay)
    return `${name} is delayed ${durationSpoken(s.delay)}${s.cause ? ` because of ${CAUSE[s.cause]}` : ""}. It now leaves at ${when(s.dep, from.tz)} from gate ${s.gate} and lands at ${to.short} at ${timeSpoken(s.arr, to.tz)}.`;
  return `${name} is on time, leaving at ${when(s.dep, from.tz)} from gate ${s.gate} and landing at ${to.short} at ${timeSpoken(s.arr, to.tz)}.`;
}

export function flightStatus(ref?: string): Answer {
  const t = findTrip(ref);
  let f = t && flightById(t.flightId);
  if (!f && ref) {
    const num = Number(ref.match(/\d{3,4}/)?.[0]);
    const today = localDate(now(), "America/Chicago");
    f = ["AUS-ORD", "AUS-MDW", "ORD-AUS", "MDW-AUS"].flatMap((k) => departures(k.slice(0, 3), k.slice(4), today)).find((x) => x.number === num);
  }
  if (!f) return NO_TRIP;
  const d = t ? disruption(t) : { kind: "none" as const };
  const speech = statusSpeech(f);
  if (t && d.kind === "cancelled") return { speech: `${speech} Want to hear your options?`, data: tripView(t), next: { tool: "rebooking_options", args: { trip: t.conf } } };
  return { speech, data: t ? tripView(t) : flightView(f) };
}

// ---------- rebooking ----------

export interface Prefs {
  together?: boolean;
  day?: string;
  time_of_day?: "morning" | "afternoon" | "evening" | "night";
  airport?: string;
}

interface Candidate {
  f: Flight;
  s: Status;
  seats: string[];
  together: boolean;
}

const PART: Record<NonNullable<Prefs["time_of_day"]>, [number, number]> = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1260], night: [1260, 1440] };

/** Flights with room for the whole party: same city, today and the next two days, earliest arrival first. */
function candidates(t: Trip, p: Prefs = {}): Candidate[] {
  const cur = flightById(t.flightId);
  const from = airport(cur.from);
  let dests = sameCity(cur.to);
  if (p.airport) {
    const wanted = findAirports(p.airport).map((a) => a.code).filter((c) => dests.includes(c));
    if (wanted.length) dests = wanted;
  }
  const today = localDate(now(), from.tz);
  const days = p.day ? [parseDay(p.day, from.tz) ?? today] : [today, addDays(today, 1), addDays(today, 2)];
  const out: Candidate[] = [];
  for (const day of days)
    for (const to of dests)
      for (const f of departures(cur.from, to, day)) {
        if (f.id === cur.id || f.id === t.original) continue;
        const s = status(f);
        if (s.cancelled || minutesBetween(now(), s.dep) < 45) continue;
        const pick = pickSeats(f, t.travelers.length);
        if (!pick) continue;
        if (p.together && !pick.together) continue;
        if (p.time_of_day) {
          const [a, b] = PART[p.time_of_day];
          const m = localMinutes(s.dep, from.tz);
          if (m < a || m >= b) continue;
        }
        out.push({ f, s, ...pick });
      }
  return out.sort((a, b) => a.s.arr.getTime() - b.s.arr.getTime());
}

/** The flight to offer first: the earliest with seats together at the same airport. */
function best(t: Trip, cs: Candidate[]): number {
  const to = flightById(t.flightId).to;
  const i = cs.findIndex((c) => c.together && c.f.to === to);
  if (i >= 0) return i;
  const j = cs.findIndex((c) => c.together);
  return j >= 0 ? j : 0;
}

function optionView(c: Candidate, i: number) {
  return { option: i + 1, ...flightView(c.f), seats: c.seats, together: c.together };
}

function optionSpeech(t: Trip, c: Candidate): string {
  const from = airport(c.f.from);
  const to = airport(c.f.to);
  const where = c.f.to === flightById(t.flightId).to ? "" : ` to ${to.short}`;
  const seats = t.travelers.length > 1 ? (c.together ? ", seats together" : ", seats apart") : "";
  return `${when(c.s.dep, from.tz)}${where}${seats}`;
}

export function rebookingOptions(ref?: string, p: Prefs = {}): Answer {
  const t = findTrip(ref);
  if (!t) return NO_TRIP;
  const d = disruption(t);
  const cur = flightById(t.flightId);
  if (d.kind === "none") return { speech: `${statusSpeech(cur)} There's nothing to rebook. Bluewren moves you for free when it cancels your flight or delays it by 3 hours or more.`, data: tripView(t) };
  const cs = candidates(t, p).slice(0, 4);
  const acct = load();
  acct.options = { conf: t.conf, flights: cs.map((c) => c.f.id) };
  save(acct);
  const city = airport(cur.to).city;
  if (!cs.length)
    return {
      speech: `I couldn't find a Bluewren flight to ${city} with room for ${party(t)}${p.together ? " sitting together" : ""} in the next two days. You can take a full refund of ${money(refundAmount(t))} instead. Want me to check that?`,
      next: { tool: "refund_eligibility", args: { trip: t.conf } },
    };
  const items = cs.map((c, i) => `${i + 1}, ${optionSpeech(t, c)}`);
  return {
    speech: `Here are the next flights to ${city} with room for ${party(t)}: ${items.join("; ")}. Moving is free, or you can take a full refund instead. Which one?`,
    data: { conf: t.conf, options: cs.map(optionView) },
  };
}

export interface RebookPlan {
  conf: string;
  flightId: string;
  seats: string[];
  together: boolean;
}

/** The flight the user picked: an option number from the last list, or a flight number. */
export function planRebook(ref?: string, option?: number, flight?: string): RebookPlan | Answer {
  const t = findTrip(ref);
  if (!t) return NO_TRIP;
  if (disruption(t).kind === "none") return rebookingOptions(t.conf);
  const acct = load();
  let id: string | undefined;
  if (option && acct.options?.conf === t.conf) id = acct.options.flights[option - 1];
  if (!id && flight) {
    const n = Number(flight.match(/\d{3,4}/)?.[0]);
    id = candidates(t).find((c) => c.f.number === n)?.f.id;
    if (!id) return { speech: `Bluewren ${n} isn't one of the flights with room for ${party(t)}. Want to hear the ones that are?`, next: { tool: "rebooking_options", args: { trip: t.conf } } };
  }
  if (!id && !option && !flight) id = candidates(t)[best(t, candidates(t))]?.f.id;
  if (!id) return { speech: "Which flight would you like? Say the option number, like the second one.", needs: "input" };
  const pick = pickSeats(flightById(id), t.travelers.length);
  if (!pick) return { speech: "That flight just filled up. Want to hear the other options?", next: { tool: "rebooking_options", args: { trip: t.conf } } };
  return { conf: t.conf, flightId: id, ...pick };
}

/** What the user approves on their phone. */
export function rebookSummary(plan: RebookPlan): { title: string; lines: string[]; speech: string } {
  const t = findTrip(plan.conf)!;
  const v = flightView(flightById(plan.flightId));
  const cur = flightView(flightById(t.flightId));
  return {
    title: "Approve flight change",
    lines: [`From: ${cur.flight}, ${cur.scheduledDep} ${cur.day} · ${cur.status}`, `To: ${v.flight}, ${v.depLocal} ${v.day} → ${v.toShort} ${v.arrLocal}`, `Seats: ${plan.seats.join(", ")}${t.travelers.length > 1 && !plan.together ? " (not together)" : ""}`, "Cost: $0"],
    speech: `Move ${party(t)} to ${v.flight} at ${v.depLocal} ${v.day}, seats ${list(plan.seats)}.`,
  };
}

/** True when the new flight leaves on a later day than the one first booked: a night away from home. */
function overnight(t: Trip): boolean {
  const first = flightById(t.original ?? t.flightId);
  const tz = airport(first.from).tz;
  return localDate(status(flightById(t.flightId)).dep, tz) > localDate(first.dep, tz);
}

export function completeRebook(plan: RebookPlan): Answer {
  const acct = load();
  const t = acct.trips.find((x) => x.conf === plan.conf)!;
  t.original ??= t.flightId;
  t.flightId = plan.flightId;
  t.seats = Object.fromEntries(t.travelers.map((id, i) => [id, plan.seats[i]]));
  if (acct.options?.conf === t.conf) acct.options = undefined;
  save(acct);
  const f = flightById(t.flightId);
  const s = status(f);
  const to = airport(f.to);
  const seats = plan.seats.length > 1 ? `seats ${list(plan.seats)}${plan.together ? "" : ", not together"}` : `seat ${plan.seats[0]}`;
  const bag = t.bags.length ? ` Your checked bag${t.bags.length > 1 ? "s move" : " moves"} with you.` : "";
  let speech = `Done. ${cap(party(t))} are on ${label(f)} at ${when(s.dep, airport(f.from).tz)}, ${seats}, landing at ${to.short} at ${timeSpoken(s.arr, to.tz)}.${bag} New boarding passes are in the Bluewren app.`;
  const cause = status(flightById(t.original!)).cause;
  let next: Answer["next"];
  if (overnight(t) && controllable(cause) && !acct.vouchers.some((v) => v.conf === t.conf && v.kind === "hotel")) {
    speech += " You'll be staying the night, and Bluewren covers your hotel. Want the details?";
    next = { tool: "stranded_help", args: { trip: t.conf } };
  }
  return { speech, data: { ...tripView(t), arrival: { at: s.arr.toISOString(), tz: to.tz, airport: to.short, city: to.city } }, next };
}

// ---------- refunds ----------

function refundAmount(t: Trip): number {
  const bags = t.status === "flown" ? 0 : t.bags.filter((b) => !b.feeRefunded).reduce((n, b) => n + b.fee, 0);
  return t.farePerTraveler * t.travelers.length + bags;
}

export interface RefundQuote {
  conf: string;
  eligible: boolean;
  amount: number;
  why: string;
}

export function refundQuote(ref?: string): RefundQuote | Answer {
  const t = findTrip(ref);
  if (!t) return NO_TRIP;
  const d = disruption(t);
  const amount = refundAmount(t);
  if (t.status !== "active") return { speech: "That trip has already been flown, so there's no ticket to refund.", data: tripView(t) };
  const what = `${t.travelers.length > 1 ? `${t.travelers.length === 2 ? "both" : "all"} tickets` : "your ticket"}${t.bags.some((b) => !b.feeRefunded) ? " and your bag fee" : ""}`;
  const back = `${money(amount)} for ${what}, back to your ${load().card} within 7 business days`;
  if (d.kind === "cancelled")
    return { conf: t.conf, eligible: true, amount, why: `Yes. Bluewren cancelled your flight, so under the U.S. Department of Transportation's refund rule you're owed a full cash refund if you choose not to fly: ${back}. You don't have to accept a travel credit.` };
  if (d.kind === "delay")
    return {
      conf: t.conf,
      eligible: true,
      amount,
      why: `Yes. Your flight is delayed ${durationSpoken(d.minutes)}, and a delay of 3 hours or more counts as a significant change under the U.S. Department of Transportation's refund rule. So if you choose not to fly, you're owed a full cash refund: ${back}. You don't have to accept a travel credit.`,
    };
  return { conf: t.conf, eligible: false, amount, why: `${statusSpeech(flightById(t.flightId))} The cash refund rule applies when Bluewren cancels your flight or delays it by 3 hours or more, so if you cancel now, your fare becomes a Bluewren travel credit instead of cash.` };
}

export function refundEligibility(ref?: string): Answer {
  const q = refundQuote(ref);
  if ("speech" in q) return q;
  if (!q.eligible) return { speech: q.why, data: q };
  return { speech: `${q.why} Want me to request it?`, data: q, next: { tool: "request_refund", args: { what: "ticket", trip: q.conf } } };
}

export function completeTicketRefund(q: RefundQuote): Answer {
  const acct = load();
  const t = acct.trips.find((x) => x.conf === q.conf)!;
  t.status = "refunded";
  for (const b of t.bags) b.feeRefunded = true;
  const by = businessDaysAfter(now(), 7);
  acct.refunds.push({ id: newId(), conf: t.conf, what: "ticket", amount: q.amount, to: acct.card, requested: now().toISOString(), expected: by.toISOString() });
  save(acct);
  const f = flightById(t.flightId);
  const tz = airport(f.from).tz;
  return {
    speech: `Done. Your trip to ${airport(f.to).city} is cancelled, and ${money(q.amount)} is on its way to your ${acct.card}, by ${by.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" })}. The receipt is in your email.`,
    data: { conf: t.conf, amount: q.amount, to: acct.card, expected: by.toISOString() },
  };
}

// ---------- bags ----------

function lateBag(t: Trip) {
  const b = t.bags.find((x) => x.late);
  if (!b) return undefined;
  const arrived = status(flightById(t.flightId)).arr;
  return { bag: b, minutesLate: minutesBetween(arrived, now()) };
}

export function bagStatus(ref?: string): Answer {
  const t = findTrip(ref, (x) => !!x.bags.find((b) => b.late && !b.feeRefunded)) ?? findTrip(ref, (x) => x.bags.length > 0);
  if (!t) return { speech: "You don't have any checked bags on your Bluewren trips." };
  if (!t.bags.length) return { speech: "There are no checked bags on that trip." };
  const f = flightById(t.flightId);
  const to = airport(f.to);
  const late = lateBag(t);
  if (!late) {
    const moved = t.original ? ` It moved with you to ${label(f)}.` : "";
    return { speech: `Your bag is checked through to ${to.short} on ${label(f)}, and it'll be at baggage claim when you land.${moved}`, data: { conf: t.conf, bags: t.bags } };
  }
  const lf = flightById(late.bag.late!.flightId);
  const ls = status(lf);
  const deliver = new Date(late.bag.late!.deliverBy);
  let speech = `Your bag missed your flight to ${to.city}. It's on ${label(lf)}, landing at ${airport(lf.to).short} at ${timeSpoken(ls.arr, to.tz)}, and Bluewren will deliver it to your address by ${when(deliver, to.tz)}.`;
  let next: Answer["next"];
  if (late.minutesLate > BAG_LATE_MIN && !late.bag.feeRefunded) {
    speech += ` Your missing bag report is on file, and the bag is now more than 12 hours late, so under the U.S. Department of Transportation's rule your ${money(late.bag.fee)} bag fee comes back to you. Want me to request it?`;
    next = { tool: "request_refund", args: { what: "bag_fee", trip: t.conf } };
  }
  return { speech, data: { conf: t.conf, bags: t.bags, hoursLate: Math.floor(late.minutesLate / 60) }, next };
}

export function bagFeeQuote(ref?: string): { conf: string; tag: string; amount: number } | Answer {
  const t = findTrip(ref, (x) => !!x.bags.find((b) => b.late && !b.feeRefunded));
  const late = t && lateBag(t);
  if (!t || !late) return { speech: "None of your bags is late, so there's no bag fee to refund." };
  if (late.bag.feeRefunded) return { speech: "Your bag fee has already been refunded." };
  if (late.minutesLate <= BAG_LATE_MIN) return { speech: `Your bag is ${durationSpoken(late.minutesLate)} late. The bag fee comes back once it's more than 12 hours late.` };
  return { conf: t.conf, tag: late.bag.tag, amount: late.bag.fee };
}

export function completeBagFeeRefund(q: { conf: string; tag: string; amount: number }): Answer {
  const acct = load();
  const t = acct.trips.find((x) => x.conf === q.conf)!;
  t.bags.find((b) => b.tag === q.tag)!.feeRefunded = true;
  const by = businessDaysAfter(now(), 7);
  acct.refunds.push({ id: newId(), conf: t.conf, what: "bag_fee", amount: q.amount, to: acct.card, requested: now().toISOString(), expected: by.toISOString() });
  save(acct);
  return { speech: `Done. Your ${money(q.amount)} bag fee is on its way back to your ${acct.card}.`, data: { amount: q.amount, to: acct.card, expected: by.toISOString() } };
}

// ---------- stranded: meals, hotel, ride ----------

export function strandedHelp(ref?: string): Answer {
  const t = findTrip(ref);
  if (!t) return NO_TRIP;
  const cur = flightById(t.flightId);
  const s = status(cur);
  if (s.cancelled) return { speech: "Let's get you on a new flight first. Want to hear your options?", next: { tool: "rebooking_options", args: { trip: t.conf } } };
  const first = flightById(t.original ?? t.flightId);
  // What's keeping the traveler waiting now: a delay on this flight, or the cancellation of the first one.
  const what = s.delay > 0 || !t.original ? "delay" : "cancellation";
  const cause = what === "delay" ? s.cause : status(first).cause;
  const wait = minutesBetween(first.dep, s.dep);
  const night = overnight(t);
  const city = airport(cur.from).city;
  if (wait < SIGNIFICANT_DELAY_MIN && !night) return { speech: `Your wait is under 3 hours, so there are no meal or hotel vouchers for this trip. ${statusSpeech(cur)}` };
  if (!controllable(cause))
    return {
      speech: `This ${what} was caused by ${CAUSE[cause ?? "weather"]}, which is outside Bluewren's control, so Bluewren doesn't cover ${night ? "a hotel or meals" : "meals"}. Your new flight is still free.${night ? " I can look for a hotel near the airport if you'd like." : ""}`,
      data: { conf: t.conf, covered: false, needHotel: night, city },
    };
  const acct = load();
  const n = t.travelers.length;
  const had = new Set(acct.vouchers.filter((v) => v.conf === t.conf).map((v) => v.kind));
  const due: ("hotel" | "meal" | "ride")[] = night ? ["meal", "hotel", "ride"] : ["meal"];
  const vouchers = () => acct.vouchers.filter((v) => v.conf === t.conf);
  const extra = night ? { hotel: { name: HOTEL, near: `${city} airport` } } : {};

  // Already issued: say how to use them.
  if (due.every((k) => had.has(k))) {
    const hotel = night ? ` For the ${HOTEL}, give your name at the front desk; the room is already paid for. For the ride, keep the receipt and add it in the app, up to ${money(RIDE_COVER)}.` : "";
    return {
      speech: `Your vouchers are in the Bluewren app, under your trip ${t.conf}. At any restaurant in the terminal, show the QR code when you pay; each one covers up to ${money(MEAL_VOUCHER)}, and they're good until your flight leaves.${hotel}`,
      data: { conf: t.conf, covered: true, vouchers: vouchers(), ...extra },
    };
  }
  const add = (kind: "hotel" | "meal" | "ride", text: string) => !had.has(kind) && acct.vouchers.push({ id: newId(), conf: t.conf, kind, text });
  add("meal", `${n} meal voucher${n > 1 ? "s" : ""}, ${money(MEAL_VOUCHER)} each`);
  if (night) {
    add("hotel", `${HOTEL}, 1 room tonight`);
    add("ride", `Ride to the hotel, up to ${money(RIDE_COVER)}`);
  }
  save(acct);
  const meals = `${n > 1 ? `${n} meal vouchers` : "a meal voucher"} of ${money(MEAL_VOUCHER)}${n > 1 ? " each" : ""}`;
  const speech = night
    ? `Because the ${what} was Bluewren's fault, Bluewren covers tonight: a room at the ${HOTEL}, about 10 minutes from the airport, ${meals}, and your ride to the hotel, up to ${money(RIDE_COVER)}. They're in the Bluewren app now.`
    : `Because the ${what} was Bluewren's fault and your wait is 3 hours or more, you get ${meals}. They're in the Bluewren app now; show the QR code at any restaurant in the terminal.`;
  return { speech, data: { conf: t.conf, covered: true, vouchers: vouchers(), ...extra } };
}

// ---------- alerts (what Alexa says without being asked) ----------

export function tripAlerts(): Answer {
  const acct = load();
  const unread = acct.alerts.filter((a) => !a.read);
  if (!unread.length) return { speech: "No new updates on your trips.", data: { count: 0 } };
  for (const a of unread) a.read = true;
  save(acct, { quiet: true });
  const first = acct.travelers.find((p) => p.self)!.first;
  const a = unread[unread.length - 1];
  const t = acct.trips.find((x) => x.conf === a.conf)!;
  const f = flightById(t.flightId);
  const from = airport(f.from);
  const to = airport(f.to);
  const s = status(f);

  if (a.kind === "bag") {
    const b = bagStatus(t.conf);
    return { speech: `Good morning, ${first}. An update on your bag from yesterday's flight. ${b.speech}`, data: { count: unread.length, alert: a.kind }, next: b.next };
  }
  if (a.kind === "delayed")
    return {
      speech: `Heads up, ${first}. ${label(f)} to ${to.city} is now delayed ${durationSpoken(s.delay)} because of ${CAUSE[s.cause ?? "mechanical"]}. It leaves at ${timeSpoken(s.dep, from.tz)} instead of ${timeSpoken(f.dep, from.tz)}. Since that's 3 hours or more, you can choose a full cash refund instead of flying, or I can look for another flight.${controllable(s.cause) ? " Bluewren is also giving you meal vouchers for the wait." : ""} What would you like?`,
      data: { count: unread.length, alert: a.kind, ...tripView(t) },
    };

  // Cancelled: offer the best flight straight away, with the full list saved for "the second one".
  const cs = candidates(t).slice(0, 4);
  acct.options = { conf: t.conf, flights: cs.map((c) => c.f.id) };
  save(acct, { quiet: true });
  const head = `Heads up, ${first}. Your ${timeSpoken(f.dep, from.tz)} flight to ${to.city} ${daySpoken(f.dep, from.tz)}, ${label(f)}, was cancelled because of ${CAUSE[s.cause ?? "crew"]}.`;
  if (!cs.length) return { speech: `${head} I couldn't find another flight with room, but you're owed a full cash refund. Want me to check it?`, data: { count: unread.length, alert: a.kind }, next: { tool: "refund_eligibility", args: { trip: t.conf } } };
  const i = best(t, cs);
  const c = cs[i];
  const together = t.travelers.length > 1 && c.together ? ` with seats together` : "";
  const night = localDate(c.s.dep, from.tz) > localDate(f.dep, from.tz) && controllable(s.cause) ? " Bluewren will cover your hotel tonight." : "";
  return {
    speech: `${head} The best option is ${label(c.f)} at ${when(c.s.dep, from.tz)}${together}, landing at ${airport(c.f.to).short} at ${timeSpoken(c.s.arr, to.tz)}. Moving is free.${night} Want me to move ${party(t)} to it, or hear the other options?`,
    data: { count: unread.length, alert: a.kind, conf: t.conf, options: cs.map(optionView) },
    next: { tool: "rebook", args: { trip: t.conf, option: i + 1 } },
  };
}

export function refundStatus(): Answer {
  const acct = load();
  if (!acct.refunds.length) return { speech: "You don't have any refunds in progress." };
  const said = acct.refunds.map((r) => `${money(r.amount)} for ${r.what === "ticket" ? "your tickets" : "your bag fee"}, due by ${new Date(r.expected).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric" })}`);
  return { speech: `You have ${acct.refunds.length} refund${acct.refunds.length > 1 ? "s" : ""} on the way to your ${acct.card}: ${said.join("; ")}.`, data: acct.refunds };
}
