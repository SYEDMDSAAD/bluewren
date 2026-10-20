import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ResourceUpdatedNotificationSchema, type ElicitResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Response } from "express";
import { now } from "./air/clock.js";
import { TZ } from "./air/scenes.js";
import { calendar, hotelSearch, moveMeeting, offersFor, ride, textMessage, type Done, type Offer } from "./home.js";

/**
 * A stand-in for Alexa+, for the demo page. It connects to the Bluewren MCP server like any MCP
 * client, subscribes to the traveler's trips so it can speak up when a flight changes, picks a tool
 * for what the user said with a small local model (Ollama), and turns the server's elicitations into
 * spoken questions (form mode) or the phone screen (URL mode). It also plays the parts of Alexa+
 * that aren't Bluewren's: texting family, rides, hotels and the calendar, all simulated.
 */
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.BW_MODEL ?? "qwen2.5-coder:7b";
const TRIPS = "bluewren://trips";

export type Event =
  | { type: "user"; text: string }
  | { type: "thinking"; text: string }
  | { type: "say"; text: string; card?: unknown; tool?: string; question?: boolean; proactive?: boolean }
  | { type: "phone"; url: string; text: string }
  | { type: "note"; app: string; text: string }
  | { type: "mcp"; dir: "out" | "in" | "alexa"; text: string }
  | { type: "idle" };

const MCP_ACTIONS = ["my_trips", "flight_status", "rebooking_options", "rebook", "watch_for_better", "refund_eligibility", "request_refund", "refund_status", "stranded_help", "request_assistance", "bag_status"];
const ALEXA_ACTIONS = ["send_text", "book_ride", "move_meeting", "find_hotel"];

/** The one form the router fills: the action and every argument any action takes. */
const FORM = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...MCP_ACTIONS, ...ALEXA_ACTIONS, "chat"] },
    trip: { type: "string" },
    option: { type: "number" },
    flight: { type: "string" },
    together: { type: "boolean" },
    day: { type: "string" },
    time_of_day: { type: "string", enum: ["", "morning", "afternoon", "evening", "night"] },
    airport: { type: "string" },
    what: { type: "string", enum: ["", "ticket", "bag_fee"] },
    contact: { type: "string" },
    message: { type: "string" },
    place: { type: "string" },
    who: { type: "string" },
    kind: { type: "string", enum: ["", "wheelchair", "vision", "hearing", "escort"] },
    reply: { type: "string" },
  },
  required: ["action"],
};

