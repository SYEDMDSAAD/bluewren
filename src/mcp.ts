import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema, type CallToolResult, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { requestApproval } from "./approvals.js";
import {
  bagFeeQuote,
  bagStatus,
  completeBagFeeRefund,
  completeRebook,
  completeTicketRefund,
  findTrip,
  flightStatus,
  money,
  myTrips,
  planRebook,
  rebookingOptions,
  rebookSummary,
  refundEligibility,
  refundQuote,
  refundStatus,
  strandedHelp,
  tripAlerts,
  tripView,
  type Answer,
  type RebookPlan,
  type RefundQuote,
} from "./air/air.js";
import { airport } from "./air/airports.js";
import { flightById } from "./air/schedule.js";
import { load, onChange } from "./air/store.js";

const INSTRUCTIONS = `Bluewren Air helps the signed-in traveler when a flight goes wrong: status, rebooking, refunds, meal and hotel vouchers, and late bags.
- Every tool returns "speech": say it to the user as it is. It is already short and written for voice.
- If a result has "next" and the user says yes, call that tool with those arguments.
- Subscribe to bluewren://trips. When it changes, call trip_alerts and, if it has news (data.count > 0), say it without being asked.
- Rebooking and ticket refunds are approved by the traveler in the Bluewren app on their phone, through a URL elicitation; refunds are also confirmed by voice first. Never ask for card numbers or passwords.
- "The second one" after rebooking_options is option 2.
- The traveler's own plans (texting family, rides, hotels, calendar) are yours to handle with your other services, using the arrival times and places these tools return.`;

const TRIPS = "bluewren://trips";

function reply(a: Answer): CallToolResult {
  return {
    content: [{ type: "text", text: a.speech }],
    structuredContent: { speech: a.speech, ...(a.needs ? { needs: a.needs } : {}), ...(a.data !== undefined ? { data: a.data as object } : {}), ...(a.next ? { next: a.next } : {}) },
  };
}

/** Actions waiting for a "yes" from clients that can't elicit: the second call must carry the confirmation id. */
const waiting = new Map<string, { kind: string; payload: unknown; expires: number }>();
function hold(kind: string, payload: unknown): string {
  const id = randomUUID().slice(0, 8);
  waiting.set(id, { kind, payload, expires: Date.now() + 5 * 60_000 });
  return id;
}
function take<T>(id: string | undefined, kind: string): T | undefined {
  if (!id) return undefined;
  const w = waiting.get(id);
  waiting.delete(id);
  return w && w.kind === kind && w.expires > Date.now() ? (w.payload as T) : undefined;
}

const trip = z.string().optional().describe("Confirmation code, flight number or destination; empty for the next trip");

