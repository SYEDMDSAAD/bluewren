/**
 * How well the demo's stand-in for Alexa+ understands people: sentences against the action and
 * arguments they should give, with the local model (Ollama must be running).
 *   npx tsx scripts/intent-check.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8898;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "bluewren-"));
process.env.BW_STATE = state;
const server = spawn("npx", ["tsx", "src/index.ts"], { env: { ...process.env, PORT: String(PORT), BW_VOICE: "0" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve, reject) => {
  server.stdout!.on("data", (d) => String(d).includes("MCP server on") && resolve());
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});
const { Conversation } = await import("../src/alexa.js");

const CASES: [string, string, Record<string, unknown>?][] = [
  ["Is my flight on time?", "flight_status"],
  ["Which gate do we leave from?", "flight_status"],
  ["What trips do I have coming up?", "my_trips"],
  ["What are my other options?", "rebooking_options"],
  ["Get us on a later flight but keep me next to my daughter", "rebooking_options", { together: true }],
  ["Are there any flights tomorrow morning?", "rebooking_options", { day: "tomorrow", time_of_day: "morning" }],
  ["Can we fly into Midway instead?", "rebooking_options", { airport: "Midway" }],
  ["Take the second one", "rebook", { option: 2 }],
  ["Put us on the 3:45", "rebook", { option: 3 }],
  ["Book the Midway one", "rebook", { option: 2 }],
  ["Can I get my money back?", "refund_eligibility"],
  ["Am I owed a refund for this?", "refund_eligibility"],
  ["We don't want to fly anymore, cancel it and refund us", "request_refund", { what: "ticket" }],
  ["I want my bag fee back", "request_refund", { what: "bag_fee" }],
  ["Where is my refund?", "refund_status"],
  ["Where are we going to sleep tonight?", "stranded_help"],
  ["Do we get food vouchers?", "stranded_help"],
  ["Where's my suitcase?", "bag_status"],
  ["Text my mom that we'll be late", "send_text", { contact: "mom" }],
  ["Get me an Uber to the hotel", "book_ride"],
  ["Move my 9 am meeting", "move_meeting"],
  ["Thanks Alexa", "chat"],
];

const c = new Conversation(`http://localhost:${PORT}/mcp`);
await c.connect();
// As if Alexa had just read out these options.
(c as unknown as { options: object[] }).options = [
  { option: 1, depLocal: "1:20 pm", toShort: "O'Hare", flight: "Bluewren 416" },
  { option: 2, depLocal: "2:05 pm", toShort: "Midway", flight: "Bluewren 1512" },
  { option: 3, depLocal: "3:45 pm", toShort: "O'Hare", flight: "Bluewren 418" },
];

let right = 0;
const times: number[] = [];
try {
  for (const [text, action, want = {}] of CASES) {
    const t0 = Date.now();
    const got = await c.choose(text);
    const ms = Date.now() - t0;
    times.push(ms);
    const name = !got ? "nothing" : "say" in got ? "chat" : got.name;
    const args = got && "args" in got ? got.args : {};
    const wrong = [name !== action ? "action" : "", ...Object.entries(want).filter(([k, v]) => String(args[k] ?? "").toLowerCase() !== String(v).toLowerCase()).map(([k]) => k)].filter(Boolean);
    if (!wrong.length) right++;
    console.log(`${wrong.length ? "✗" : "✓"} ${(ms / 1000).toFixed(1)}s ${text}\n    → ${name} ${JSON.stringify(args)}${wrong.length ? `  (wrong: ${wrong.join(", ")})` : ""}`);
  }
} finally {
  server.kill();
  fs.rmSync(state, { recursive: true, force: true });
}
times.sort((a, b) => a - b);
console.log(`\n${right}/${CASES.length} right; median ${(times[times.length >> 1] / 1000).toFixed(1)}s, slowest ${(times[times.length - 1] / 1000).toFixed(1)}s`);
process.exit(0);
