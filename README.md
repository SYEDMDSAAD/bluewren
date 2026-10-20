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

## The four scenes

The demo page has buttons that play the airline's operations:

| Scene | What happens | What Alexa does |
|---|---|---|
| Morning at home | The 11:05 flight is cancelled (crew shortage) | Warns you before you leave; offers the first flight with seats together; rebooks on a phone tap; offers to text Mom |
| At the gate | The 3:45 flight is delayed 3 h 40 min | Says a cash refund is owed; refunds on "yes" and a tap; meal vouchers; tells Mom you're not coming |
| Evening | The last flight is cancelled | Rebooks you onto tomorrow's 6:30 am flight; hotel, meals and ride covered; Uber to the hotel; texts Mom; moves tomorrow's 9 am meeting |
| Next morning | Your bag missed the flight | Says when the bag will be delivered; refunds the $35 bag fee |

## The MCP server

There are 10 tools:

- `trip_alerts`
- `my_trips`
- `flight_status`
- `rebooking_options`
- `rebook`
- `refund_eligibility`
- `request_refund`
- `refund_status`
- `stranded_help`
- `bag_status`

There is also one resource, `bluewren://trips`. Every tool returns `speech`, a reply already written for voice, plus structured data. When a plain "yes" should lead somewhere, the tool also returns `next`, the tool call to make.

**Alexa speaks up first.** The client subscribes to `bluewren://trips`. When operations cancel or delay a flight, the server sends `notifications/resources/updated`. Alexa then calls `trip_alerts` and says the news with the best next step.

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
- **Bluewren's policy:** meal vouchers for waits of 3 hours or more, and a hotel and ride for an overnight stay, when the cause was within the airline's control (crew, mechanical) and not weather. It is modelled on the commitments U.S. airlines publish on the DOT's customer service dashboard.

## Run it

```bash
npm install
npm start      # MCP server at http://localhost:8790/mcp, demo at http://localhost:8790/
npm test       # rule edges + end-to-end over MCP (41 checks)
```

The demo page stands in for Alexa+. It is an MCP client that picks tools with a small local model ([Ollama](https://ollama.com), `qwen2.5-coder:7b` by default, set with `BW_MODEL`). It speaks with a natural voice (Kokoro), listens in Chrome, and shows the airline app on a phone. The panel on the right shows every MCP message.

`npx tsx scripts/intent-check.ts` runs 24 everyday sentences through the local model. The latest run got 24 of 24 right with a median of 2.0 seconds on a laptop GPU. Those sentences were also used to tune the stand-in, so expect less on new phrasings; real Alexa+ does this part itself.

## Layout

- `src/mcp.ts`: the MCP server, its tools, elicitations and the subscribable resource.
- `src/air/`: airports, the demo clock, timetable and seats, the account, the rules (rebooking, DOT refunds, vouchers, bags, alerts) and the scenes.
- `src/approvals.ts`: approvals in the airline app.
- `src/alexa.ts` and `src/home.ts`: the Alexa+ stand-in and its simulated messages, rides, hotels and calendar.
- `scripts/`: tests.

MIT licence.