function routerPrompt(): string {
  const today = now().toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `You are Alexa with the Bluewren Air skill linked. It is ${today}. The user is Jordan, traveling with their daughter Maya.
Pick the action for what the user said and fill only the fields it uses; leave the rest empty.
my_trips: my trips, my flights, what's coming up
flight_status: is my flight on time, delayed, cancelled, which gate (trip)
rebooking_options: other flights, what are my options, get me on another flight, a later or earlier flight, any flights tomorrow or tonight (trip, together, day, time_of_day, airport)
rebook: move me to a flight, take the 3:45, the second one, book that one (option, flight)
watch_for_better: tell me or let me know if an earlier flight or seats together open up (together)
refund_eligibility: can I get my money back, am I owed a refund
request_refund: refund it, cancel and refund, I don't want to fly anymore, refund my bag fee (what)
refund_status: where is my refund
stranded_help: hotel, meal vouchers, food, where do we stay tonight
bag_status: where is my bag, my luggage
request_assistance: wheelchair, help getting to the gate, someone who is blind or deaf, special assistance (who, kind)
send_text: text or tell someone (contact, message)
book_ride: get an Uber, a ride, a taxi (place)
move_meeting: move or reschedule my meeting
find_hotel: find a hotel to pay for myself
chat: greetings, thanks, anything else (reply: one short friendly sentence)
Rules: "the second one" = option 2. "next to my daughter", "sit together" = together true. Copy days as said ("tomorrow"). Flight numbers are 3 or 4 digits.`;
}

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|please|confirm|correct|right|of course|absolutely|definitely|sounds good|that works|perfect)\b/i;
const NO = /^(no|nope|nah|don'?t|do not|cancel|stop|never ?mind|not now|leave it|wait|skip)\b/i;

type Pending = { kind: "tool"; name: string; args: Record<string, unknown> } | { kind: "offer"; offer: Offer };

export class Conversation {
  private client?: Client;
  private tools: Tool[] = [];
  private history: { role: "user" | "assistant"; content: string }[] = [];
  private listeners = new Set<Response>();
  private form?: { keys: string[]; resolve: (r: ElicitResult) => void };
  private running?: Promise<void>;
  private pending?: Pending;
  /** An approval is open in the app on the user's phone. */
  private onPhone = false;
  /** Update notices that arrive just after Alexa's own request are echoes of it. */
  private quietUntil = 0;
  /** The hotel Bluewren is paying for tonight, once it has said so. */
  private hotel?: { name: string; cover?: number };
  private offers: Offer[] = [];
  private done = new Set<string>();
  /** The numbered flights Alexa last read out, for "the 3:45" or "the Midway one". */
  private options: { option: number; depLocal: string; toShort: string; flight: string }[] = [];
  lastSeen = Date.now();

  constructor(private mcpUrl: string) {}

  listen(res: Response) {
    this.listeners.add(res);
    res.on("close", () => this.listeners.delete(res));
  }

  private emit(e: Event) {
    for (const res of this.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "alexa-plus-simulator", version: "0.1.0" }, { capabilities: { elicitation: { form: {}, url: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const p = req.params;
      if (p.mode === "url") {
        this.onPhone = true;
        this.emit({ type: "mcp", dir: "in", text: `elicitation/create (url) ${new URL(p.url).pathname}` });
        this.emit({ type: "phone", url: p.url, text: p.message });
        this.emit({ type: "say", text: p.message });
        // Accepting a URL elicitation means "the user was shown it"; the server waits for the approval itself.
        this.emit({ type: "mcp", dir: "out", text: "elicitation result: accept (opened on phone)" });
        return { action: "accept" };
      }
      this.emit({ type: "mcp", dir: "in", text: `elicitation/create (form) ${Object.keys(p.requestedSchema.properties).join(", ")}` });
      this.emit({ type: "say", text: p.message, question: true });
      this.emit({ type: "idle" });
      return new Promise<ElicitResult>((resolve) => (this.form = { keys: Object.keys(p.requestedSchema.properties), resolve }));
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      // Changes made while Alexa is mid-request are its own doing (a rebooking, a refund), not news.
      if (n.params.uri !== TRIPS || this.running || this.form || Date.now() < this.quietUntil) return;
      this.emit({ type: "mcp", dir: "in", text: `notifications/resources/updated ${TRIPS}` });
      this.checkAlerts();
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
    this.tools = (await client.listTools()).tools;
    await client.subscribeResource({ uri: TRIPS });
    this.emit({ type: "mcp", dir: "out", text: `initialize · tools/list → ${this.tools.length} tools · resources/subscribe ${TRIPS}` });
    this.client = client;
    return client;
  }

  /** A new demo scene: nothing said before applies. */
  forget() {
    this.history = [];
    this.pending = undefined;
    this.offers = [];
    this.done.clear();
    this.options = [];
    this.hotel = undefined;
  }

  /** Called when the page opens, so Alexa is subscribed before anything happens. */
  async ready() {
    try {
      await this.connect();
    } catch (e) {
      console.error("connect failed:", e);
    }
  }

  /** Airline operations changed a trip: hear what's new and say it unprompted. */
  private checkAlerts() {
    this.running = (async () => {
      const r = await this.call("trip_alerts", {}, true);
      if (r && (r.data as { count?: number })?.count) this.respond("trip_alerts", r, true);
    })()
      .catch((e) => console.error("alert check failed:", e))
      .finally(() => this.finish());
  }

  private finish() {
    this.running = undefined;
    this.onPhone = false;
    this.emit({ type: "idle" });
  }

  /** One thing the user said. */
  async hear(text: string): Promise<void> {
    this.lastSeen = Date.now();
    this.emit({ type: "user", text });
    const said = text.trim().replace(/^(alexa|ok alexa|hey alexa)[, ]*/i, "");
    if (this.form) return this.answerForm(said);
    if (this.running) {
      this.emit({ type: "say", text: this.onPhone ? "I'm waiting for you to approve it in the Bluewren app on your phone. Tap Approve there, or Decline to leave things as they are." : "One moment, I'm still on your last request." });
      return;
    }
    this.running = this.turn(said)
      .catch((e) => {
        console.error("turn failed:", e);
        this.emit({ type: "say", text: "Sorry, I couldn't reach Bluewren just now. Please try again." });
      })
      .finally(() => this.finish());
  }

  private answerForm(said: string) {
    const form = this.form!;
    this.form = undefined;
    const yes = YES.test(said) && !NO.test(said);
    const result: ElicitResult = yes ? { action: "accept", content: Object.fromEntries(form.keys.map((k) => [k, true])) } : NO.test(said) ? { action: "accept", content: Object.fromEntries(form.keys.map((k) => [k, false])) } : { action: "decline" };
    this.emit({ type: "mcp", dir: "out", text: `elicitation result: ${result.action} ${result.content ? JSON.stringify(result.content) : ""}` });
    this.history.push({ role: "user", content: said });
    form.resolve(result);
  }

  private async turn(text: string) {
    await this.connect();
    const pending = this.pending;
    this.pending = undefined;
    // A plain yes or no answers the question Alexa just asked.
    if (pending && YES.test(text) && !NO.test(text)) {
      this.history.push({ role: "user", content: text });
      if (pending.kind === "offer") return this.runOffer(pending.offer);
      const r = await this.call(pending.name, pending.args);
      if (r) this.respond(pending.name, r);
      return;
    }
    if (pending && NO.test(text) && text.split(" ").length <= 4) {
      this.history.push({ role: "user", content: text });
      if (!this.nextOffer()) this.say(pending.kind === "offer" ? "Okay." : "Okay. Just ask if you need anything else.");
      return;
    }
    this.offers = [];

    this.emit({ type: "thinking", text: "Thinking…" });
    const choice = await this.choose(text);
    this.history.push({ role: "user", content: text });
    if (!choice) return this.say("Sorry, I didn't catch that.");
    if ("say" in choice) return this.say(choice.say);
    if (ALEXA_ACTIONS.includes(choice.name)) return this.alexaAction(choice.name, choice.args);
    const r = await this.call(choice.name, choice.args);
    const watchToo = choice.name === "rebook" && /\b(let me know|tell me|notify|watch|keep an eye|alert me)\b/i.test(text);
    const hotelToo = choice.name !== "stranded_help" && /\b(hotel|stay the night|overnight|sleep|room)\b/i.test(text);
    const rideToo = /\b(cab|uber|lyft|taxi|ride)\b/i.test(text);
    // Alexa's own questions wait until every part of the sentence is done.
    if (r) this.respond(choice.name, r, false, !(watchToo || hotelToo || rideToo));
    // "…but tell me if something earlier opens", "…and we need a hotel", "…and also book a cab":
    // a second request in the same sentence isn't dropped.
    if (r && watchToo) {
      const w = await this.call("watch_for_better", /\btogether\b/i.test(text) ? { together: true } : {});
      if (w) this.respond("watch_for_better", w, false, false);
    }
    if (r && hotelToo) {
      const p = this.pending as Pending | undefined; // set by the reply just given
      if (p?.kind === "tool" && p.name === "stranded_help") this.pending = undefined;
      const h = await this.call("stranded_help", {});
      if (h) this.respond("stranded_help", h, false, false);
    }
    if (r && rideToo) await this.bookRide({});
    else if (r && (watchToo || hotelToo) && !this.pending) this.nextOffer();
  }

  /** A ride. With no clear destination it goes to the hotel Bluewren is paying for, asking Bluewren first if needed. */
  private async bookRide(args: Record<string, unknown>) {
    const said = typeof args.place === "string" ? args.place.trim() : "";
    const toHotel = !said || /\b(hotel|inn|there|chicago|austin)\b/i.test(said);
    if (toHotel && !this.hotel) {
      if (this.pending?.kind === "tool" && this.pending.name === "stranded_help") this.pending = undefined;
      const r = await this.call("stranded_help", {});
      if (r) this.respond("stranded_help", r, false, false);
    }
    if (toHotel && !this.hotel) return this.say("Where should the ride take you?");
    this.done.add("ride");
    this.offers = this.offers.filter((o) => o.key !== "ride");
    if (this.pending?.kind === "offer" && this.pending.offer.key === "ride") this.pending = undefined;
    this.show(toHotel ? ride(this.hotel!.name, this.hotel!.cover) : ride(said));
    if (!this.pending) this.nextOffer();
  }

  private say(text: string, extra: Partial<Extract<Event, { type: "say" }>> = {}) {
    this.emit({ type: "say", text, ...extra });
    this.history.push({ role: "assistant", content: text });
    this.history = this.history.slice(-8);
  }

  private async call(name: string, args: Record<string, unknown>, quiet = false): Promise<{ speech: string; data?: unknown; next?: { tool: string; args: Record<string, unknown> } } | undefined> {
    const client = await this.connect();
    this.emit({ type: "mcp", dir: "out", text: `tools/call ${name} ${JSON.stringify(args)}` });
    if (!quiet) this.emit({ type: "thinking", text: `Asking Bluewren (${name})…` });
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60_000, resetTimeoutOnProgress: true });
    this.onPhone = false;
    if (name !== "trip_alerts") this.quietUntil = Date.now() + 1500;
    const sc = res.structuredContent as { speech?: string; data?: unknown; next?: { tool: string; args: Record<string, unknown> } } | undefined;
    const speech = sc?.speech ?? (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "Sorry, something went wrong.";
    this.emit({ type: "mcp", dir: "in", text: `result ${name}: ${speech.slice(0, 80)}${speech.length > 80 ? "…" : ""}${sc?.next ? ` · next: ${sc.next.tool}` : ""}` });
    return { speech, data: sc?.data, next: sc?.next };
  }

  /** Says a tool's reply, then offers what Bluewren suggests next, or what Alexa+ can do with it. */
  private respond(tool: string, r: { speech: string; data?: unknown; next?: { tool: string; args: Record<string, unknown> } }, proactive = false, prompt = true) {
    const opts = (r.data as { options?: { option: number; depLocal: string; toShort: string; flight: string }[] })?.options;
    if (opts?.length) this.options = opts;
    const hotel = (r.data as { hotel?: { name: string }; rideCover?: number })?.hotel;
    if (hotel) this.hotel = { name: hotel.name, cover: (r.data as { rideCover?: number }).rideCover };
    this.say(r.speech, { card: r.data, tool, proactive, question: !!r.next });
    // Alexa's own offers wait until Bluewren's suggested step is answered.
    const fresh = offersFor(tool, r.data, this.done);
    this.offers = [...fresh, ...this.offers.filter((o) => !fresh.some((f) => f.key === o.key))];
    if (r.next) {
      this.pending = { kind: "tool", name: r.next.tool, args: r.next.args };
      return;
    }
    if (prompt) this.nextOffer();
  }

  private nextOffer(): boolean {
    const o = this.offers.shift();
    if (!o) return false;
    this.pending = { kind: "offer", offer: o };
    this.say(o.ask, { question: true });
    return true;
  }

  private runOffer(o: Offer) {
    this.done.add(o.key);
    const r = o.run();
    if (r.hotel) this.hotel = { name: r.hotel };
    if (r.then) this.offers = [...r.then.filter((x) => !this.done.has(x.key)), ...this.offers];
    this.show(r);
    this.nextOffer();
  }

  private show(r: Done) {
    this.emit({ type: "mcp", dir: "alexa", text: `${r.wire} (simulated)` });
    this.emit({ type: "note", app: r.app, text: r.note });
    this.say(r.say);
  }

  /** The parts of Alexa+ that aren't Bluewren's, asked for directly. */
  private async alexaAction(name: string, args: Record<string, unknown>) {
    const events = calendar();
    if (name === "send_text") {
      const contact = String(args.contact ?? events.find((e) => e.contact)?.contact ?? "Mom");
      const message = String(args.message ?? "Our flight plans changed. I'll send you the details soon.");
      this.done.add(`text:${contact}`);
      return this.show(textMessage(contact, message));
    }
    if (name === "book_ride") return this.bookRide(args);
    if (name === "move_meeting") {
      const m = events.find((e) => e.kind === "meeting");
      if (!m) return this.say("You don't have any meetings coming up.");
      this.done.add(`move:${m.title}`);
      return this.show(moveMeeting(m.title));
    }
    return this.runOffer({ key: "hotel", ask: "", run: () => hotelSearch("Austin") });
  }

  /**
   * Which action, with which arguments, for what the user said. A small local model fills one flat
   * form (Ollama structured output); then only what the user actually said is kept.
   */
  async choose(text: string): Promise<{ name: string; args: Record<string, unknown> } | { say: string } | undefined> {
    const recent = this.history.slice(-4).map((m) => `${m.role === "user" ? "User" : "Alexa"}: ${m.content.slice(0, 220)}`).join("\n");
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        keep_alive: "30m",
        format: FORM,
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          { role: "system", content: `${routerPrompt()}${recent ? `\n\nConversation so far:\n${recent}` : ""}` },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const j = JSON.parse(((await res.json()) as { message: { content: string } }).message.content) as Record<string, unknown>;
    const action = String(j.action ?? "");
    if (action === "chat" || ![...MCP_ACTIONS, ...ALEXA_ACTIONS].includes(action)) return typeof j.reply === "string" && j.reply.trim() ? { say: j.reply.trim().slice(0, 300) } : undefined;
    const allowed = MCP_ACTIONS.includes(action) ? Object.keys(this.tools.find((t) => t.name === action)?.inputSchema.properties ?? {}) : ["contact", "message", "place"];
    const args = clean(Object.fromEntries(Object.entries(j).filter(([k]) => allowed.includes(k))));
    // A bag fee is only ever refunded, never "checked": that question is the refund itself.
    let name = action === "refund_eligibility" && /\bbag fee\b/i.test(text) ? "request_refund" : action;
    // Naming the time of a flight Alexa just listed picks it, whatever else the sentence asks.
    if (name !== "rebook" && !["flight_status", "my_trips"].includes(name) && optionAt(text, this.options)) name = "rebook";
    return { name, args: ground(name, name === action ? args : {}, text, this.options) };
  }
}

// "the second one" must not match "one": only ordinals, or a number after "option"/"number".
/** An option whose departure time the user said: "the 6:30", "6 30 am", "630 am", "6 am". */
export function optionAt<T extends { option: number; depLocal: string }>(text: string, options: T[]): T | undefined {
  const t = text.toLowerCase();
  const m = t.match(/\b(\d{1,2})(?:[: ]?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/) ?? t.match(/\b(\d{1,2})[: ](\d{2})\b/);
  if (!m) return undefined;
  const at = `${Number(m[1])}:${m[2] ?? "00"}`;
  const half = m[3] ? (m[3][0] === "a" ? "am" : "pm") : undefined;
  return options.find((o) => o.depLocal.startsWith(`${at} `) && (!half || o.depLocal.endsWith(half)));
}

const ORDINALS: [RegExp, number][] = [[/\b(first|1st|(option|number) (1|one))\b/, 1], [/\b(second|2nd|(option|number) (2|two))\b/, 2], [/\b(third|3rd|(option|number) (3|three))\b/, 3], [/\b(fourth|4th|(option|number) (4|four))\b/, 4]];

/**
 * Keeps only what the user actually said. A small model sometimes adds a day, a preference or an
 * option nobody asked for; those are read from the words themselves.
 */
export function ground(action: string, args: Record<string, unknown>, text: string, options: { option: number; depLocal: string; toShort: string }[] = []): Record<string, unknown> {
  const t = text.toLowerCase();
  const a = { ...args };
  if (/\b(together|next to|beside|sit with|seated with)\b/.test(t)) a.together = true;
  else delete a.together;
  const day = t.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)?.[1];
  if (day && action === "rebooking_options") a.day = day;
  else if (!day) delete a.day;
  if (a.time_of_day && !/\b(morning|afternoon|evening|night|tonight)\b/.test(t)) delete a.time_of_day;
  if (a.airport && !/\b(midway|o'?hare|ord|mdw)\b/.test(t)) delete a.airport;
  if (a.flight && !/\d{3,4}/.test(t)) delete a.flight;
  if (a.trip && !/\b[A-Z0-9]{6}\b/.test(text) && !/\d{3,4}|chicago|austin|return|home|back/.test(t)) delete a.trip;
  if (action === "request_refund") a.what = /\bbag/.test(t) ? "bag_fee" : "ticket";
  if (action === "request_assistance") {
    a.kind = /wheel ?chair|can'?t walk|walking|knee|leg|mobility/.test(t) ? "wheelchair" : /\bblind|can'?t see|low vision|vision|sight/.test(t) ? "vision" : /\bdeaf|hard of hearing|can'?t hear|hearing/.test(t) ? "hearing" : "escort";
    a.who = /\b(maya|my daughter|daughter|my kid)\b/.test(t) ? "Maya" : "me";
  }

  if (action === "rebook") {
    delete a.option;
    // A flight number said out loud is the flight wanted, wherever the model put it.
    // "630 am" is a time, not flight 630.
    const num = t.replace(/\b\d{3,4}\s*(a\.?m|p\.?m)\b/g, " ").match(/\b(\d{3,4})\b/)?.[1];
    if (num) {
      a.flight = num;
      if (a.trip === num) delete a.trip;
    }
    // "the 3:45", "the Midway one", "the second one"
    const byTime = num ? undefined : optionAt(text, options);
    const byAirport = /midway/.test(t) ? options.find((o) => o.toShort === "Midway") : /o'?hare/.test(t) ? options.find((o) => o.toShort === "O'Hare") : undefined;
    const ord = ORDINALS.find(([re]) => re.test(t))?.[1];
    const last = /\b(last|latest)\b/.test(t) ? options[options.length - 1]?.option : undefined;
    const earliest = /\b(earliest|soonest|first available)\b/.test(t) ? 1 : undefined;
    const option = byTime?.option ?? byAirport?.option ?? earliest ?? ord ?? last;
    if (option) a.option = option;
  }
  return a;
}

/** Drops empty values a small model adds ("", null, []). */
function clean(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined && v !== 0 && !(Array.isArray(v) && !v.length)));
}
