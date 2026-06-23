# Demo Walkthrough — Operation Echo Shield

This document describes exactly what a viewer sees when they open the dashboard
at `http://localhost:8080` and watch the mission run. It proceeds panel by panel,
explaining what each UI element shows and which underlying A2A concepts it
demonstrates.

---

## Prerequisites

1. Run `docker compose up --build` from the repository root.
2. Wait until the terminal shows all eight containers healthy (about 30–60 s
   depending on your machine).
3. Open `http://localhost:8080` in a browser.

---

## Panel 1 — Mission Header

**What you see:**  
A banner at the top of the page displaying:

- Mission name: **Operation Echo Shield**
- Objective: *The Empire is massing forces near Hoth. Assess the threat,
  determine troop movement, and deploy reinforcements to Echo Base.*
- Status indicator: transitions from `RUNNING` (yellow) to `COMPLETED` (green)
  as the mission finishes.
- A **Replay** button and a **Run Mission** button.

**What it demonstrates:**  
The `missions` table row written by the Command Agent on startup. The Dashboard
polls `GET /api/mission` and refreshes this section whenever the status or phase
changes. The status change from `running` to `completed` is visible in real time
because the Dashboard's SSE feed pushes a mission-state event when the Command
Agent writes the final `UPDATE missions` row.

---

## Panel 2 — Agent Directory

**What you see:**  
A card grid showing one card per registered agent:

| Card | Language badge | Health indicator |
|---|---|---|
| resistance-command-agent | Python | green |
| intelligence-agent | TypeScript | green |
| communications-relay-agent | TypeScript | green |
| tactical-agent | Go | green |
| logistics-agent | Go | green |
| fleet-agent | Go | green |
| agent-registry | Python | green |

Clicking a card expands it to show the agent's skills, description, and the URL
of its Agent Card.

**What it demonstrates:**  
The Agent Registry's `GET /agents` endpoint (proxied through the Dashboard's
`GET /api/agents`). The data originates from Agent Cards fetched at
`GET /.well-known/agent-card.json` on each service. This is the A2A discovery
model: the registry knows about agents because it fetched their self-describing
cards, not because it has any compiled-in knowledge of them.

---

## Panel 3 — Live Mission Timeline

**What you see:**  
A vertically scrolling event feed. As the mission runs, new entries appear one by
one, each with:

- A timestamp.
- A sender and recipient (e.g. `command-agent → intelligence-agent`).
- A Star-Wars-flavored label (e.g. *Scout Hoth for Imperial movement*, *Imperial
  armor detected near Echo Base*, *Threat level HIGH*, *Reinforcements
  deployed*).
- A message type badge (`discover`, `message:send`, `message:stream`, `status`,
  `artifact`, `mission`).
- A clickable **Inspect** link that opens the raw message viewer (Panel 5).

New entries appear automatically without refreshing because the page is connected
to the Dashboard's `GET /api/events/stream` SSE endpoint. The server pushes a new
event every time a `transmissions` row is inserted.

**Sequence of entries during a fresh mission run:**

1. `command-agent → command-agent` — Mission started
2. `command-agent → agent-registry` — POST /agents/refresh
3. `command-agent → agent-registry` — Find scout_system capability
4. `command-agent → intelligence-agent` — Fetch Agent Card
5. `command-agent → intelligence-agent` — Scout Hoth for Imperial movement
6. `intelligence-agent → command-agent` — (status) scanning_orbit
7. `intelligence-agent → command-agent` — (status) scanning_surface
8. `intelligence-agent → command-agent` — (status) decoding_transmission
9. `intelligence-agent → command-agent` — Imperial armor detected near Echo Base
10. `command-agent → agent-registry` — Find calculate_risk capability
11. `command-agent → tactical-agent` — Threat level HIGH
12. `command-agent → agent-registry` — Find assess_transport_capacity capability
13. `command-agent → logistics-agent` — 14 transports available, fuel at 82%
14. `command-agent → agent-registry` — Find relay_transmission capability
15. `command-agent → communications-relay-agent` — Transmission secured over Fulcrum channel
16. `command-agent → agent-registry` — Find reinforce_planet capability
17. `command-agent → fleet-agent` — Deploy reinforcements to Hoth
18. `fleet-agent → command-agent` — (status) calculating_hyperspace_route
19. `fleet-agent → command-agent` — (status) loading_transports
20. `fleet-agent → command-agent` — (status) jump_to_lightspeed
21. `fleet-agent → command-agent` — (status) arriving_hoth_orbit
22. `fleet-agent → command-agent` — Reinforcements deployed
23. `command-agent → command-agent` — Operation Echo Shield complete

**What it demonstrates:**  
The `transmissions` table is the human-readable audit trail of every A2A hop.
Each row maps to one outbound message, one inbound response, or one streamed
event. The SSE push mechanism (`text/event-stream`) shows how agents can stream
progress updates that a UI can consume without polling.

---

## Panel 4 — Task Progress (Streaming Phases)

