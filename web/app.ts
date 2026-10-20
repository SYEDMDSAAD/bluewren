// The demo page: an Alexa+ screen, the traveler's phone and the MCP messages between Alexa and Bluewren.
// The Alexa side runs on the server (src/alexa.ts); this page sends what you say and shows what happens.
import { setupVoice, speak, stopSpeaking } from "./voice.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $<HTMLOListElement>("chat");
const welcome = $<HTMLDivElement>("welcome");
const input = $<HTMLInputElement>("say");
const mic = $<HTMLButtonElement>("mic");
const wire = $<HTMLOListElement>("wire");
const appFrame = $<HTMLIFrameElement>("appFrame");
const lock = $<HTMLDivElement>("lock");
const notes = $<HTMLDivElement>("notes");
const speakToggle = $<HTMLInputElement>("speak");
const converse = $<HTMLInputElement>("converse");
const echo = document.querySelector<HTMLElement>(".echo")!;

const sid = (() => {
  try {
    const s = sessionStorage.getItem("bw.sid") ?? crypto.randomUUID();
    sessionStorage.setItem("bw.sid", s);
    return s;
  } catch {
    return crypto.randomUUID();
  }
})();

const EXAMPLES = ["Is my flight on time?", "What are my trips?", "Can I get my money back?", "Where's my bag?"];
for (const e of EXAMPLES) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = e;
  b.onclick = () => send(e);
  $("chips").append(b);
}

// ---------- conversation ----------

let thinking: HTMLLIElement | undefined;
let lastQuestion = false;
let spokeLast = false;

function add(cls: string, node: Node | string): HTMLLIElement {
  welcome.hidden = true;
  const li = document.createElement("li");
  li.className = cls;
  li.append(node);
  chat.append(li);
  li.scrollIntoView({ block: "end", behavior: "smooth" });
  return li;
}

function clearThinking() {
  thinking?.remove();
  thinking = undefined;
}

