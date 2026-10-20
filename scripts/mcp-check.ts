/**
 * End-to-end over MCP: starts the server, connects real MCP clients (one with form and URL
 * elicitation and a resource subscription, one with neither) and plays each demo scene.
 *   npx tsx scripts/mcp-check.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

const PORT = 8899;
const BASE = `http://localhost:${PORT}`;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "bluewren-"));
if (await fetch(`http://localhost:${PORT}/health`).then(() => true, () => false)) throw new Error(`Something is already on port ${PORT}; stop it first.`);
const server = spawn("npx", ["tsx", "src/index.ts"], { env: { ...process.env, PORT: String(PORT), BW_STATE: state, BW_VOICE: "0", BW_SCENE_DELAY_MS: "100" }, stdio: ["ignore", "pipe", "inherit"], detached: true });
await new Promise<void>((resolve, reject) => {
  server.stdout!.on("data", (d) => String(d).includes("MCP server on") && resolve());
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

// What this "traveler" answers, in order, and what they do in the app.
let answers: boolean[] = [];
let approve: "approved" | "declined" = "approved";
const asked: string[] = [];
let updated = 0;

async function connect(elicitation: boolean): Promise<Client> {
  const client = new Client({ name: "check", version: "1" }, { capabilities: elicitation ? { elicitation: { form: {}, url: {} } } : {} });
  const press = (url: string, outcome: string) => void fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `outcome=${outcome}`, redirect: "manual" });
  if (elicitation)
    client.setRequestHandler(ElicitRequestSchema, async (req): Promise<ElicitResult> => {
      const p = req.params;
      asked.push(p.mode === "url" ? `url:${p.url}` : p.message);
      if (p.mode === "url") {
        setTimeout(() => press(p.url, approve), 50);
        return { action: "accept" };
      }
      const a = answers.shift();
      return a === undefined ? { action: "decline" } : { action: "accept", content: { confirm: a } };
    });
  else
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      const url = (n.params.data as { url?: string })?.url;
      if (url) press(url, "approved");
    });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => void updated++);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  return client;
}

type Result = { speech: string; needs?: string; data?: any; next?: { tool: string; args: Record<string, unknown> } };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })) as { structuredContent?: Result }).structuredContent!;

/** Starts a scene and waits until the server says the trips changed. */
async function scene(name: string) {
  await fetch(`${BASE}/demo/scene/${name}`, { method: "POST" });
  await new Promise((r) => setTimeout(r, 500)); // the disruption happens 100 ms after the scene starts
}