export function createServer(baseUrl: string): McpServer {
  const mcp = new McpServer(
    { name: "bluewren-air", title: "Bluewren Air", version: "0.1.0" },
    { capabilities: { tools: {}, resources: { subscribe: true }, logging: {} }, instructions: INSTRUCTIONS },
  );

  const modes = () => {
    const e = mcp.server.getClientCapabilities()?.elicitation as { form?: object; url?: object } | undefined;
    // An empty elicitation capability means form mode (spec 2025-11-25).
    return { form: !!e && (!!e.form || !e.url), url: !!e?.url };
  };

  /** A spoken yes/no; undefined when the client can't ask. */
  async function confirm(message: string, title: string, relatedRequestId: string | number): Promise<ElicitResult | undefined> {
    if (!modes().form) return undefined;
    return mcp.server.elicitInput(
      { mode: "form", message, requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title, description: "true if the user said yes" } }, required: ["confirm"] } },
      { relatedRequestId },
    );
  }

  /** Approval in the Bluewren app on the traveler's phone (URL elicitation). */
  async function approveOnPhone(title: string, lines: string[], say: string, relatedRequestId: string | number): Promise<"approved" | "declined" | "expired"> {
    const a = requestApproval(title, lines);
    const url = `${baseUrl}/approve/${a.id}`;
    if (modes().url) {
      const r = await mcp.server.elicitInput({ mode: "url", message: say, elicitationId: a.id, url }, { relatedRequestId });
      if (r.action !== "accept") return "declined";
    } else {
      await mcp.server.sendLoggingMessage({ level: "notice", data: { message: say, url } }).catch(() => {});
    }
    const outcome = await a.done;
    if (modes().url) await mcp.server.createElicitationCompletionNotifier(a.id)().catch(() => {});
    return outcome;
  }

  mcp.registerTool(
    "trip_alerts",
    {
      title: "Trip alerts",
      description: "New updates on the traveler's trips (cancellations, long delays, late bags), written to be said without being asked, with the best next step. Call it when bluewren://trips changes. data.count is 0 when there's nothing new.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () => reply(tripAlerts()),
  );

  mcp.registerTool(
    "my_trips",
    { title: "My trips", description: "The traveler's upcoming Bluewren trips with their status.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(myTrips()),
  );

  mcp.registerTool(
    "flight_status",
    {
      title: "Flight status",
      description: "Is a flight on time, delayed or cancelled; gate and times. Without a trip it uses the next one.",
      inputSchema: { trip },
      annotations: { readOnlyHint: true },
    },
    async ({ trip }) => reply(flightStatus(trip)),
  );

  mcp.registerTool(
    "rebooking_options",
    {
      title: "Rebooking options",
      description: "Numbered flights the traveler can move to for free after a cancellation or a delay of 3 hours or more, with room for everyone on the booking, earliest arrival first. Includes other airports in the same city.",
      inputSchema: {
        trip,
        together: z.boolean().optional().describe("Only flights where the party can sit together"),
        day: z.string().optional().describe("'today', 'tomorrow' or a weekday"),
        time_of_day: z.enum(["morning", "afternoon", "evening", "night"]).optional(),
        airport: z.string().optional().describe("A preferred arrival airport, e.g. Midway"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ trip, ...prefs }) => reply(rebookingOptions(trip, prefs)),
  );

  mcp.registerTool(
    "rebook",
    {
      title: "Rebook",
      description: "Moves the whole booking to another flight, for free after a cancellation or long delay. The traveler approves it in the Bluewren app on their phone. Pick by option number from rebooking_options, or a flight number; with neither, the best option.",
      inputSchema: {
        trip,
        option: z.number().int().optional().describe("Option number from the last rebooking_options"),
        flight: z.string().optional().describe("Flight number, e.g. 418"),
        confirmation_id: z.string().optional().describe("Only for clients without elicitation: the id from the previous call, after the user said yes"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (a, extra) => {
      const held = take<RebookPlan>(a.confirmation_id, "rebook");
      // "416" sent as the trip is a flight number when no trip has it.
      let { trip, flight } = a;
      if (trip && /\d{3,4}/.test(trip) && !findTrip(trip)) {
        flight ??= trip;
        trip = undefined;
      }
      const plan = held ?? planRebook(trip, a.option, flight);
      if ("speech" in plan) return reply(plan);
      const sum = rebookSummary(plan);
      if (!held && !modes().url && !modes().form) return reply({ speech: `${sum.speech} Shall I?`, needs: "confirmation", data: { confirmation_id: hold("rebook", plan) } });
      const outcome = await approveOnPhone(sum.title, sum.lines, `${sum.speech} Approve it in the Bluewren app on your phone.`, extra.requestId);
      if (outcome === "declined") return reply({ speech: "Okay, I've left your booking as it was." });
      if (outcome === "expired") return reply({ speech: "The approval timed out, so your booking is unchanged. Want me to send it again?" });
      const again = planRebook(plan.conf, undefined, String(flightById(plan.flightId).number));
      if ("speech" in again) return reply(again);
      return reply(completeRebook({ ...plan, ...again }));
    },
  );

  mcp.registerTool(
    "refund_eligibility",
    {
      title: "Refund eligibility",
      description: "Whether the traveler is owed a cash refund under the U.S. DOT rule (the airline cancelled the flight or changed it by 3 hours or more), and how much, without refunding anything.",
      inputSchema: { trip },
      annotations: { readOnlyHint: true },
    },
    async ({ trip }) => reply(refundEligibility(trip)),
  );

  mcp.registerTool(
    "request_refund",
    {
      title: "Request a refund",
      description: "Refunds a ticket the traveler chooses not to use after a cancellation or significant delay (cancels the trip; confirmed by voice, then approved in the app), or a checked-bag fee when the bag was more than 12 hours late.",
      inputSchema: {
        what: z.enum(["ticket", "bag_fee"]).optional().describe("Default ticket"),
        trip,
        confirmation_id: z.string().optional().describe("Only for clients without elicitation"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ what = "ticket", trip, confirmation_id }, extra) => {
      if (what === "bag_fee") {
        const held = take<{ conf: string; tag: string; amount: number }>(confirmation_id, "bag");
        const q = held ?? bagFeeQuote(trip);
        if ("speech" in q) return reply(q);
        if (!held) {
          const message = `Refund your ${money(q.amount)} bag fee to your ${load().card}?`;
          const r = await confirm(message, "Refund it", extra.requestId);
          if (!r) return reply({ speech: message, needs: "confirmation", data: { confirmation_id: hold("bag", q) } });
          if (r.action !== "accept" || r.content?.confirm !== true) return reply({ speech: "Okay, I haven't requested it." });
        }
        return reply(completeBagFeeRefund(q));
      }
      const held = take<RefundQuote>(confirmation_id, "refund");
      const q = held ?? refundQuote(trip);
      if ("speech" in q) return reply(q);
      if (!q.eligible) return reply({ speech: q.why, data: q });
      const t = load().trips.find((x) => x.conf === q.conf)!;
      const city = airport(flightById(t.flightId).to).city;
      const message = `This cancels your trip to ${city}${t.travelers.length > 1 ? " for everyone on it" : ""} and refunds ${money(q.amount)} to your ${load().card}. Go ahead?`;
      if (!held) {
        const r = await confirm(message, "Cancel and refund", extra.requestId);
        if (!r) return reply({ speech: message, needs: "confirmation", data: { confirmation_id: hold("refund", q) } });
        if (r.action !== "accept" || r.content?.confirm !== true) return reply({ speech: "Okay, your trip stays booked." });
      }
      const v = tripView(t);
      const outcome = await approveOnPhone("Approve refund", [`Cancel: ${v.flight.flight}, ${v.flight.fromCity} → ${v.flight.toCity}, ${v.flight.scheduledDep} ${v.flight.day}`, `Travelers: ${v.travelers.map((p) => p.name).join(", ")}`, `Refund: ${money(q.amount)} to ${load().card}`], "Approve the refund in the Bluewren app on your phone.", extra.requestId);
      if (outcome !== "approved") return reply({ speech: outcome === "expired" ? "The approval timed out, so your trip is still booked." : "Okay, your trip stays booked." });
      return reply(completeTicketRefund(q));
    },
  );

  mcp.registerTool(
    "refund_status",
    { title: "Refund status", description: "Refunds on their way to the traveler's card.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(refundStatus()),
  );

  mcp.registerTool(
    "stranded_help",
    {
      title: "Meals and hotel",
      description: "What Bluewren covers while the traveler waits: meal vouchers for waits of 3 hours or more, and a hotel and ride for an overnight stay, when the cause was within Bluewren's control. Issues the vouchers to the app.",
      inputSchema: { trip },
      annotations: { readOnlyHint: false },
    },
    async ({ trip }) => reply(strandedHelp(trip)),
  );

  mcp.registerTool(
    "bag_status",
    {
      title: "Bag status",
      description: "Where the traveler's checked bag is, when a late bag will be delivered, and whether its fee is refundable (more than 12 hours late).",
      inputSchema: { trip },
      annotations: { readOnlyHint: true },
    },
    async ({ trip }) => reply(bagStatus(trip)),
  );

  mcp.registerResource("trips", TRIPS, { title: "Trips", description: "The traveler's trips. Subscribe to hear about cancellations and delays.", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(load().trips.map(tripView), null, 2) }],
  }));

  // Resource subscriptions: airline operations change a flight → the client is told → it calls trip_alerts.
  const subscribed = new Set<string>();
  mcp.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribed.add(req.params.uri);
    return {};
  });
  mcp.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });
  const off = onChange(() => {
    if (subscribed.has(TRIPS)) void mcp.server.sendResourceUpdated({ uri: TRIPS }).catch(() => {});
  });
  mcp.server.onclose = () => void off();

  return mcp;
}
