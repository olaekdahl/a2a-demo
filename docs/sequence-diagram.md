# Sequence Diagram — Operation Echo Shield

This document provides a detailed Mermaid sequence diagram of the complete
mission. Every A2A message, SSE stream event, artifact, and database write is
shown in order.

The mission runs automatically on Command Agent startup
(`AUTOSTART_MISSION=true`). All hops share the context ID
`operation-echo-shield` and a single mission-wide `traceId`; each hop uses a
fresh `correlationId`.

---

## Phase 1 — Mission Initialization

The Command Agent creates the mission row in SQLite and primes the registry.

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant Reg as Agent Registry<br/>(py :8000)
    participant DB as SQLite<br/>(mission.db)

    Note over CMD: AUTOSTART_MISSION=true<br/>MISSION_START_DELAY_SECONDS=6
    CMD->>DB: INSERT INTO missions<br/>name="Operation Echo Shield"<br/>status="running"
    CMD->>Reg: POST /agents/refresh
    Reg->>Reg: Re-fetch all Agent Cards
    Reg-->>CMD: 200 OK (updated agent list)
    CMD->>DB: INSERT INTO transmissions<br/>label="Mission started"
    CMD->>DB: INSERT INTO audit_logs
```

---

## Phase 2 — Scout Hoth (Intelligence Agent, streaming)

The Command Agent discovers the Intelligence Agent via the registry, verifies its
card, then opens an SSE stream. Each `status-update` event is recorded in
`task_status_updates`. After the stream closes the authoritative task is fetched.

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant Reg as Agent Registry<br/>(py :8000)
    participant Intel as Intelligence Agent<br/>(ts :8011)
    participant DB as SQLite<br/>(mission.db)

    CMD->>Reg: GET /agents/search?skill=scout_system
    Reg-->>CMD: { "agents": [intelligence-agent card] }

    CMD->>Intel: GET /.well-known/agent-card.json
    Intel-->>CMD: Agent Card (skills: scout_system, …)

    CMD->>Intel: POST /message:stream<br/>message.parts[0]: "Scout the Hoth system…"<br/>message.parts[1]: { system:"Hoth", skill:"scout_system" }<br/>headers: A2A-Version, X-Trace-ID, X-Demo-Token
    CMD->>DB: INSERT INTO messages (outbound, request_json)
    CMD->>DB: INSERT INTO transmissions label="Scout Hoth for Imperial movement"

    Intel-->>CMD: event: task<br/>{ kind:"task", task:{ state:TASK_STATE_SUBMITTED } }
    CMD->>DB: INSERT INTO tasks (state=SUBMITTED)

    Intel-->>CMD: event: status-update<br/>{ phase:"scanning_orbit", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=scanning_orbit)

    Intel-->>CMD: event: status-update<br/>{ phase:"scanning_surface", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=scanning_surface)

    Intel-->>CMD: event: status-update<br/>{ phase:"decoding_transmission", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=decoding_transmission)

    Intel-->>CMD: event: artifact-update<br/>{ artifact:{ name:"intelligence-report",<br/>  parts[0].data:{ system:"Hoth", empire_presence:true,<br/>    confidence:0.94, stormtroopers:1800, at_at_walkers:12,<br/>    at_st_walkers:28, star_destroyers:3, probe_droids:9 } } }
    CMD->>DB: INSERT INTO artifacts (name=intelligence-report)
    CMD->>DB: INSERT INTO transmissions label="Imperial armor detected near Echo Base"

    Intel-->>CMD: event: status-update<br/>{ state:TASK_STATE_COMPLETED, final:true }
    CMD->>DB: UPDATE tasks (state=COMPLETED)

    CMD->>Intel: GET /tasks/{id}
    Intel-->>CMD: Task (TASK_STATE_COMPLETED, full history + artifacts)
    CMD->>DB: INSERT INTO messages (inbound, response_json)
    CMD->>DB: INSERT INTO audit_logs
```

---

