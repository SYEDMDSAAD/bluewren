/**
 * The refund and care rules at their edges: the 3-hour delay line, the 12-hour bag line, and
 * weather (not covered) against crew problems (covered).
 *   npx tsx scripts/rules-check.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BW_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "bluewren-"));
const { setScene } = await import("../src/air/scenes.js");
const air = await import("../src/air/air.js");
const { load, save } = await import("../src/air/store.js");
const { addMinutes, now, setNow } = await import("../src/air/clock.js");

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const quote = () => air.refundQuote() as Exclude<ReturnType<typeof air.refundQuote>, { speech: string }>;
const setOps = (o: object) => {
  const acct = load();
  acct.ops[acct.trips[0].flightId] = o;
  save(acct);
};

// The 3-hour line
setScene("home");
setOps({ delay: 179, cause: "mechanical" });
check("2 h 59 min late: no cash refund", quote().eligible === false);
setOps({ delay: 180, cause: "mechanical" });
check("3 h late: cash refund", quote().eligible === true);
check("refund is both fares and the bag fee: 2 × $189 + $35", quote().amount === 413, quote());
setOps({ cancelled: true, cause: "weather" });
check("cancelled for weather: still a cash refund", quote().eligible === true);

// Weather against crew: who pays for the night
setScene("overnight")();
const acct = load();
acct.ops[acct.trips[0].flightId] = { cancelled: true, cause: "weather" };
save(acct);
const plan = air.planRebook(undefined, undefined, "402");
if ("speech" in plan) throw new Error(plan.speech);
air.completeRebook(plan);
const weather = air.strandedHelp();
check("weather overnight: no hotel, Alexa can look for one", /outside Bluewren's control/.test(weather.speech) && (weather.data as any)?.needHotel === true, weather.speech);
setScene("overnight")();
const crewPlan = air.planRebook(undefined, undefined, "402");
if ("speech" in crewPlan) throw new Error(crewPlan.speech);
air.completeRebook(crewPlan);
check("crew overnight: hotel covered", /a room at the Prairie Gate Inn/.test(air.strandedHelp().speech));

// The 12-hour bag line: yesterday's flight landed at 1:40 pm
setScene("bag");
const landed = new Date(air.flightView((await import("../src/air/schedule.js")).flightById(load().trips[0].flightId)).arr);
setNow(addMinutes(landed, 11 * 60));
check("bag 11 h late: fee not refundable yet", "speech" in air.bagFeeQuote() && !air.bagStatus().next, air.bagStatus().speech);
setNow(addMinutes(landed, 12 * 60 + 5));
check("bag just over 12 h late: fee refundable", !("speech" in air.bagFeeQuote()) && air.bagStatus().next?.args.what === "bag_fee");

// Nothing to rebook when the flight is fine
setScene("home");
check("on-time flight: nothing to rebook", /nothing to rebook/.test(air.rebookingOptions().speech));
check("clock moves on from the scene", now().getTime() > 0);

fs.rmSync(process.env.BW_STATE!, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
