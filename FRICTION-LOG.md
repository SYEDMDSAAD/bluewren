# Friction log: Bluewren Air on Alexa+

Friction we hit while building a self-hosted MCP server for the Alexa+ track, October 2026.

## 1. Testing an MCP server with Alexa+

- **Task:** Talk to our MCP server through Alexa+ to check how it sounds and behaves.
- **Steps taken:** Read the hackathon resources and the MCP getting-started docs, then looked for an Alexa+ developer console, simulator or device setting that accepts a self-hosted MCP server URL.
- **Expected:** A way to point Alexa+, or an official simulator, at our server's `/mcp` endpoint.
- **Actual:** We couldn't find one, so we couldn't test any turn with real Alexa+.
- **Severity:** High. Voice behaviour is the core of the track, and we had to guess it.
- **Workaround:** We built our own simulated Alexa+, a web MCP client with a small local model, a local voice and a panel showing every MCP message. The track rules allow this.
- **Suggestion:** A hosted Alexa+ test console, or an open-source simulator, that connects to a self-hosted MCP URL. Even text-only would help.

## 2. Proactive alerts (Alexa speaking first)

- **Task:** Have Alexa tell the traveler the moment their flight is cancelled, without being asked.
- **Steps taken:** Implemented MCP resource subscriptions. The client subscribes to `bluewren://trips`, the server sends `notifications/resources/updated`, and the client then calls a `trip_alerts` tool.
- **Expected:** Documentation saying whether Alexa+ subscribes to MCP resources and voices updates proactively, and under what limits (time of day, do-not-disturb, notification indicator).
- **Actual:** We found no such documentation, so we couldn't confirm Alexa+ would behave like our simulator.
- **Severity:** Medium.
- **Workaround:** Our simulated client subscribes and speaks the alert with a chime.
- **Suggestion:** Document Alexa+'s support for resource subscriptions and proactive notifications from MCP servers.

## 3. Approvals outside the conversation (URL and form elicitation)

- **Task:** Let the traveler approve a rebooking or refund in the airline's own app, and confirm a cancellation by voice.
- **Steps taken:** Implemented URL elicitation (spec 2025-11-25) for phone approval, form elicitation for a spoken yes or no, and a `confirmation_id` fallback for clients that can't elicit.
- **Expected:** Guidance on how Alexa+ presents a URL elicitation (phone push, Alexa app card or screen) and a form elicitation by voice.
- **Actual:** We found no Alexa+-specific guidance, so we designed for both and added the fallback.
- **Severity:** Medium.
- **Workaround:** A simulated phone in the demo, plus the `confirmation_id` fallback.
- **Suggestion:** Publish which elicitation modes Alexa+ supports and how each is shown to the user.