## Phase 3 — Tactical Analysis (Tactical Agent, synchronous)

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant Reg as Agent Registry<br/>(py :8000)
    participant Tac as Tactical Agent<br/>(go :8021)
    participant DB as SQLite<br/>(mission.db)

    CMD->>Reg: GET /agents/search?skill=calculate_risk
    Reg-->>CMD: { "agents": [tactical-agent card] }

    CMD->>Tac: POST /message:send<br/>parts[0]: "Analyze the threat level…"<br/>parts[1]: { intelligence:{ …report payload… }, skill:"calculate_risk" }<br/>headers: A2A-Version, X-Trace-ID, X-Demo-Token
    CMD->>DB: INSERT INTO messages (outbound, request_json)
    CMD->>DB: INSERT INTO transmissions label="Threat level HIGH"

    Note over Tac: risk = min(100,<br/>  3*15 + 12*2 + 28*1 + 1800/100 + 9*1)<br/>= min(100, 45+24+28+18+9) = 91 → HIGH

    Tac-->>CMD: SendMessageResponse<br/>task.status.state=TASK_STATE_COMPLETED<br/>artifact.name="tactical-assessment"<br/>artifact.parts[0].data:{ threat_level:"HIGH", risk_score:91,<br/>  recommended_action:"REINFORCE_AND_EVACUATE_NONESSENTIAL_PERSONNEL",<br/>  priority_targets:["star_destroyers","at_at_walkers","orbital_probe_network"] }

    CMD->>DB: INSERT INTO tasks (state=COMPLETED)
    CMD->>DB: INSERT INTO artifacts (name=tactical-assessment)
    CMD->>DB: INSERT INTO messages (inbound, response_json)
    CMD->>DB: INSERT INTO audit_logs
```

---

## Phase 4 — Logistics Assessment (Logistics Agent, synchronous)

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant Reg as Agent Registry<br/>(py :8000)
    participant Log as Logistics Agent<br/>(go :8022)
    participant DB as SQLite<br/>(mission.db)

    CMD->>Reg: GET /agents/search?skill=assess_transport_capacity
    Reg-->>CMD: { "agents": [logistics-agent card] }

    CMD->>Log: POST /message:send<br/>parts[0]: "Assess transport capacity for Hoth…"<br/>parts[1]: { system:"Hoth", tactical:{ …assessment payload… },<br/>             skill:"assess_transport_capacity" }<br/>headers: A2A-Version, X-Trace-ID, X-Demo-Token
    CMD->>DB: INSERT INTO messages (outbound, request_json)
    CMD->>DB: INSERT INTO transmissions label="14 transports available, fuel at 82%"

    Log-->>CMD: SendMessageResponse<br/>task.status.state=TASK_STATE_COMPLETED<br/>artifact.name="logistics-assessment"<br/>artifact.parts[0].data:{ available_transports:14, available_x_wings:22,<br/>  available_medical_units:6, fuel_percentage:82,<br/>  evacuation_capacity:4200,<br/>  recommended_troop_movement:{ reinforce_echo_base:1200,<br/>    evacuate_civilians:700, reserve_defensive_units:300 } }

    CMD->>DB: INSERT INTO tasks (state=COMPLETED)
    CMD->>DB: INSERT INTO artifacts (name=logistics-assessment)
    CMD->>DB: INSERT INTO messages (inbound, response_json)
    CMD->>DB: INSERT INTO audit_logs
```

---

## Phase 5 — Secure Transmission (Communications Relay Agent, synchronous)

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant Reg as Agent Registry<br/>(py :8000)
    participant Relay as Comms Relay Agent<br/>(ts :8012)
    participant DB as SQLite<br/>(mission.db)

    CMD->>Reg: GET /agents/search?skill=relay_transmission
    Reg-->>CMD: { "agents": [communications-relay-agent card] }

    CMD->>Relay: POST /message:send<br/>parts[0]: "Relay combined tactical and logistics assessment…"<br/>parts[1]: { tactical:{ …assessment payload… },<br/>             logistics:{ …logistics payload… },<br/>             skill:"relay_transmission" }<br/>headers: A2A-Version, X-Trace-ID, X-Demo-Token
    CMD->>DB: INSERT INTO messages (outbound, request_json)
    CMD->>DB: INSERT INTO transmissions label="Transmission secured over Fulcrum channel"

    Note over Relay: checksum = SHA-256(canonical JSON)[0:16]<br/>encoded_payload = base64(canonical JSON)

    Relay-->>CMD: SendMessageResponse<br/>task.status.state=TASK_STATE_COMPLETED<br/>artifact.name="secure-transmission"<br/>artifact.parts[0].data:{ encryption_channel:"Fulcrum",<br/>  signal_strength:0.97, relay_station:"Echo-Relay-7",<br/>  checksum:"<16-hex-chars>", encoded_payload:"<base64>",<br/>  verified:true,<br/>  transmission:"Transmission secured over the Fulcrum channel." }

    CMD->>DB: INSERT INTO tasks (state=COMPLETED)
    CMD->>DB: INSERT INTO artifacts (name=secure-transmission)
    CMD->>DB: INSERT INTO messages (inbound, response_json)
    CMD->>DB: INSERT INTO audit_logs