try {
  const alexa = await connect(true);
  const tools = (await alexa.listTools()).tools.map((t) => t.name);
  check("10 tools listed", tools.length === 10, tools.join(","));
  await alexa.subscribeResource({ uri: "bluewren://trips" });

  // Morning at home: the 11:05 is cancelled; Alexa hears about it through the subscription.
  await scene("home");
  check("resource update sent when the flight was cancelled", updated > 0);
  const alert = await call(alexa, "trip_alerts");
  check("alert says cancelled and offers the 3:45 with seats together", /was cancelled because of a crew shortage/.test(alert.speech) && /3:45 pm today with seats together/.test(alert.speech), alert.speech);
  check("alert's next step is rebook", alert.next?.tool === "rebook", JSON.stringify(alert.next));
  check("reading alerts twice says nothing new", (await call(alexa, "trip_alerts")).data?.count === 0);
  const opts = await call(alexa, "rebooking_options", {});
  check("options include Midway and say which seats are apart", /to Midway, seats together/.test(opts.speech) && /seats apart/.test(opts.speech), opts.speech);
  const together = await call(alexa, "rebooking_options", { together: true });
  check("'together' leaves out flights with seats apart", !/seats apart/.test(together.speech), together.speech);

  asked.length = 0;
  approve = "declined";
  const no = await call(alexa, "rebook", alert.next!.args);
  check("declining in the app changes nothing", /left your booking as it was/.test(no.speech), no.speech);
  approve = "approved";
  const unknown = await call(alexa, "rebook", { flight: "999" });
  check("a flight number that isn't offered is refused, not swapped", /Bluewren 999 isn't one of the flights/.test(unknown.speech), unknown.speech);
  const asked416 = await call(alexa, "rebook", { flight: "416", trip: "416" });
  check("flight 416 asked for, 416 booked (seats apart)", /on Bluewren 416 at 1:20 pm today, seats 9B and 27E, not together/.test(asked416.speech), asked416.speech);
  await scene("home");
  const moved = await call(alexa, "rebook", { flight: "418" });
  check("approval asked in the app (URL elicitation)", asked.some((a) => a.startsWith(`url:${BASE}/approve/`)), asked.join(" | "));
  check("rebooked on the 3:45 with seats together", /^Done\. You and Maya are on Bluewren 418 at 3:45 pm today, seats 14A and 14B/.test(moved.speech), moved.speech);
  check("rebook result has the new arrival for Alexa", !!moved.data?.arrival?.at && moved.data.arrival.airport === "O'Hare", JSON.stringify(moved.data?.arrival));
  const elig = await call(alexa, "refund_eligibility", {});
  check("on-time new flight: no cash refund, credit instead", /travel credit instead of cash/.test(elig.speech), elig.speech);

  // At the gate: delayed 3 h 40 min. Cash refund is owed.
  await scene("gate");
  const gate = await call(alexa, "trip_alerts");
  check("delay alert", /delayed 3 hours 40 minutes/.test(gate.speech), gate.speech);
  const owed = await call(alexa, "refund_eligibility", {});
  check("refund owed for a delay over 3 hours: $413", /significant change/.test(owed.speech) && /\$413/.test(owed.speech) && owed.next?.tool === "request_refund", owed.speech);
  const meals = await call(alexa, "stranded_help", {});
  check("meal vouchers for a long controllable delay", /2 meal vouchers of \$15 each/.test(meals.speech), meals.speech);
  answers = [false];
  const keep = await call(alexa, "request_refund", { what: "ticket" });
  check("saying no keeps the trip", /stays booked/.test(keep.speech), keep.speech);
  asked.length = 0;
  answers = [true];
  const refunded = await call(alexa, "request_refund", { what: "ticket" });
  check("refund asked by voice first, then in the app", /This cancels your trip to Chicago/.test(asked[0] ?? "") && (asked[1] ?? "").startsWith("url:"), asked.join(" | "));
  check("refund done", /^Done\. Your trip to Chicago is cancelled, and \$413 is on its way/.test(refunded.speech), refunded.speech);
  check("refund status lists it", /\$413 for your tickets/.test((await call(alexa, "refund_status")).speech));

  // Evening: the last flight is cancelled; the first one tomorrow, a hotel tonight.
  await scene("overnight");
  const night = await call(alexa, "trip_alerts");
  check("overnight alert offers 6:30 am tomorrow and a hotel", /6:30 am tomorrow/.test(night.speech) && /cover your hotel tonight/.test(night.speech), night.speech);
  const tomorrow = await call(alexa, "rebook", night.next!.args);
  check("rebooked for tomorrow, then offers hotel details", /6:30 am tomorrow/.test(tomorrow.speech) && tomorrow.next?.tool === "stranded_help", tomorrow.speech);
  const hotel = await call(alexa, "stranded_help", {});
  check("hotel, meals and ride covered", /a room at the Prairie Gate Inn/.test(hotel.speech) && /up to \$40/.test(hotel.speech) && hotel.data?.hotel?.name === "Prairie Gate Inn", hotel.speech);

  // Next morning: the bag is late; its fee comes back.
  await scene("bag");
  const bag = await call(alexa, "trip_alerts");
  check("bag alert: delivery time and fee refund offered", /deliver it to your address by 2:00 pm/.test(bag.speech) && bag.next?.args.what === "bag_fee", bag.speech);
  answers = [true];
  const fee = await call(alexa, "request_refund", { what: "bag_fee" });
  check("bag fee refunded", /\$35 bag fee is on its way back/.test(fee.speech), fee.speech);
  check("bag fee can't be refunded twice", /None of your bags is late|already been refunded/.test((await call(alexa, "request_refund", { what: "bag_fee" })).speech));

  // A client with no elicitation: the server never changes a booking without a second call.
  await scene("home");
  const plain = await connect(false);
  const first = await call(plain, "rebook", {});
  check("no-elicitation client gets a read-back and an id", first.needs === "confirmation" && !!first.data?.confirmation_id, JSON.stringify(first));
  const acct = JSON.parse(fs.readFileSync(path.join(state, "account.json"), "utf8"));
  check("nothing changed before the second call", acct.trips[0].flightId.startsWith("412-"), acct.trips[0].flightId);
  const second = await call(plain, "rebook", { confirmation_id: first.data.confirmation_id });
  check("second call rebooks after the app approves", /^Done\./.test(second.speech), second.speech);
  check("a used confirmation id can't be used again", (await call(plain, "rebook", { confirmation_id: first.data.confirmation_id })).speech !== second.speech);
  await plain.close();
  await alexa.close();
} finally {
  process.kill(-server.pid!, "SIGTERM");
  fs.rmSync(state, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