**What you see:**  
A sub-section of the timeline (or a dedicated progress panel) that shows the
fine-grained streaming phases for the two SSE agents:

**Intelligence Agent phases:**
- `submitted` → `scanning_orbit` → `scanning_surface` → `decoding_transmission`
  → `completed`

**Fleet Agent phases:**
- `submitted` → `calculating_hyperspace_route` → `loading_transports`
  → `jump_to_lightspeed` → `arriving_hoth_orbit` → `deployed` → `completed`

Each phase update is sourced from the `task_status_updates` table (populated by
the Command Agent as it consumes the SSE stream) and surfaced via
`GET /api/status-updates?contextId=operation-echo-shield`.

**What it demonstrates:**  
The A2A SSE streaming protocol. The `status-update` event carries a `phase` field
in `status.metadata` that is domain-specific progress (not part of the core A2A
TaskState enum). Producers sleep ~250–500 ms between events so the animation is
visible.

---

## Panel 5 — Message Inspector

**What you see:**  
A JSON viewer that opens when you click **Inspect** on any timeline entry. It
shows three tabs:

- **Request** — the full `SendMessageRequest` JSON the Command Agent sent,
  including all A2A headers and message parts.
- **Response** — the full `SendMessageResponse` or final Task JSON received.
- **Headers** — the request headers (demonstrating `A2A-Version`,
  `X-Correlation-ID`, `X-Trace-ID`, `X-Demo-Token`).

The data comes from `GET /api/messages/{message_id}`, which reads the
`messages` table row for that hop.

**What it demonstrates:**  
The wire protocol in full detail. A viewer can see exactly what JSON was sent and
received for every agent-to-agent call, including the `contextId`, `messageId`,
`role`, `parts`, and `metadata` fields defined in the A2A spec. This is the
primary teaching tool for developers learning the protocol.

---

## Panel 6 — Artifacts Panel

**What you see:**  
A row of artifact cards, one per produced artifact:

| Card title | Produced by | Key data shown |
|---|---|---|
| intelligence-report | Intelligence Agent | empire_presence, confidence, detected_units |
| tactical-assessment | Tactical Agent | threat_level, risk_score, recommended_action |
| logistics-assessment | Logistics Agent | available_transports, fuel_percentage |
| secure-transmission | Comms Relay Agent | encryption_channel, checksum, verified |
| deployment-order | Fleet Agent | deployment_status, eta_minutes, units_deployed |

Each card is expandable to show the full `artifact.parts[0].data` JSON.

The data comes from `GET /api/artifacts`.

**What it demonstrates:**  
The A2A Artifact concept. Artifacts are the domain-specific outputs that agents
produce and that orchestrators thread from one agent to the next. The viewer can
see how the `intelligence-report` data feeds `tactical-assessment`, which feeds
`logistics-assessment`, which feeds `secure-transmission`, and which feeds
`deployment-order`.

---

## Panel 7 — Troop Movement Summary

**What you see:**  
A visual summary card showing:

- 8 troop transports deployed
- 3 X-wing squadrons
- 4 medical units
- 1200 ground troops to Echo Base
- 700 civilians evacuated
- 300 reserve defensive units
- ETA: 18 minutes

The data comes from `GET /api/troop-movement`, which parses the latest
`deployment-order` artifact.

**What it demonstrates:**  
How a downstream service (the Dashboard) can consume an artifact produced by a
completely separate agent (Fleet Agent, written in Go) by reading it from the
shared persistence layer — without ever importing the Fleet Agent's code.

---

## Panel 8 — Audit Log

**What you see:**  
A table of audit entries showing:

| Timestamp | Actor | Action | Trace ID | Correlation ID |
|---|---|---|---|---|
| 2026-06-23T… | command-agent | mission_started | trace-… | corr-… |
| … | command-agent | task_created | trace-… | corr-… |
| … | command-agent | artifact_received | trace-… | corr-… |
| … | command-agent | mission_completed | trace-… | corr-… |

The data comes from `GET /api/audit`.

**What it demonstrates:**  
How `X-Trace-ID` and `X-Correlation-ID` headers stitch all hops together into a
single observable audit trail. A viewer can select any row and see how it connects
to the corresponding timeline entry.

---

## Using the Replay Feature

Click **Replay** (or call `GET /api/replay`) after the mission has completed.
The button re-animates the entire timeline from the stored `transmissions` rows,
allowing a presenter to walk through the sequence at their own pace without
re-running any agents. The replay is purely client-side; no new HTTP calls are
made to the agents.

---

## Triggering a New Mission Run

Click **Run Mission** on the dashboard header, or:

```bash
curl -X POST http://localhost:8080/api/run-mission
```

The Dashboard proxies this to `POST http://command-agent:8001/mission:start`.
The Command Agent repeats all 13 orchestration steps and writes a new set of
rows to the database. The timeline will show both the old and new run (ordered
by `transmissions.id`).

To start fresh with a clean database, see the "Reset the Database" section in
the README.
