import { addDays, atLocal, localDate, setNow } from "./clock.js";
import { blank, save, type Account } from "./store.js";

/**
 * The demo's stories. Each sets the clock and the account, then a moment later airline operations
 * change a flight and raise an alert, so Alexa+ hears about it the way it would in real life:
 * through the MCP resource it subscribed to.
 */
export const SCENES = {
  home: "Morning at home: the flight is cancelled",
  gate: "At the gate: delayed over 3 hours",
  overnight: "Evening: the last flight is cancelled",
  bag: "Next morning: the bag is late",
} as const;
export type Scene = keyof typeof SCENES;

export const TZ = "America/Chicago"; // Austin, where the story starts
const id = (n: number, from: string, to: string, date: string) => `${n}-${from}-${to}-${date}`;

let current: Scene = "home";
export const currentScene = () => current;

function base(today: string): Account {
  const acct = blank();
  const bookedAt = new Date(`${addDays(today, -21)}T15:00:00Z`).toISOString();
  acct.trips.push(
    { conf: "K7Q2PX", travelers: ["me", "maya"], flightId: id(412, "AUS", "ORD", today), seats: { me: "22C", maya: "22D" }, farePerTraveler: 189, bags: [{ tag: "BW552301", owner: "me", fee: 35 }], status: "active", bookedAt },
    { conf: "M4T8RZ", travelers: ["me", "maya"], flightId: id(423, "ORD", "AUS", addDays(today, 3)), seats: { me: "18A", maya: "18B" }, farePerTraveler: 174, bags: [], status: "active", bookedAt },
  );
  return acct;
}

/** Sets up a scene now; the returned function makes the disruption happen. */
export function setScene(scene: Scene): () => void {
  current = scene;
  const today = localDate(new Date(), TZ);
  const tomorrow = addDays(today, 1);
  const acct = base(today);
  const trip = acct.trips[0];
  const alert = (kind: "cancelled" | "delayed" | "bag") => acct.alerts.push({ id: `${scene}-${Date.now()}`, conf: trip.conf, kind, at: new Date().toISOString() });

  if (scene === "home") {
    setNow(atLocal(today, "07:30", TZ));
    acct.ops[id(1508, "AUS", "MDW", today)] = { seats: "full" };
    acct.ops[id(416, "AUS", "ORD", today)] = { seats: "apart" };
    acct.ops[id(1512, "AUS", "MDW", today)] = { seats: "together" };
    acct.ops[id(418, "AUS", "ORD", today)] = { seats: "together" };
    acct.ops[id(422, "AUS", "ORD", today)] = { seats: "full" };
    save(acct);
    return () => {
      acct.ops[id(412, "AUS", "ORD", today)] = { cancelled: true, cause: "crew" };
      alert("cancelled");
      save(acct);
    };
  }
  if (scene === "gate") {
    setNow(atLocal(today, "14:50", TZ));
    acct.ops[id(412, "AUS", "ORD", today)] = { cancelled: true, cause: "crew" };
    trip.original = trip.flightId;
    trip.flightId = id(418, "AUS", "ORD", today);
    trip.seats = { me: "14A", maya: "14B" };
    save(acct);
    return () => {
      acct.ops[id(418, "AUS", "ORD", today)] = { delay: 220, cause: "mechanical" };
      alert("delayed");
      save(acct);
    };
  }
  if (scene === "overnight") {
    setNow(atLocal(today, "20:05", TZ));
    trip.flightId = id(426, "AUS", "ORD", today);
    acct.ops[id(402, "AUS", "ORD", tomorrow)] = { seats: "together" };
    save(acct);
    return () => {
      acct.ops[id(426, "AUS", "ORD", today)] = { cancelled: true, cause: "crew" };
      alert("cancelled");
      save(acct);
    };
  }
  // bag: yesterday's flight landed, the bag didn't; it comes on this morning's first flight.
  setNow(atLocal(today, "09:00", TZ));
  trip.flightId = id(412, "AUS", "ORD", addDays(today, -1));
  trip.status = "flown";
  trip.bags[0].late = { flightId: id(402, "AUS", "ORD", today), deliverBy: atLocal(today, "14:00", TZ).toISOString() };
  save(acct);
  return () => {
    alert("bag");
    save(acct);
  };
}
