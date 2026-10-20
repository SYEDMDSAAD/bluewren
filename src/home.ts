import { addDays, atLocal, daySpoken, localDate, minutesBetween, timeSpoken } from "./air/clock.js";
import { currentScene, TZ } from "./air/scenes.js";

/**
 * The rest of Alexa+, simulated for the demo: the user's calendar, messages, rides and hotels.
 * On a real Echo these are Alexa+'s own features and partners (Uber, Expedia); Bluewren never
 * sees them. Alexa joins them up using the arrival times and places Bluewren's tools return.
 */
export interface CalEvent {
  title: string;
  at: Date;
  kind: "pickup" | "meeting";
  contact?: string;
}

export function calendar(): CalEvent[] {
  const today = localDate(new Date(), TZ);
  const scene = currentScene();
  if (scene === "home" || scene === "gate") return [{ title: "Mom picks us up at O'Hare", at: atLocal(today, "13:40", TZ), kind: "pickup", contact: "Mom" }];
  if (scene === "overnight")
    return [
      { title: "Mom picks us up at O'Hare", at: atLocal(today, "23:20", TZ), kind: "pickup", contact: "Mom" },
      { title: "Design review", at: atLocal(addDays(today, 1), "09:00", TZ), kind: "meeting" },
    ];
  return [];
}

/** Something Alexa offers to do next, and what doing it says and shows. */
export interface Offer {
  key: string;
  ask: string;
  run: () => { say: string; app: string; note: string; wire: string };
}

export function textMessage(contact: string, message: string): ReturnType<Offer["run"]> {
  return { say: `Sent to ${contact}: "${message}"`, app: `Messages · to ${contact}`, note: message, wire: `Alexa+ → Messages: text ${contact}` };
}

export function ride(place: string): ReturnType<Offer["run"]> {
  return {
    say: `Your Uber to the ${place} is 4 minutes away: a gray Toyota Camry. Pickup is at door 4 on the arrivals level. Keep the receipt, since Bluewren covers up to $40.`,
    app: "Uber",
    note: `Gray Toyota Camry, 4 min away. To ${place}.`,
    wire: `Alexa+ → Uber: ride to ${place}`,
  };
}

export function moveMeeting(title: string): ReturnType<Offer["run"]> {
  return { say: `Done. ${title} is now at 2 pm tomorrow, and I've let everyone know.`, app: "Calendar", note: `${title} moved to 2:00 pm tomorrow`, wire: `Alexa+ → Calendar: move ${title}` };
}

export function hotelSearch(city: string): ReturnType<Offer["run"]> {
  return {
    say: `On Expedia, the closest hotel with a room tonight is the Runway View Hotel, 6 minutes from the ${city} airport, for $139 with free cancellation. I've sent it to your phone to book.`,
    app: "Expedia",
    note: `Runway View Hotel · $139 tonight · 6 min from the airport`,
    wire: `Alexa+ → Expedia: hotels near ${city} airport`,
  };
}

/** Offers that follow from what Bluewren just said: who to tell, what to move, how to get there. */
export function offersFor(tool: string, data: any, done: Set<string>): Offer[] {
  const out: Offer[] = [];
  const events = calendar();
  const pickup = events.find((e) => e.kind === "pickup");
  if (data?.arrival && pickup?.contact) {
    const at = new Date(data.arrival.at);
    const day = daySpoken(at, data.arrival.tz);
    const msg = `Change of plans: we're on ${data.flight?.flight} now, landing at ${data.arrival.airport} at ${timeSpoken(at, data.arrival.tz)}${day === "today" ? "" : ` ${day}`}.`;
    const key = `text:${data.arrival.at}`;
    if (!done.has(key)) out.push({ key, ask: `${pickup.contact} is picking you up. Want me to text ${pickup.contact} your new arrival time?`, run: () => textMessage(pickup.contact!, msg) });
  }
  const meeting = events.find((e) => e.kind === "meeting");
  if (data?.arrival && meeting) {
    const at = new Date(data.arrival.at);
    const gap = minutesBetween(at, meeting.at);
    const key = `move:${meeting.title}`;
    if (gap < 90 && gap > -120 && !done.has(key))
      out.push({ key, ask: `You'd land at ${timeSpoken(at, data.arrival.tz)}, ${gap <= 0 ? "after" : "just before"} your ${timeSpoken(meeting.at, TZ)} ${meeting.title}${gap <= 0 ? " starts" : ""}. Want me to move it to the afternoon?`, run: () => moveMeeting(meeting.title) });
  }
  if (tool === "stranded_help" && data?.hotel && !done.has("ride")) out.push({ key: "ride", ask: `Want me to get an Uber to the ${data.hotel.name}?`, run: () => ride(data.hotel.name) });
  if (tool === "stranded_help" && data?.needHotel && !done.has("hotel")) out.push({ key: "hotel", ask: "Want me to find a hotel near the airport on Expedia?", run: () => hotelSearch(data.city) });
  if (tool === "request_refund" && data?.expected && pickup?.contact && !done.has("text:refund"))
    out.push({ key: "text:refund", ask: `Want me to let ${pickup.contact} know you're not flying today?`, run: () => textMessage(pickup.contact!, "Our flight was badly delayed, so we're not flying today after all. I'll call you tonight.") });
  return out;
}
