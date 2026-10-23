// Plays the demo video by itself: open /?record&speed=1.3&at=<epoch ms> in a full-screen browser
// and record the screen. A narrator explains, "Jordan" speaks their lines (typed into the box as they're
// said), scenes are clicked and the phone's Approve button is tapped, each when Alexa has finished.

type Live = { busy: boolean; speaking: boolean };
type Api = { live: Live; send: (text: string) => void; appFrame: HTMLIFrameElement; input: HTMLInputElement };

const NARRATOR = "am_michael";
const JORDAN = "am_fenrir";

type Step =
  | { card: string; sub?: string }
  | { uncard: true }
  | { vo: string }
  | { you: string }
  | { scene: string }
  | { seats: true }
  | { spot: string | null };

const STEPS: Step[] = [
  { card: "Bluewren Air on Alexa+", sub: "When your flight goes wrong, just talk." },
  { vo: "Last year, about fourteen million people flying from U.S. airports had a flight cancelled. That's when you want to just talk." },
  { uncard: true },
  { vo: "This is Bluewren Air on Alexa plus: a real MCP server, for a made-up airline. It's seven thirty in the morning, and operations just cancelled our flight." },
  { scene: "Morning at home" },
  { you: "Put us on the 3:45, but tell me if an earlier flight with seats together opens." },
  { you: "Yes." },
  { vo: "Hours later, seats open up on an earlier flight." },
  { seats: true },
  { you: "Yes." },
  { spot: "aside.wire" },
  { vo: "Under the hood: one self-hosted MCP server on the November 2025 spec. Twelve tools, a subscribable resource so Alexa can speak first, and form and URL elicitation, so nothing changes without your yes and a tap in the airline's app. The same server explains cash refunds under U.S. transportation rules, sorts out hotels and meal vouchers, tracks late bags, and arranges wheelchairs." },
  { spot: null },
  { card: "Bluewren Air on Alexa+", sub: "When your flight goes wrong, just talk." },
  { vo: "Bluewren Air on Alexa plus. When your flight goes wrong, just talk." },
];