```

---

## Phase 6 — Fleet Deployment (Fleet Agent, streaming)

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant Reg as Agent Registry<br/>(py :8000)
    participant Fleet as Fleet Agent<br/>(go :8023)
    participant DB as SQLite<br/>(mission.db)

    CMD->>Reg: GET /agents/search?skill=reinforce_planet
    Reg-->>CMD: { "agents": [fleet-agent card] }

    CMD->>Fleet: POST /message:stream<br/>parts[0]: "Deploy reinforcements to Hoth…"<br/>parts[1]: { destination:"Hoth",<br/>             troops:{ reinforce_echo_base:1200,<br/>               evacuate_civilians:700, reserve_defensive_units:300 },<br/>             skill:"reinforce_planet" }<br/>headers: A2A-Version, X-Trace-ID, X-Demo-Token
    CMD->>DB: INSERT INTO messages (outbound, request_json)
    CMD->>DB: INSERT INTO transmissions label="Deploy reinforcements to Hoth"

    Fleet-->>CMD: event: task<br/>{ kind:"task", task:{ state:TASK_STATE_SUBMITTED } }
    CMD->>DB: INSERT INTO tasks (state=SUBMITTED)

    Fleet-->>CMD: event: status-update<br/>{ phase:"calculating_hyperspace_route", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=calculating_hyperspace_route)

    Fleet-->>CMD: event: status-update<br/>{ phase:"loading_transports", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=loading_transports)

    Fleet-->>CMD: event: status-update<br/>{ phase:"jump_to_lightspeed", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=jump_to_lightspeed)

    Fleet-->>CMD: event: status-update<br/>{ phase:"arriving_hoth_orbit", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=arriving_hoth_orbit)

    Fleet-->>CMD: event: artifact-update<br/>{ artifact:{ name:"deployment-order",<br/>  parts[0].data:{ deployment_status:"DEPLOYED", destination:"Hoth",<br/>    eta_minutes:18, units_deployed:{ troop_transports:8,<br/>      x_wing_squadrons:3, medical_units:4, ground_troops:1200 },<br/>    transmission:"Rogue transports are inbound…" } } }
    CMD->>DB: INSERT INTO artifacts (name=deployment-order)
    CMD->>DB: INSERT INTO transmissions label="Reinforcements deployed"

    Fleet-->>CMD: event: status-update<br/>{ phase:"deployed", state:WORKING, final:false }
    CMD->>DB: INSERT INTO task_status_updates (phase=deployed)

    Fleet-->>CMD: event: status-update<br/>{ state:TASK_STATE_COMPLETED, final:true }
    CMD->>DB: UPDATE tasks (state=COMPLETED)

    CMD->>Fleet: GET /tasks/{id}
    Fleet-->>CMD: Task (TASK_STATE_COMPLETED, full history + artifacts)
    CMD->>DB: INSERT INTO messages (inbound, response_json)
    CMD->>DB: INSERT INTO audit_logs
```

---

## Phase 7 — Mission Completion

```mermaid
sequenceDiagram
    autonumber
    participant CMD as Command Agent<br/>(py :8001)
    participant DB as SQLite<br/>(mission.db)
    participant Dash as Dashboard API<br/>(py :8080)
    participant Browser

    CMD->>DB: UPDATE missions<br/>status="completed"<br/>completed_at=now()<br/>final_summary="Operation Echo Shield completed. Reinforcements deployed to Hoth."
    CMD->>DB: INSERT INTO transmissions<br/>label="Operation Echo Shield complete"
    CMD->>DB: INSERT INTO audit_logs

    loop Every ~500 ms
        Dash->>DB: SELECT new transmissions rows
        Dash-->>Browser: SSE event (timeline update)
    end

    Browser->>Browser: Render completed mission timeline
```

---

## Artifact Summary

| Step | Agent | Artifact name | Key fields |
|---|---|---|---|
| 2 | Intelligence Agent | `intelligence-report` | `empire_presence`, `confidence`, `detected_units` |
| 3 | Tactical Agent | `tactical-assessment` | `threat_level`, `risk_score`, `recommended_action` |
| 4 | Logistics Agent | `logistics-assessment` | `available_transports`, `fuel_percentage`, `recommended_troop_movement` |
| 5 | Comms Relay Agent | `secure-transmission` | `encryption_channel`, `checksum`, `encoded_payload`, `verified` |
| 6 | Fleet Agent | `deployment-order` | `deployment_status`, `eta_minutes`, `units_deployed` |

Each artifact travels as `parts[0].data` inside an `Artifact` object; the
receiving agent (Command Agent) deserialises `parts[0].data` to feed the next
step.
