# A2A Protocol Contract — Operation Echo Shield

This document is the **authoritative wire contract** for every service in this
repository. It is written so that a Python, a TypeScript, and a Go developer can
each implement their service independently and have them interoperate perfectly.

> This demo implements the **HTTP+JSON / REST binding** of the
> [Agent2Agent (A2A) Protocol](https://a2a-protocol.org) concepts: Agent Cards,
> Messages, Parts, Tasks, Task Status, Artifacts, Context IDs, request/response,
> polling, and Server-Sent-Events (SSE) streaming. It is a faithful, educational
> subset — see "Known simplifications" in the README.

Every implementer **MUST** read this whole file plus `storage/schema.sql`
before writing code. Field names, casing, enum values, and endpoint paths below
are **normative** — do not rename them.

---

## 1. Transport & headers

* All inter-agent traffic is HTTP/1.1 with JSON bodies.
* Every **inter-agent request** (Command → any agent, Command → Registry, and
  any agent fetching a card) MUST send these headers:

  | Header | Value | Meaning |
  |---|---|---|
  | `A2A-Version` | `1.0` | Protocol version. |
  | `X-Correlation-ID` | a UUID | Identifies one logical request/response pair. |
  | `X-Trace-ID` | a UUID | Shared across all hops of one mission. |
  | `X-Demo-Token` | `resistance-demo-token` | Demo API key (see security scheme). |
  | `Content-Type` | `application/json` | Bodies are JSON. |
  | `Accept` | `application/json, text/event-stream` | JSON or SSE. |

* Servers MUST also accept `Content-Type: application/a2a+json` as equivalent to
  `application/json`.
* Servers SHOULD echo `X-Correlation-ID` and `X-Trace-ID` back on the response.
* **Auth**: every A2A endpoint (everything except `/health` and
  `/.well-known/agent-card.json`) requires the `X-Demo-Token` header. If it is
  missing, respond `401` with the standard error body (§11). The token **value**
  is not strictly checked (any non-empty value is accepted) so the demo never
  breaks, but its presence is required to demonstrate the auth handshake.

## 2. Content types

* Request/response JSON: `application/json` (also accept `application/a2a+json`).
* Streaming endpoints return `text/event-stream` (SSE).

## 3. Agent Card — `GET /.well-known/agent-card.json`

Returned verbatim (no auth required). Exact shape:

```json
{
  "name": "intelligence-agent",
  "description": "Resistance intelligence scouting agent.",
  "provider": { "organization": "Rebel Alliance", "url": "https://resistance.local" },
  "version": "1.0.0",
  "url": "http://intelligence-agent:8011",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "scout_system",
      "name": "Scout Star System",
      "description": "Scans a star system for Imperial activity.",
      "inputModes": ["text/plain", "application/json"],
      "outputModes": ["application/json"],
      "examples": ["Scout Hoth for Imperial movement"]
    }
  ],
  "securitySchemes": {
    "demoApiKey": { "type": "apiKey", "in": "header", "name": "X-Demo-Token" }
  },
  "security": [ { "demoApiKey": [] } ]
}
```

`url` is the agent's own base URL (its docker-compose service name + port).

## 4. Message & Part

A **Part** is one of:

```json
{ "text": "Scout the Hoth system.", "mediaType": "text/plain" }
```
or
```json
{ "data": { "system": "Hoth" }, "mediaType": "application/json" }
```

A part has **either** `text` **or** `data`. `mediaType` is always present.

A **Message**:

```json
{
  "messageId": "msg-<uuid>",
  "contextId": "operation-echo-shield",
  "role": "ROLE_USER",
  "parts": [ { "text": "...", "mediaType": "text/plain" } ],
  "metadata": {
    "sender": "resistance-command-agent",
    "recipient": "intelligence-agent",
    "correlationId": "corr-<uuid>",
    "traceId": "trace-<uuid>",
    "skillId": "scout_system"
  }
}
```

`role` is `ROLE_USER` (requester) or `ROLE_AGENT` (responder). `metadata` is a
free-form object; the keys above are conventional.

## 5. SendMessageRequest / SendMessageResponse

`POST /message:send` and `POST /message:stream` both accept a
**SendMessageRequest**:

```json
{
  "message": { /* Message, §4 */ },
  "configuration": { "acceptedOutputModes": ["application/json", "text/plain"] }
}
```

`POST /message:send` returns a **SendMessageResponse**:

```json
{ "task": { /* Task, §6 */ } }
```

For `/message:send`, the server performs the work synchronously and returns the
Task already in `TASK_STATE_COMPLETED` with its `artifacts` and full `history`
populated.

`POST /message:stream` returns SSE (§9). After streaming, the authoritative
final Task can always be retrieved with `GET /tasks/{id}`.

## 6. Task, TaskStatus, TaskState

```json
{
  "id": "task-<uuid>",
  "contextId": "operation-echo-shield",
  "status": {
    "state": "TASK_STATE_COMPLETED",
    "timestamp": "2026-06-23T10:15:00.000Z",
    "metadata": { "phase": "completed", "display": "Scan complete." }
  },
  "history": [ { /* Message */ } ],
  "artifacts": [ { /* Artifact, §7 */ } ]
}
```

`TaskState` enum (string values, normative):

```
TASK_STATE_SUBMITTED
TASK_STATE_WORKING
TASK_STATE_INPUT_REQUIRED
TASK_STATE_AUTH_REQUIRED
TASK_STATE_COMPLETED
TASK_STATE_FAILED
TASK_STATE_CANCELED
TASK_STATE_REJECTED
```

`status.metadata.phase` carries a **domain-specific progress label** (e.g.
`scanning_orbit`, `jump_to_lightspeed`) and `status.metadata.display` carries a
human-friendly Star-Wars-flavored string. `timestamp` is ISO-8601 UTC with
milliseconds and a trailing `Z`.

## 7. Artifact

```json
{
  "artifactId": "art-<uuid>",
  "name": "intelligence-report",
  "description": "Imperial activity scan of the Hoth system.",
  "parts": [ { "data": { /* domain payload */ }, "mediaType": "application/json" } ],
  "metadata": { "producedBy": "intelligence-agent" }
}
```

The domain payload (the interesting JSON) lives in `parts[].data`.

## 8. Endpoints — every agent service MUST expose all of these

| Method & path | Purpose |
|---|---|
| `GET /health` | `{ "status": "ok", "agent": "<name>", "language": "<lang>" }`. No auth. |
| `GET /.well-known/agent-card.json` | Agent Card (§3). No auth. |
| `POST /message:send` | SendMessageRequest → SendMessageResponse (§5). |
| `POST /message:stream` | SendMessageRequest → SSE stream (§9). |
| `GET /tasks/{id}` | Returns the Task (§6) or 404. |
| `GET /tasks` | `{ "tasks": [ ... ] }`. Query params `contextId`, `state`, `pageSize` filter. |
| `POST /tasks/{id}:subscribe` | SSE stream of the task's updates (§9). |
| `POST /tasks/{id}:cancel` | Cancels if active; returns the Task in `TASK_STATE_CANCELED`, else 409. |

Agents keep an **in-memory task store** (a map of taskId → Task). They do **not**
write to the shared SQLite database — only the Command Agent and Registry/
Dashboard (Python) persist. Remote agents are opaque remote services.

## 9. SSE streaming format

`Content-Type: text/event-stream`. Each event is:

```
event: <kind>
data: <single-line-json>

```

(`event:` line then `data:` line then a blank line). `<kind>` ∈
`task | status-update | artifact-update`. The same `kind` is **also** embedded in
the JSON so clients may ignore the `event:` line and just parse `data:`.

Event payloads:

```json
{ "kind": "task", "task": { /* Task in TASK_STATE_SUBMITTED */ } }
```
```json
{ "kind": "status-update", "taskId": "task-..", "contextId": "..",
  "status": { "state": "TASK_STATE_WORKING",
              "timestamp": "..",
              "metadata": { "phase": "scanning_orbit", "display": ".." } },
  "final": false }
```
```json
{ "kind": "artifact-update", "taskId": "task-..", "contextId": "..",
  "artifact": { /* Artifact */ }, "final": false }
```

**Stream ordering** (normative): exactly one `task` event first; then one or
more `status-update` events (`TASK_STATE_WORKING` with progressing `phase`);
then one `artifact-update` per artifact; then a final `status-update` with
`state = TASK_STATE_COMPLETED` and `"final": true`. Producers SHOULD sleep
~250–500 ms between status updates so the dashboard animates.

## 10. `GET /tasks` filtering

Query params (all optional): `contextId`, `state`, `pageSize` (default 50).
Returns `{ "tasks": [ Task, ... ] }`.

## 11. Error response

Any error returns a non-2xx HTTP status and this body:

```json
{ "error": { "code": "TASK_NOT_FOUND", "message": "No task task-x",
             "httpStatus": 404, "correlationId": "corr-.." } }
```

`code` ∈ `{ AUTH_REQUIRED, BAD_REQUEST, TASK_NOT_FOUND, TASK_NOT_CANCELABLE,
SKILL_NOT_FOUND, AGENT_NOT_FOUND, INTERNAL }`.

---

## 12. Per-service specifications

All services share the endpoint set in §8. Each spec below gives the port,
skills, the **exact request** it receives, and the **exact artifact** it returns.
All domain numbers are **deterministic** (no randomness) so the demo is
reproducible.

### 12.1 Resistance Command Agent — Python — port 8001
Agent name `resistance-command-agent`. Skills: `create_mission`,
`discover_agents`, `assign_task`, `coordinate_agents`, `track_status`,
`request_reinforcements`, `complete_mission`. `capabilities.streaming = true`.
It is the **orchestrator** (see §13). It also serves a valid Agent Card and the
full endpoint set (its `/message:send` accepts a `{"command":"start_mission"}`
data part and kicks off the mission, returning a completed task summarizing it).

### 12.2 Intelligence Agent — TypeScript — port 8011
Name `intelligence-agent`. Skills: `scout_system`, `detect_empire_presence`,
`estimate_force_strength`, `produce_intelligence_report`.
`capabilities.streaming = true`. **Streams** on `/message:stream`.

Receives (text + data parts): "Scout the Hoth system for Imperial movement." +
`{ "mission": "operation-echo-shield", "system": "Hoth", "skill": "scout_system" }`.

Stream phases (in order): `submitted` → `scanning_orbit` → `scanning_surface` →
`decoding_transmission` → `completed`. Artifact `name: "intelligence-report"`,
`parts[0].data`:
```json
{
  "system": "Hoth",
  "empire_presence": true,
  "confidence": 0.94,
  "detected_units": {
    "stormtroopers": 1800, "at_at_walkers": 12, "at_st_walkers": 28,
    "star_destroyers": 3, "probe_droids": 9
  },
  "transmission": "Imperial armor columns detected beyond the northern ridge."
}
```

### 12.3 Communications Relay Agent — TypeScript — port 8012
Name `communications-relay-agent`. Skills: `relay_transmission`,
`encode_transmission`, `decode_transmission`, `verify_message_integrity`.
`capabilities.streaming = true` (responds on `/message:send`; may also stream).

Receives a text instruction + a data part containing `{ "tactical": {...},
"logistics": {...}, "skill": "relay_transmission" }`. Wraps the payload as a
secure Resistance transmission. Artifact `name: "secure-transmission"`,
`parts[0].data`:
```json
{
  "encryption_channel": "Fulcrum",
  "signal_strength": 0.97,
  "relay_station": "Echo-Relay-7",
  "checksum": "<deterministic sha256-prefix of the encoded payload>",
  "encoded_payload": "<base64 of the JSON payload>",
  "verified": true,
  "transmission": "Transmission secured over the Fulcrum channel."
}
```
The `checksum` is the first 16 hex chars of the SHA-256 of the canonical
JSON of the incoming data payload; `encoded_payload` is base64 of that same JSON.
These are deterministic and verifiable by the receiver.

### 12.4 Tactical Analysis Agent — Go — port 8021
Name `tactical-agent`. Skills: `calculate_risk`, `generate_strategy`,
`prioritize_targets`, `recommend_action`. `capabilities.streaming = false`
(responds on `/message:send`).

Receives a text instruction + a data part = the intelligence-report payload
(§12.2) under key `intelligence`, plus `"skill": "calculate_risk"`. Performs
**deterministic** risk scoring from the detected units (documented formula in
`tactical.go`) and returns artifact `name: "tactical-assessment"`,
`parts[0].data`:
```json
{
  "threat_level": "HIGH",
  "risk_score": 91,
  "recommended_action": "REINFORCE_AND_EVACUATE_NONESSENTIAL_PERSONNEL",
  "priority_targets": ["star_destroyers", "at_at_walkers", "orbital_probe_network"],
  "rationale": "Detected Imperial strength exceeds local defensive capacity."
}
```
Scoring (deterministic): `risk = min(100, round(star_destroyers*4 +
at_at_walkers*2 + at_st_walkers*1 + probe_droids*1 + stormtroopers/100))`.
With the canonical intelligence numbers (§12.2) this is
`3*4 + 12*2 + 28*1 + 9*1 + 1800/100 = 12+24+28+9+18 = ` **91** → `HIGH`
(≥70 HIGH, ≥40 MODERATE, else LOW). The Go implementation in `tactical.go`
uses exactly this formula.

### 12.5 Logistics Agent — Go — port 8022
Name `logistics-agent`. Skills: `assess_transport_capacity`, `check_fuel`,
`allocate_supplies`, `plan_troop_movement`. `capabilities.streaming = false`.

Receives a text instruction + a data part `{ "system": "Hoth", "tactical":
{...}, "skill": "assess_transport_capacity" }`. Returns artifact
`name: "logistics-assessment"`, `parts[0].data`:
```json
{
  "available_transports": 14,
  "available_x_wings": 22,
  "available_medical_units": 6,
  "fuel_percentage": 82,
  "evacuation_capacity": 4200,
  "recommended_troop_movement": {
    "reinforce_echo_base": 1200,
    "evacuate_civilians": 700,
    "reserve_defensive_units": 300
  }
}
```

### 12.6 Fleet Movement Agent — Go — port 8023
Name `fleet-agent`. Skills: `move_fleet`, `deploy_troops`, `reinforce_planet`,
`confirm_arrival`. `capabilities.streaming = true`. **Streams** on
`/message:stream`.

Receives a text instruction + a data part `{ "destination": "Hoth", "troops":
{ "reinforce_echo_base": 1200, ... }, "skill": "reinforce_planet" }`.
Stream phases (in order): `submitted` → `calculating_hyperspace_route` →
`loading_transports` → `jump_to_lightspeed` → `arriving_hoth_orbit` →
`deployed` → `completed`. Artifact `name: "deployment-order"`, `parts[0].data`:
```json
{
  "deployment_status": "DEPLOYED",
  "destination": "Hoth",
  "eta_minutes": 18,
  "units_deployed": {
    "troop_transports": 8, "x_wing_squadrons": 3,
    "medical_units": 4, "ground_troops": 1200
  },
  "transmission": "Rogue transports are inbound. Reinforcements en route to Echo Base."
}
```

### 12.7 Agent Registry Service — Python — port 8000
Name `agent-registry`. **Not** a normal A2A agent (no `/message:*`), it is a
discovery registry. On startup it reads `AGENT_ENDPOINTS` and fetches every
agent's `/.well-known/agent-card.json` (with retry/backoff), storing cards in
the shared SQLite DB (`agents`, `agent_cards`). Endpoints:

| Method & path | Purpose |
|---|---|
| `GET /health` | `{ "status": "ok" }`. |
| `GET /agents` | `{ "agents": [ { "name", "language", "base_url", "health_status", "card" } ] }`. |
| `GET /agents/{name}` | One agent (name + card) or 404. |
| `GET /agents/search?skill=<id>` | `{ "agents": [ ...cards whose skills contain id ] }`. |
| `POST /agents/refresh` | Re-fetch all cards; returns updated list. |

`AGENT_ENDPOINTS` format: comma-separated `name|language|baseUrl` triples, e.g.
`intelligence-agent|typescript|http://intelligence-agent:8011,...`.

### 12.8 Dashboard API — Python (FastAPI) — port 8080
Name `dashboard-api`. Serves the browser dashboard (HTML/CSS/JS) and read-only
APIs over the shared SQLite DB, plus a live SSE feed. Endpoints:

| Method & path | Purpose |
|---|---|
| `GET /` | The dashboard HTML page. |
| `GET /static/...` | `dashboard.js`, `styles.css`. |
| `GET /health` | `{ "status": "ok" }`. |
| `GET /api/mission` | Latest mission row (name, objective, phase, status, times, summary). |
| `GET /api/agents` | Agent directory (proxied from registry, falls back to `agents` table). |
| `GET /api/timeline` | `transmissions` ordered by id (the live event stream). |
| `GET /api/messages/{message_id}` | Raw `request_json`, `response_json`, `headers_json` for the inspector. |
| `GET /api/tasks` / `GET /api/tasks/{id}` | Persisted tasks. |
| `GET /api/status-updates?contextId=` | `task_status_updates` (fleet/intel progress). |
| `GET /api/artifacts` | Persisted artifacts. |
| `GET /api/troop-movement` | Parsed latest `deployment-order` artifact. |
| `GET /api/audit` | `audit_logs`. |
| `GET /api/replay` | All timeline events ordered, for client-side replay (does NOT re-run the mission). |
| `GET /api/events/stream` | SSE; polls the DB every ~500 ms and pushes new timeline rows + status updates + mission state. |
| `POST /api/run-mission` | Proxies to `POST http://command-agent:8001/mission:start` to (re)run the mission. |

---

## 13. Mission orchestration (Command Agent) — "Operation Echo Shield"

The Command Agent runs this once automatically on startup (after the Registry is
healthy), and again whenever `POST /mission:start` is called. Use a single
**`contextId = "operation-echo-shield"`** and a single mission-wide
**`traceId`** for the whole run; a fresh **`correlationId`** per A2A request.
Persist everything to SQLite (see §14). Each step writes a `transmissions` row
(for the timeline) and `messages` rows (request_json/response_json/headers_json
for the inspector), plus `tasks`, `task_status_updates`, `artifacts`,
`audit_logs`.

1. **Create mission** row: name `Operation Echo Shield`, objective "The Empire is
   massing forces near Hoth. Assess the threat, determine troop movement, and
   deploy reinforcements to Echo Base.", status `running`, started_at now.
   `POST http://command-agent` is self; just create the row.
2. **Discover** `scout_system`: `GET registry/agents/search?skill=scout_system`
   → `intelligence-agent` card. (Retry the registry until found; the registry may
   still be warming up. Also call `POST registry/agents/refresh` once first.)
3. **Fetch** the Intelligence Agent Card directly:
   `GET <card.url>/.well-known/agent-card.json`.
4. **Scout**: `POST <intel>/message:stream` with the §12.2 request. Consume the
   SSE stream, persisting each `status-update` (→ `task_status_updates`) and each
   `artifact-update` (→ `artifacts`). After the stream ends, `GET <intel>/tasks/{id}`
   for the authoritative completed task. Keep the intelligence payload.
5. **Discover** `calculate_risk` → `tactical-agent`.
6. **Analyze**: `POST <tactical>/message:send` with §12.4 request (intelligence
   payload as the `intelligence` data part). Keep the tactical payload.
7. **Discover** `assess_transport_capacity` → `logistics-agent`.
8. **Logistics**: `POST <logistics>/message:send` with §12.5 request (tactical
   payload included). Keep the logistics payload.
9. **Discover** `relay_transmission` → `communications-relay-agent`.
10. **Relay**: `POST <relay>/message:send` with §12.3 request (tactical +
    logistics payloads). Keep the secure-transmission payload.
11. **Discover** `reinforce_planet` → `fleet-agent`.
12. **Deploy**: `POST <fleet>/message:stream` with §12.6 request (troops from
    logistics `recommended_troop_movement`). Consume the SSE stream, persisting
    status updates and the deployment artifact. `GET <fleet>/tasks/{id}` after.
13. **Complete mission**: set mission status `completed`, completed_at now,
    final_summary "Operation Echo Shield completed. Reinforcements deployed to
    Hoth." Write a closing `transmissions` row.

Every hop uses the headers in §1. Use fun display `label`s on transmissions
(e.g. "Find scout_system capability", "Scout Hoth for Imperial movement",
"Imperial armor detected near Echo Base", "Threat level HIGH", "14 transports
available, fuel at 82%", "Transmission secured over Fulcrum channel", "Deploy
reinforcements to Hoth", "Reinforcements deployed"). Use HTTP retries with
exponential backoff (3 attempts) for resilience.

## 14. Persistence (shared SQLite)

DB file: `${A2A_DB_PATH:-/data/mission.db}` (a shared docker volume). The schema
is `storage/schema.sql` (read it). Python services apply it idempotently at
startup (`CREATE TABLE IF NOT EXISTS`), enable `PRAGMA journal_mode=WAL` and
`PRAGMA busy_timeout=5000`. The Command Agent is the writer for mission data; the
Registry writes `agents`/`agent_cards`; the Dashboard only reads. Go and
TypeScript agents never touch the DB.

## 15. Environment variables (set by docker-compose, see `.env.example`)

```
A2A_VERSION=1.0
A2A_DEMO_TOKEN=resistance-demo-token
A2A_DB_PATH=/data/mission.db
REGISTRY_URL=http://agent-registry:8000
COMMAND_AGENT_URL=http://command-agent:8001
INTELLIGENCE_AGENT_URL=http://intelligence-agent:8011
RELAY_AGENT_URL=http://communications-relay-agent:8012
TACTICAL_AGENT_URL=http://tactical-agent:8021
LOGISTICS_AGENT_URL=http://logistics-agent:8022
FLEET_AGENT_URL=http://fleet-agent:8023
AGENT_ENDPOINTS=intelligence-agent|typescript|http://intelligence-agent:8011,communications-relay-agent|typescript|http://communications-relay-agent:8012,tactical-agent|go|http://tactical-agent:8021,logistics-agent|go|http://logistics-agent:8022,fleet-agent|go|http://fleet-agent:8023,resistance-command-agent|python|http://command-agent:8001
PORT=<service port>
AUTOSTART_MISSION=true
MISSION_START_DELAY_SECONDS=6
```

## 16. Observability

Structured JSON logs on every service. Each log line includes: `timestamp`,
`service`, `language`, `level`, `event`, and when available `correlationId`,
`traceId`, `contextId`, `taskId`, `sender`, `recipient`. Print a clear startup
banner listing the agent name, language, port, and skills.

## 17. Bonus / resilience features (normative conventions)

These are demonstrated by the demo; implement them with the exact conventions
below so they interoperate across languages.

### 17.1 Agent Card caching with ETag (all 6 agents + registry)
Every `GET /.well-known/agent-card.json` response carries a strong validator
`ETag` header whose value is `"a2a-<first 16 hex of sha256(canonical card JSON)>"`
(quotes included). If the request sends `If-None-Match` equal to the current
ETag, the agent responds **`304 Not Modified`** with an empty body (and the same
`ETag`). The Registry, when refreshing, stores each card's ETag and sends
`If-None-Match` on subsequent fetches; a `304` means "card unchanged, keep cache".

### 17.2 Protocol version mismatch (Python command + registry)
On every authenticated A2A request, if an `A2A-Version` header is present and its
**major** component differs from `1` (e.g. `9.9`), respond **`400`** with the §11
error body and `code: "VERSION_NOT_SUPPORTED"`. A matching/absent version passes.

### 17.3 Failure simulation + dead-letter queue (command agent, env-gated)
When `FAILURE_SIMULATION=true` (default `false`), the Command Agent, at mission
start and **before** the real §13 sequence:
* fires one **transient** failure on the first attempt of a real hop so the
  existing exponential-backoff retry (`a2a_client`, 3 attempts) visibly recovers
  on attempt 2 — persist the retry attempts to `audit_logs`; and
* fires one **doomed** call (to an unreachable URL) that exhausts all retries and
  is written to the new `dead_letters` table (columns in `storage/schema.sql`) and
  surfaced as a `transmissions` row with `status="dead-letter"`. The mission then
  proceeds normally. With the default `false`, none of this runs.

### 17.4 JSON Schema validation (dashboard)
The Dashboard bakes `jsonschema` + `shared/schemas` + `shared/examples` into its
image and exposes `GET /api/schema-validation` returning
`{ "allValid": true, "results": [ { "name", "schema", "valid", "errors" } ] }`,
validating every `shared/examples/*.json` against the matching schema `$def` and
validating each **live** agent card against `agent-card.schema.json`.
`scripts/validate-schemas.sh` calls it and exits non-zero if `allValid` is false.

### 17.5 Dashboard visual bonuses
* `GET /api/dead-letters` → rows from `dead_letters`; a **Dead-Letter Queue**
  panel (shows "nominal — no dead letters" when empty).
* **Planet Risk Heatmap** panel: colors a Hoth cell by the tactical
  `risk_score`/`threat_level` (green <40, amber 40–69, red ≥70).
* **Fleet Route** visualization: an SVG path Rendezvous → Hyperspace → Hoth
  Orbit → Echo Base, highlighting the current fleet phase from the streamed
  status updates / deployment artifact.