const params = new URLSearchParams(location.search);
const speed = Number(params.get("speed")) || 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (text: string) => void fetch("/demo/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => {});

async function clip(text: string, voice: string): Promise<ArrayBuffer> {
  for (let i = 0; i < 60; i++) {
    const r = await fetch("/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice, speed }) }).catch(() => undefined);
    if (r?.status === 200) return r.arrayBuffer();
    await sleep(2000); // the voice is still loading
  }
  throw new Error(`no voice for: ${text}`);
}

function play(wav: ArrayBuffer): { done: Promise<void>; seconds: Promise<number> } {
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const a = new Audio(url);
  const seconds = new Promise<number>((r) => (a.onloadedmetadata = () => r(a.duration)));
  const done = new Promise<void>((r) => (a.onended = a.onerror = () => (URL.revokeObjectURL(url), r())));
  void a.play();
  return { done, seconds };
}

function overlay(): HTMLDivElement {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(circle at 50% 40%,#16305f,#070d1a 70%);color:#fff;font-family:Inter,system-ui,sans-serif;transition:opacity .8s";
  return d;
}

function showCard(d: HTMLDivElement, title: string, sub?: string) {
  d.innerHTML = "";
  const h = document.createElement("div");
  h.textContent = `🐦 ${title}`;
  h.style.cssText = "font-size:64px;font-weight:700;letter-spacing:-1px";
  d.append(h);
  if (sub) {
    const s = document.createElement("div");
    s.textContent = sub;
    s.style.cssText = "font-size:30px;color:#9fc1ff";
    d.append(s);
  }
  const m = document.createElement("div");
  m.textContent = "A real MCP server · a made-up airline · Alexa+ simulated for the demo";
  m.style.cssText = "font-size:18px;color:#8090b0;margin-top:30px";
  d.append(m);
  d.style.opacity = "1";
  d.style.pointerEvents = "auto";
  document.body.append(d);
}

/** A ring where a click lands, so viewers can see what was pressed. */
async function tap(el: HTMLElement, doc: Document = document) {
  el.scrollIntoView({ block: "nearest" });
  const old = el.style.boxShadow;
  el.style.transition = "box-shadow .2s";
  el.style.boxShadow = "0 0 0 4px #ffcc33, 0 0 22px 6px #ffcc33aa";
  await sleep(500);
  el.click();
  await sleep(300);
  el.style.boxShadow = old;
  void doc;
}

export async function direct({ live, send, appFrame, input }: Api) {
  const card = overlay();
  showCard(card, "Bluewren Air on Alexa+", "Getting ready…");
  log("preparing voices");
  // Make every narrator and Jordan line first, so nothing waits on the voice while recording.
  const clips = new Map<string, ArrayBuffer>();
  for (const s of STEPS) {
    if ("vo" in s) clips.set(s.vo, await clip(s.vo, NARRATOR));
    if ("you" in s && !clips.has(s.you)) clips.set(s.you, await clip(s.you, JORDAN));
  }
  showCard(card, "Bluewren Air on Alexa+", "When your flight goes wrong, just talk.");
  const at = Number(params.get("at")) || 0;
  log(`voices ready; starting ${at ? `at ${new Date(at).toLocaleTimeString()}` : "now"}`);
  while (Date.now() < at) await sleep(50);
  await sleep(800);

  const approved = new Set<string>();
  /** Until Alexa has finished and stayed quiet a moment, tapping Approve on the phone when asked. */
  async function settle(quietMs = 400) {
    await sleep(700);
    let quiet = 0;
    for (let t = 0; t < 1200; t++) {
      const doc = appFrame.hidden ? undefined : appFrame.contentDocument;
      const btn = doc?.querySelector<HTMLButtonElement>("button.approve");
      if (btn && !approved.has(appFrame.src) && !live.speaking) {
        approved.add(appFrame.src);
        await sleep(250);
        await tap(btn, doc!);
        quiet = 0;
        continue;
      }
      quiet = !live.busy && !live.speaking ? quiet + 100 : 0;
      if (quiet >= quietMs) return;
      await sleep(100);
    }
    log("gave up waiting for Alexa");
  }

  for (const s of STEPS) {
    if ("card" in s) showCard(card, s.card, s.sub);
    else if ("uncard" in s) {
      card.style.opacity = "0";
      await sleep(800);
      card.remove();
    } else if ("vo" in s) {
      log(`VO: ${s.vo.slice(0, 50)}`);
      await play(clips.get(s.vo)!).done;
      await sleep(250);
    } else if ("you" in s) {
      log(`you: ${s.you}`);
      const p = play(clips.get(s.you)!);
      const secs = await p.seconds;
      // Typed into the box as it's said, like live speech recognition.
      for (let i = 1; i <= s.you.length; i++) {
        input.value = s.you.slice(0, i);
        await sleep(((secs * 1000) * 0.9) / s.you.length);
      }
      await p.done;
      send(s.you);
      await settle();
    } else if ("scene" in s) {
      const b = [...document.querySelectorAll<HTMLButtonElement>("#sceneButtons button")].find((x) => x.textContent!.toLowerCase().includes(s.scene.toLowerCase()));
      if (!b) throw new Error(`no scene button ${s.scene}`);
      log(`scene: ${b.textContent}`);
      await tap(b);
      // Wait for the alert Alexa speaks first.
      for (let t = 0; t < 300 && !document.querySelector("#chat li.p"); t++) await sleep(100);
      await settle(500);
    } else if ("seats" in s) {
      const b = document.querySelector<HTMLButtonElement>("#sceneButtons button.event, button.event")!;
      log("seats open up");
      const before = document.querySelectorAll("#chat li.p").length;
      await tap(b);
      for (let t = 0; t < 300 && document.querySelectorAll("#chat li.p").length === before; t++) await sleep(100);
      await settle(500);
    } else if ("spot" in s) {
      document.querySelectorAll<HTMLElement>("[data-spot]").forEach((e) => ((e.style.boxShadow = ""), e.removeAttribute("data-spot")));
      const e = s.spot ? document.querySelector<HTMLElement>(s.spot) : null;
      if (e) {
        e.dataset.spot = "1";
        e.style.transition = "box-shadow .4s";
        e.style.boxShadow = "0 0 0 4px #ffcc33, 0 0 30px 8px #ffcc3388";
      }
    }
  }
  await sleep(1200);
  log("recording done");
}