function send(text: string, spoken = false) {
  text = text.trim();
  if (!text) return;
  spokeLast = spoken;
  stopSpeaking();
  input.value = "";
  void fetch("/alexa/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, text }) });
}

$<HTMLFormElement>("ask").onsubmit = (e) => {
  e.preventDefault();
  send(input.value);
};

type Event =
  | { type: "user"; text: string }
  | { type: "thinking"; text: string }
  | { type: "say"; text: string; card?: any; tool?: string; question?: boolean; proactive?: boolean }
  | { type: "phone"; url: string; text: string }
  | { type: "note"; app: string; text: string }
  | { type: "mcp"; dir: "out" | "in" | "alexa"; text: string }
  | { type: "idle" };

const events = new EventSource(`/alexa/events?sid=${encodeURIComponent(sid)}`);
events.onmessage = (m) => {
  const e = JSON.parse(m.data) as Event;
  switch (e.type) {
    case "user":
      clearThinking();
      add("u", e.text);
      break;
    case "thinking":
      clearThinking();
      thinking = add("t", e.text);
      break;
    case "say": {
      clearThinking();
      const box = document.createElement("div");
      const said = document.createElement("div");
      said.className = "said";
      said.textContent = e.text;
      box.append(said);
      const card = e.tool ? cardFor(e.tool, e.card) : undefined;
      if (card) box.append(card);
      add(`a${e.question ? " q" : ""}${e.proactive ? " p" : ""}`, box);
      lastQuestion = !!e.question;
      if (e.proactive) {
        chime();
        echo.classList.add("glow");
        setTimeout(() => echo.classList.remove("glow"), 4000);
        // An alert is a question too: listen for the answer once it's been said.
        spokeLast = true;
      }
      speak(e.text);
      afterAction(e.tool, e.card);
      break;
    }
    case "phone":
      openApp(e.url);
      break;
    case "note":
      notify(e.app, e.text);
      break;
    case "mcp": {
      const li = document.createElement("li");
      li.className = e.dir;
      li.textContent = e.text;
      wire.append(li);
      li.scrollIntoView({ block: "end" });
      break;
    }
    case "idle":
      clearThinking();
      // After a spoken question, listen for the answer once Alexa has finished speaking.
      if (lastQuestion && spokeLast && converse.checked) listenAfterSpeech = true;
      break;
  }
};

/** Two soft notes, like a notification on an Echo. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.start(t);
      o.stop(t + 0.55);
    });
  } catch {}
}

// ---------- cards ----------

const el = (tag: string, cls = "", text = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

function badge(status: string): HTMLElement {
  return el("span", `badge ${status === "On time" ? "ok" : status === "Cancelled" ? "bad" : "warn"}`, status);
}

function flightCard(f: any, extra?: { num?: number; seats?: string; label?: string }): HTMLElement {
  const c = el("div", "card flight");
  const r1 = el("div", "row1");
  const left = el("span");
  if (extra?.num) left.append(el("span", "num", String(extra.num)));
  left.append(document.createTextNode(`${f.flight} · ${f.from} → ${f.to}`));
  r1.append(left, badge(f.status));
  const r2 = el("div", "row2");
  r2.append(el("b", "", `${f.depLocal} ${f.day}`), document.createTextNode(` → ${f.toShort} ${f.arrLocal}${f.status === "Cancelled" ? "" : ` · gate ${f.gate}`}`));
  c.append(r1, r2);
  if (extra?.seats) c.append(el("div", "seats", extra.seats));
  return c;
}

function tripCard(t: any): HTMLElement {
  const c = flightCard(t.flight, { seats: `${t.conf} · ${t.travelers.map((p: any) => `${p.name.split(" ")[0]} ${p.seat}`).join(" · ")}${t.bags ? ` · ${t.bags} bag` : ""}` });
  c.classList.add("ticket");
  return c;
}

function cardFor(tool: string, data: any): HTMLElement | undefined {
  if (!data) return undefined;
  const wrap = el("div", "cards");
  if (Array.isArray(data.options) && data.options.length) {
    for (const o of data.options) wrap.append(flightCard(o, { num: o.option, seats: `Seats ${o.seats.join(", ")}${o.seats.length > 1 ? (o.together ? " · together" : " · apart") : ""} · $0` }));
    return wrap;
  }
  if (tool === "my_trips" && Array.isArray(data) && data.length) {
    for (const t of data) wrap.append(tripCard(t));
    return wrap;
  }
  if (data.flight && data.conf) {
    wrap.append(tripCard(data));
    return wrap;
  }
  if (tool === "stranded_help" && data.vouchers?.length) {
    for (const v of data.vouchers) {
      const c = el("div", "card");
      c.append(el("div", "row1", v.kind === "hotel" ? "🏨 Hotel" : v.kind === "meal" ? "🍽 Meals" : "🚗 Ride"), el("div", "row2", v.text));
      wrap.append(c);
    }
    return wrap;
  }
  if (tool === "request_refund" && data.amount) {
    const c = el("div", "card ticket");
    c.append(el("div", "row1", `Refund $${data.amount}`), el("div", "row2", `${data.to ?? "To your card"}${data.expected ? ` · by ${new Date(data.expected).toLocaleDateString("en-US", { timeZone: state?.tz, month: "long", day: "numeric" })}` : ""}`));
    wrap.append(c);
    return wrap;
  }
  return undefined;
}

// ---------- the phone ----------

function openApp(url: string) {
  lock.hidden = true;
  appFrame.hidden = false;
  appFrame.src = url;
  const phone = document.querySelector(".phone")!;
  phone.classList.remove("ring-me");
  void (phone as HTMLElement).offsetWidth;
  phone.classList.add("ring-me");
}

function closeApp() {
  setTimeout(() => {
    appFrame.hidden = true;
    appFrame.removeAttribute("src");
    lock.hidden = false;
  }, 1500);
}

function notify(title: string, text: string) {
  notes.querySelector(".muted")?.remove();
  const n = el("div", "note");
  n.append(el("b", "", `${title} · now`), document.createTextNode(text));
  notes.prepend(n);
}

function afterAction(tool: string | undefined, data: any) {
  if (!appFrame.hidden && (tool === "rebook" || tool === "request_refund")) closeApp();
  if (tool === "rebook" && data?.flight && data.conf) notify("Bluewren", `Boarding passes ready: ${data.flight.flight}, ${data.flight.depLocal} ${data.flight.day}, seats ${data.travelers.map((p: any) => p.seat).join(", ")}.`);
  if (tool === "request_refund" && data?.amount) notify("Bluewren", `Refund of $${data.amount} requested to ${data.to ?? "your card"}.`);
  if (tool === "stranded_help" && data?.vouchers?.length) notify("Bluewren", `Vouchers added: ${data.vouchers.map((v: any) => v.text).join("; ")}.`);
  if (tool === "trip_alerts" && data?.alert === "cancelled") notify("Bluewren", "Your flight has been cancelled. Open the app or ask Alexa for options.");
  if (tool === "trip_alerts" && data?.alert === "delayed") notify("Bluewren", `${data.flight?.flight ?? "Your flight"} is delayed: now ${data.flight?.depLocal ?? ""}.`);
}

// ---------- the demo clock and scenes ----------

let state: { now: string; tz: string; scene: string; scenes: Record<string, string> } | undefined;
let fetchedAt = Date.now();
const clock = $("clock");
const date = $("date");
function tick() {
  if (!state) return;
  const t = new Date(Date.parse(state.now) + (Date.now() - fetchedAt));
  clock.textContent = t.toLocaleTimeString("en-US", { timeZone: state.tz, hour: "numeric", minute: "2-digit" }).replace(/ (AM|PM)/, "");
  date.textContent = t.toLocaleDateString("en-US", { timeZone: state.tz, weekday: "long", month: "long", day: "numeric" });
}
async function loadState() {
  state = await (await fetch("/demo/state")).json();
  fetchedAt = Date.now();
  tick();
  const box = $("sceneButtons");
  box.replaceChildren();
  for (const [k, label] of Object.entries(state!.scenes)) {
    const b = el("button", k === state!.scene ? "on" : "", label) as HTMLButtonElement;
    b.type = "button";
    b.onclick = () => playScene(k);
    box.append(b);
  }
  $("where").textContent = state!.scene === "bag" ? "Chicago" : state!.scene === "home" ? "At home in Austin" : "Austin airport";
}
async function playScene(name: string) {
  stopSpeaking();
  chat.replaceChildren();
  wire.replaceChildren();
  notes.replaceChildren(el("p", "muted", "Approvals, boarding passes and messages appear here."));
  appFrame.hidden = true;
  lock.hidden = false;
  welcome.hidden = true;
  add("t", `${state?.scenes[name] ?? name}…`);
  await fetch(`/demo/scene/${name}`, { method: "POST" });
  await loadState();
}
void loadState();
setInterval(tick, 5000);

// ---------- voice ----------

let listenAfterSpeech = false;
setupVoice({
  picker: $<HTMLSelectElement>("voice"),
  status: $("voiceStatus"),
  enabled: () => speakToggle.checked,
  onSpeaking: (on) => {
    if (!on && listenAfterSpeech) {
      listenAfterSpeech = false;
      setTimeout(listen, 250);
    }
  },
});

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void };
const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
let rec: Recognition | undefined;
function listen() {
  if (!SR) {
    input.placeholder = "Voice input needs Chrome; type instead";
    return;
  }
  if (rec) return rec.stop();
  stopSpeaking();
  rec = new SR() as Recognition;
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  mic.classList.add("on");
  let final = "";
  rec.onresult = (e) => {
    let text = "";
    for (const r of e.results) {
      text += r[0].transcript;
      if (r.isFinal) final = text;
    }
    input.value = text;
  };
  rec.onerror = () => {};
  rec.onend = () => {
    mic.classList.remove("on");
    rec = undefined;
    if (final.trim()) send(final, true);
  };
  rec.start();
}
mic.onclick = listen;

$("howBtn").onclick = () => $<HTMLDialogElement>("how").showModal();
