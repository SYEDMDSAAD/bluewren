# Bluewren Air on Alexa+: when your flight goes wrong, just talk

Bluewren is a self-hosted **MCP server** (spec 2025-11-25, Streamable HTTP) that shows how an airline could ship disruption help on Alexa+. When a flight is cancelled or badly delayed, Alexa tells you first, rebooks you, explains your refund rights, sorts out a hotel for the night and lets your family know, in one conversation with no app to open and no line to stand in.

Bluewren Air is a made-up airline.

> 🔔 **Alexa (7:30 am, in the kitchen):** "Heads up, Jordan. Your 11:05 am flight to Chicago today, Bluewren 412, was cancelled because of a crew shortage. The best option is Bluewren 418 at 3:45 pm today with seats together, landing at O'Hare at 6:20 pm. Moving is free. Want me to move you and Maya to it, or hear the other options?"
> **You:** "Yes." *(Approve the change in the Bluewren app on your phone.)*
> **Alexa:** "Done. You and Maya are on Bluewren 418 at 3:45 pm today, seats 14A and 14B… Mom is picking you up. Want me to text Mom your new arrival time?"

## Why voice, and why now

- **The moment is bad for screens.** At the gate you have a bag on your shoulder and a child by the hand. There are 200 people in line, hold times run to hours, and the airline app is overloaded because everyone opened it at once. Voice needs neither hands nor eyes.
- **It happens a lot.** About 14 million passengers from U.S. airports had a flight cancelled in 2025 (AirHelp), and U.S. airlines cancelled about 1.5% of flights (DOT).
- **People don't know their rights.** Since October 28, 2024, U.S. Department of Transportation rules (14 CFR 260) entitle you to a **cash refund** in two cases:
  - The airline cancels your flight, or changes it by **3 hours or more** on a domestic trip, and you choose not to fly.
  - Your checked bag is more than **12 hours late** on a domestic flight. This refunds the bag fee, once a missing bag report is filed.

  Bluewren says this out loud at the moment it matters, instead of offering a voucher.

## The six scenes

The demo page has buttons that play the airline's operations:

| Scene | What happens | What Alexa does |
|---|---|---|
| Morning at home | The 11:05 flight is cancelled (crew shortage) | Warns you before you leave; offers the first flight with seats together; rebooks on a phone tap; offers to text Mom |
| At the gate | The 3:45 flight is delayed 3 h 40 min | Says a cash refund is owed; refunds on "yes" and a tap; meal vouchers; tells Mom you're not coming |
| At the airport | Your gate moves | Tells you the new gate, how far it is and when boarding starts; a wheelchair or text alerts on request, which follow you if the flight changes |
| Evening | The last flight is cancelled | Rebooks you onto tomorrow's 6:30 am flight; hotel, meals and ride covered; Uber to the hotel; texts Mom; moves tomorrow's 9 am meeting |
| Evening, storm | Weather cancels the flight | Rebooks you for free, but says plainly that weather means no free hotel; finds and books one on Expedia on your yes |
| Next morning | Your bag missed the flight | Says when the bag will be delivered; refunds the $35 bag fee |

A **⚡ Seats open up** button plays one more event. Say "put us on the 3:45, but tell me if an earlier flight with seats together opens". Then press the button, and Alexa tells you about the 1:20 and switches you on a yes.

## The MCP server

There are 12 tools:

- `trip_alerts`
- `my_trips`
- `flight_status`
- `rebooking_options`
- `rebook`
- `watch_for_better`
- `refund_eligibility`
- `request_refund`
- `refund_status`
- `stranded_help`
- `request_assistance`
- `bag_status`

There is also one resource, `bluewren://trips`. Every tool returns `speech`, a reply already written for voice, plus structured data. When a plain "yes" should lead somewhere, the tool also returns `next`, the tool call to make.

**Alexa speaks up first.** The client subscribes to `bluewren://trips`. The server then sends `notifications/resources/updated` in three cases:
- Operations cancel or delay a flight.
- A gate changes.
- A flight the traveler is watching for opens up.

Alexa then calls `trip_alerts` and says the news with the best next step.

**Help for everyone.** `request_assistance` arranges free help under the U.S. Air Carrier Access Act:
- A wheelchair.
- A guide for someone blind or with low vision.
- Text alerts for someone deaf or hard of hearing.
- An escort.

The request moves with the traveler when the flight changes. Voice itself helps here too: it's easier than an app for many older or low-vision travelers.

**Nothing changes without you.**
- Rebooking and ticket refunds are approved in the airline's app on your phone, through **URL elicitation** (a 2025-11-25 spec feature for out-of-band steps).
- A refund cancels the trip, so it is also confirmed by voice first, through **form elicitation**.
- A client that can't elicit gets a read-back and a one-time `confirmation_id`. Nothing happens until a second call carries it.
- No card numbers or passwords are ever spoken.

**Bluewren knows its lane.** It returns arrival times, airports and hotel details. Alexa+ uses them with its own services and partners: texting whoever is picking you up, an Uber to the hotel, moving a meeting, or Expedia when weather means the airline doesn't pay for a hotel.

## What is real and what is simulated

- **Real:**
  - The MCP server, with resource subscriptions and form and URL elicitation.
  - 28 major U.S. airports with their time zones.
  - The DOT rules: 3 hours or more for domestic flights, a refund to a credit card within 7 business days, and a bag fee refund after 12 hours.
- **Simulated:**
  - The airline, its timetable, seats, cancellations, vouchers and refunds. There is no public airline booking API; a real airline would connect its systems behind the same tools.
  - Alexa+ itself: the demo page is a stand-in. Its messages, Uber, Expedia and calendar steps are labelled as simulated in the MCP panel.
- **Bluewren's policy:** free changes again after Bluewren has moved you; meal vouchers for waits of 3 hours or more, and a hotel and ride for an overnight stay, when the cause was within the airline's control (crew, mechanical) and not weather. It is modelled on the commitments U.S. airlines publish on the DOT's customer service dashboard.

## Run it

```bash
npm install
npm start      # MCP server at http://localhost:8790/mcp, demo at http://localhost:8790/
npm test       # rule edges + end-to-end over MCP (54 checks)
```

The demo page stands in for Alexa+. It is an MCP client that picks tools with a small local model ([Ollama](https://ollama.com), `qwen2.5-coder:7b` by default, set with `BW_MODEL`). It speaks with a natural voice (Kokoro), listens in Chrome, and shows the airline app on a phone. The panel on the right shows every MCP message.

`npx tsx scripts/intent-check.ts` runs 31 everyday sentences through the local model. The latest run got 31 of 31 right with a median of 2.1 seconds on a laptop GPU. Those sentences were also used to tune the stand-in, so expect less on new phrasings; real Alexa+ does this part itself.

`npx tsx scripts/stress-check.ts` plays 23 conversations through the demo the way the web page does, about 120 sentences in all, including nonsense, other airlines and cities, requests to ignore the rules, other languages and empty input. It prints every reply for reading and flags crashes, silence and error replies.

## Layout

- `src/mcp.ts`: the MCP server, its tools, elicitations and the subscribable resource.
- `src/air/`: airports, the demo clock, timetable and seats, the account, the rules (rebooking, DOT refunds, vouchers, bags, alerts) and the scenes.
- `src/approvals.ts`: approvals in the airline app.
- `src/alexa.ts` and `src/home.ts`: the Alexa+ stand-in and its simulated messages, rides, hotels and calendar.
- `scripts/`: tests.

MIT licence.
