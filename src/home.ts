import { addDays, atLocal, daySpoken, localDate, minutesBetween, timeSpoken } from "./air/clock.js";
import { currentScene, TZ } from "./air/scenes.js";

/**
 * The rest of Alexa+, simulated for the demo: the user's calendar, messages, rides and hotels.
 * On a real Echo these are Alexa+'s own features and partners (rides, hotel booking); Bluewren never
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
  if (scene === "home" || scene === "gate" || scene === "boarding") return [{ title: "Mom picks us up at O'Hare", at: atLocal(today, "13:40", TZ), kind: "pickup", contact: "Mom" }];
  if (scene === "overnight" || scene === "weather")
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
  run: () => Done;
}
/** What doing an offer says and shows; it can lead to more offers, or a hotel to ride to. */
export interface Done {
  say: string;
  app: string;
  note: string;
  wire: string;
  then?: Offer[];
  hotel?: string;
}

export function textMessage(contact: string, message: string): Done {
  return { say: `Sent to ${contact}: "${message}"`, app: `Messages · to ${contact}`, note: message, wire: `Alexa+ → Messages: text ${contact}` };
}

/** A ride. `cover` is what the airline pays toward it, if anything. */
export function ride(place: string, cover?: number): Done {
  const to = /^(the |\d)/i.test(place) || !/\b(inn|hotel|suites|lodge)\b/i.test(place) ? place : `the ${place}`;
  return {
    say: `Your ride to ${to} is 4 minutes away: a gray sedan. Pickup is at door 4 on the arrivals level.${cover ? ` Keep the receipt, since Bluewren covers up to $${cover}.` : ""}`,
    app: "Ride",
    note: `Gray sedan, 4 min away. To ${place}.`,
    wire: `Alexa+ → ride partner: ride to ${place}`,
  };
}

export function moveMeeting(title: string): Done {
  return { say: `Done. ${title} is now at 2 pm tomorrow, and I've let everyone know.`, app: "Calendar", note: `${title} moved to 2:00 pm tomorrow`, wire: `Alexa+ → Calendar: move ${title}` };
}

/** Alexa+'s hotel booking, when the airline doesn't pay for the night: find one, then book it on a second yes. */
export function hotelSearch(city: string): Done {
  const name = "Runway View Hotel";
  return {
    say: `The closest hotel with a room tonight is the ${name}, 6 minutes from the ${city} airport: $139, with free cancellation until 6 pm.`,
    app: "Hotels",
    note: `${name} · $139 tonight · 6 min from the airport`,
    wire: `Alexa+ → hotel partner: hotels near ${city} airport`,
    then: [
      {
        key: "hotel:book",
        ask: `Want me to book it for $139 with the card on your Amazon account?`,
        run: () => ({
          say: `Booked. Your room at the ${name} is ready tonight, and the confirmation is on your phone.`,
          app: "Hotels",
          note: `Booked: ${name}, tonight, $139. Free cancellation until 6 pm.`,
          wire: `Alexa+ → hotel partner: book ${name}`,
          hotel: name,
          then: [{ key: "ride", ask: `Want me to get you a ride to the ${name}?`, run: () => ride(name) }],
        }),
      },
    ],
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
  if (tool === "stranded_help" && data?.hotel && !done.has("ride")) out.push({ key: "ride", ask: `Want me to get you a ride to the ${data.hotel.name}?`, run: () => ride(data.hotel.name, data.rideCover) });
  if (data?.needHotel && !done.has("hotel")) out.push({ key: "hotel", ask: "Want me to find you a hotel near the airport?", run: () => hotelSearch(data.city) });
  if (tool === "request_refund" && data?.expected && pickup?.contact && !done.has("text:refund"))
    out.push({ key: "text:refund", ask: `Want me to let ${pickup.contact} know you're not flying today?`, run: () => textMessage(pickup.contact!, "Change of plans: our flight fell through, so we're not flying today after all. I'll call you tonight.") });
  // Tonight's bed and the ride there come before messages and meetings.
  const urgent = (o: Offer) => (o.key === "hotel" || o.key === "ride" ? 0 : 1);
  return out.sort((a, b) => urgent(a) - urgent(b));
}
