import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Conversation } from "./alexa.js";
import { getApproval, settle, type Outcome } from "./approvals.js";
import { openSeats } from "./air/air.js";
import { now } from "./air/clock.js";
import { currentScene, SCENES, setScene, TZ, type Scene } from "./air/scenes.js";
import { createServer } from "./mcp.js";
import { loadVoice, synthesize, VOICE_IDS, voiceState } from "./voice.js";

try {
  process.loadEnvFile();
} catch {}

const PORT = Number(process.env.PORT ?? 8790);
const BASE = process.env.BW_BASE_URL ?? `http://localhost:${PORT}`;
const VOICE = process.env.BW_VOICE !== "0";

const app = createMcpExpressApp();
const transports = new Map<string, StreamableHTTPServerTransport>();

// ---------- the MCP server (Streamable HTTP) ----------

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session" }, id: null });
      return;
    }
    const created = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void transports.set(id, created),
    });
    created.onclose = () => {
      if (created.sessionId) transports.delete(created.sessionId);
    };
    await createServer(BASE).connect(created);
    transport = created;
  }
  await transport.handleRequest(req, res, req.body);
});
const bySession = async (req: Request, res: Response) => {
  const transport = transports.get(req.headers["mcp-session-id"] as string);
  if (!transport) return void res.status(400).send("Invalid or missing session ID");
  await transport.handleRequest(req, res);
};
app.get("/mcp", bySession);
app.delete("/mcp", bySession);

// ---------- approvals in the Bluewren app (opened through a URL elicitation; the demo shows it in a phone) ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

app.get("/approve/:id", (req: Request, res: Response) => {
  const a = getApproval(String(req.params.id));
  if (!a) return void res.status(404).send(appPage("Not found", "<p class='muted'>This request has expired.</p>"));
  const body = a.outcome
    ? `<div class="big">${a.outcome === "approved" ? "✓ Approved" : a.outcome === "declined" ? "Declined" : "Expired"}</div><p class="muted">You can go back to Alexa.</p>`
    : `<h1>${esc(a.title)}</h1>
       <div class="card">${a.lines.map((l) => `<div class="row">${esc(l)}</div>`).join("")}</div>
       <p class="muted small">Requested by Alexa on your Echo.</p>
       <form method="post" action="/approve/${a.id}"><input type="hidden" name="outcome" value="approved"><button class="approve">Approve with Face ID</button></form>
       <form method="post" action="/approve/${a.id}"><input type="hidden" name="outcome" value="declined"><button class="decline">Decline</button></form>`;
  res.send(appPage(a.title, body));
});

app.post("/approve/:id", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const outcome = String(req.body?.outcome) as Outcome;
  if (!["approved", "declined"].includes(outcome)) return void res.status(400).end();
  settle(String(req.params.id), outcome);
  res.redirect(303, `/approve/${req.params.id}`);
});

function appPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  :root { --bg: #f4f7fb; --card: #fff; --ink: #0f1b2d; --muted: #5d6779; --brand: #1d5fd1; --brand-ink: #fff; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  main { padding: 18px 16px; display: flex; flex-direction: column; gap: 12px; }
  .bar { font-weight: 700; color: var(--brand); display: flex; align-items: center; gap: 6px; }
  h1 { font-size: 20px; margin: 4px 0 0; }
  .card { background: var(--card); border-radius: 12px; padding: 4px 12px; box-shadow: 0 1px 3px #0001; }
  .row { padding: 9px 0; border-bottom: 1px solid #eef1f6; font-size: 14px; } .row:last-child { border: 0; }
  button { width: 100%; border: 0; border-radius: 12px; padding: 13px; font: inherit; font-weight: 600; cursor: pointer; }
  .approve { background: var(--brand); color: var(--brand-ink); } .decline { background: #e6eaf1; color: var(--ink); }
  .big { font-size: 28px; font-weight: 700; text-align: center; padding: 40px 0 4px; }
  .muted { color: var(--muted); text-align: center; } .small { font-size: 12px; margin: 0; } form { margin: 0; }
</style></head><body><main><div class="bar">🐦 Bluewren</div>${body}</main></body></html>`;
}

// ---------- the Alexa+ simulator for the demo page ----------

const conversations = new Map<string, Conversation>();
const conversation = (sid: string) => {
  let c = conversations.get(sid);
  if (!c) conversations.set(sid, (c = new Conversation(`http://localhost:${PORT}/mcp`)));
  return c;
};
setInterval(() => {
  for (const [sid, c] of conversations) if (Date.now() - c.lastSeen > 60 * 60_000) conversations.delete(sid);
}, 60_000).unref();

const validSid = (sid: unknown): sid is string => typeof sid === "string" && /^[\w-]{8,64}$/.test(sid);

app.get("/alexa/events", (req: Request, res: Response) => {
  const sid = req.query.sid;
  if (!validSid(sid)) return void res.status(400).end();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const c = conversation(sid);
  c.listen(res);
  void c.ready();
});

app.post("/alexa/say", (req: Request, res: Response) => {
  const { sid, text } = req.body ?? {};
  if (!validSid(sid) || typeof text !== "string" || !text.trim()) return void res.status(400).end();
  void conversation(sid).hear(text.slice(0, 500));
  res.status(202).end();
});

// ---------- demo controls: the airline's operations ----------

app.get("/demo/state", (_req, res) => void res.json({ now: now().toISOString(), tz: TZ, scene: currentScene(), scenes: SCENES }));

app.post("/demo/scene/:name", (req: Request, res: Response) => {
  const name = String(req.params.name) as Scene;
  if (!(name in SCENES)) return void res.status(404).end();
  for (const c of conversations.values()) c.forget();
  const happen = setScene(name);
  // A moment later, operations change the flight, and subscribed clients hear about it.
  setTimeout(happen, Number(process.env.BW_SCENE_DELAY_MS ?? 2500));
  res.json({ ok: true, now: now().toISOString() });
});

// Progress from the self-playing demo recording (web/director.ts).
app.post("/demo/log", (req: Request, res: Response) => {
  console.log(`[director] ${new Date().toTimeString().slice(0, 8)} ${String(req.body?.text ?? "").slice(0, 200)}`);
  res.status(204).end();
});

// An operations event for the "watch for a better flight" story: seats together open on an earlier flight.
app.post("/demo/event/seats", (_req, res) => void res.json({ opened: openSeats() ?? null }));

// ---------- the demo page's natural voice ----------

app.get("/voice/status", (_req, res) => void res.json(VOICE ? voiceState : { ready: false, failed: true }));
app.post("/voice", async (req: Request, res: Response) => {
  const { text, voice, speed } = req.body ?? {};
  if (!VOICE || !voiceState.ready) return void res.status(503).end();
  if (typeof text !== "string" || !text.trim() || text.length > 600 || !VOICE_IDS.includes(voice)) return void res.status(400).end();
  let gone = false;
  res.on("close", () => (gone = !res.writableFinished));
  try {
    const wav = await synthesize(text, voice, () => !gone, typeof speed === "number" ? Math.min(1.5, Math.max(0.7, speed)) : 1);
    if (wav) res.type("audio/wav").send(Buffer.from(wav));
    else res.status(204).end();
  } catch (e) {
    console.error("voice failed:", e);
    res.status(500).end();
  }
});

app.use(express.static(fileURLToPath(new URL("../web/public", import.meta.url))));
app.get("/health", (_req, res) => void res.json({ ok: true, sessions: transports.size }));

// Every start begins with the morning scene, before anything has gone wrong (the demo clock lives in memory).
setScene("home");

if (VOICE) void loadVoice().catch(() => {});
app.listen(PORT, () => console.log(`Bluewren MCP server on ${BASE}/mcp, demo on ${BASE}/`));
