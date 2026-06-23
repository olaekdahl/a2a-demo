"""Dashboard API — Operation Echo Shield.

A read-only FastAPI service (port 8080) that:

* serves the browser dashboard (``GET /`` + ``/static``),
* exposes read-only JSON APIs over the shared SQLite mission database,
* streams a live SSE feed of new timeline/status/mission events, and
* proxies a "run mission" request to the Command Agent.

It NEVER writes mission data. The only write it performs is applying
``storage/schema.sql`` idempotently at startup (so it can boot standalone).

Per the contract (§16) every request is logged as structured JSON and a clear
startup banner lists the agent name, language, port and skills.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db, sse

# ---------------------------------------------------------------------------
# Identity / configuration
# ---------------------------------------------------------------------------

SERVICE_NAME = "dashboard-api"
LANGUAGE = "python"
PORT = int(os.environ.get("PORT", "8080"))

REGISTRY_URL = os.environ.get("REGISTRY_URL", "http://agent-registry:8000")
COMMAND_AGENT_URL = os.environ.get("COMMAND_AGENT_URL", "http://command-agent:8001")
DEMO_TOKEN = os.environ.get("A2A_DEMO_TOKEN", "resistance-demo-token")
A2A_VERSION = os.environ.get("A2A_VERSION", "1.0")

SKILLS = [
    "render_dashboard",
    "stream_timeline",
    "inspect_messages",
    "replay_mission",
    "proxy_run_mission",
]

_HERE = os.path.dirname(__file__)
TEMPLATES_DIR = os.path.join(_HERE, "templates")
STATIC_DIR = os.path.normpath(os.path.join(_HERE, "..", "static"))

# The Dockerfile copies the repo's ``shared/`` tree to ``/app/shared`` (schemas +
# examples for §17.4 JSON-Schema validation). When running from source the repo
# path is used as a fallback so the endpoint works locally too.
_SHARED_CANDIDATES = [
    os.environ.get("A2A_SHARED_DIR", ""),
    "/app/shared",
    os.path.normpath(os.path.join(_HERE, "..", "..", "..", "shared")),
]


def _shared_dir() -> Optional[str]:
    for candidate in _SHARED_CANDIDATES:
        if candidate and os.path.isdir(candidate):
            return candidate
    return None

# ---------------------------------------------------------------------------
# Structured JSON logging (§16)
# ---------------------------------------------------------------------------


class _JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)
            )
            + f".{int(record.msecs):03d}Z",
            "service": SERVICE_NAME,
            "language": LANGUAGE,
            "level": record.levelname.lower(),
            "event": record.getMessage(),
        }
        for key in (
            "correlationId",
            "traceId",
            "contextId",
            "taskId",
            "sender",
            "recipient",
            "method",
            "path",
            "status",
            "durationMs",
        ):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        return json.dumps(payload, ensure_ascii=False)


def _build_logger() -> logging.Logger:
    logger = logging.getLogger(SERVICE_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonLogFormatter())
    logger.handlers = [handler]
    return logger


log = _build_logger()


def _log(event: str, level: str = "info", **fields: Any) -> None:
    extra = {k: v for k, v in fields.items() if v is not None}
    getattr(log, level, log.info)(event, extra=extra)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Dashboard API — Operation Echo Shield", version="1.0.0")

templates = Jinja2Templates(directory=TEMPLATES_DIR)

if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Structured JSON log line on every request (§16)."""
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    _log(
        "http_request",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        durationMs=duration_ms,
    )
    return response


@app.on_event("startup")
async def on_startup() -> None:
    await db.apply_schema()
    banner = (
        "\n"
        "============================================================\n"
        f"  {SERVICE_NAME}  ({LANGUAGE})\n"
        "  Operation Echo Shield — Resistance Console\n"
        "------------------------------------------------------------\n"
        f"  port    : {PORT}\n"
        f"  db      : {db.DB_PATH}\n"
        f"  registry: {REGISTRY_URL}\n"
        f"  command : {COMMAND_AGENT_URL}\n"
        f"  skills  : {', '.join(SKILLS)}\n"
        "============================================================\n"
    )
    print(banner, file=sys.stdout, flush=True)
    _log("startup", port=PORT)


# ---------------------------------------------------------------------------
# Page + health
# ---------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "service": SERVICE_NAME,
            "version": "1.0.0",
            "a2a_version": A2A_VERSION,
        },
    )


@app.get("/architecture", response_class=HTMLResponse)
async def architecture_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "architecture.html",
        {
            "request": request,
            "service": SERVICE_NAME,
            "version": "1.0.0",
            "a2a_version": A2A_VERSION,
        },
    )


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Read-only mission APIs (§12.8)
# ---------------------------------------------------------------------------


@app.get("/api/mission")
async def api_mission() -> JSONResponse:
    mission = await db.latest_mission()
    return JSONResponse({"mission": mission})


async def _agents_list() -> list:
    """Agent rows: prefer the registry proxy, fall back to the ``agents`` table."""
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(
                f"{REGISTRY_URL}/agents",
                headers={
                    "X-Demo-Token": DEMO_TOKEN,
                    "A2A-Version": A2A_VERSION,
                    "Accept": "application/json",
                },
            )
            if resp.status_code == 200:
                body = resp.json()
                if isinstance(body, dict) and isinstance(body.get("agents"), list):
                    return body["agents"]
    except Exception as exc:  # noqa: BLE001 — registry may be down; fall back.
        _log("registry_proxy_failed", level="warning", path=str(exc))
    return await db.agents()


@app.get("/api/agents")
async def api_agents() -> JSONResponse:
    """Agent directory: proxy the registry, fall back to the ``agents`` table."""
    return JSONResponse({"agents": await _agents_list()})


@app.get("/api/agents/{name}/card")
async def api_agent_card(name: str) -> JSONResponse:
    """Same-origin Agent Card proxy.

    The card's own ``url`` field is an internal Docker hostname (e.g.
    ``http://intelligence-agent:8011``) that a host browser cannot resolve, so we
    fetch the card over the Docker network here and return it same-origin. This
    works regardless of host-port remapping. Falls back to the registry-embedded
    card if the live well-known fetch fails.
    """
    agents = await _agents_list()
    entry = next((a for a in agents if (a.get("name") == name)), None)
    if entry is None:
        return JSONResponse(
            {"error": {"code": "AGENT_NOT_FOUND", "message": f"No agent {name}",
                       "httpStatus": 404, "correlationId": None}},
            status_code=404,
        )
    base_url = (entry.get("base_url") or (entry.get("card") or {}).get("url") or "").rstrip("/")
    # 1) live fetch from the agent's well-known URL (over the Docker network).
    if base_url:
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.get(
                    f"{base_url}/.well-known/agent-card.json",
                    headers={"X-Demo-Token": DEMO_TOKEN, "A2A-Version": A2A_VERSION,
                             "Accept": "application/json"},
                )
                if resp.status_code == 200:
                    return JSONResponse(resp.json())
        except Exception as exc:  # noqa: BLE001 — fall back to the cached card.
            _log("agent_card_fetch_failed", level="warning", path=f"{name}:{exc}")
    # 2) fall back to the registry-embedded card.
    card = entry.get("card")
    if card:
        return JSONResponse(card)
    return JSONResponse(
        {"error": {"code": "AGENT_NOT_FOUND", "message": f"No card for {name}",
                   "httpStatus": 404, "correlationId": None}},
        status_code=404,
    )


@app.get("/api/timeline")
async def api_timeline() -> JSONResponse:
    return JSONResponse({"transmissions": await db.timeline()})


@app.get("/api/messages/{message_id}")
async def api_message(message_id: str) -> JSONResponse:
    row = await db.message_by_id(message_id)
    if not row:
        return JSONResponse(
            {
                "error": {
                    "code": "TASK_NOT_FOUND",
                    "message": f"No message {message_id}",
                    "httpStatus": 404,
                    "correlationId": None,
                }
            },
            status_code=404,
        )
    parsed = dict(row)
    for key in ("request_json", "response_json", "headers_json"):
        raw = parsed.get(key)
        parsed[key.replace("_json", "")] = _safe_json(raw)
    return JSONResponse({"message": parsed})


@app.get("/api/tasks")
async def api_tasks() -> JSONResponse:
    return JSONResponse({"tasks": await db.tasks()})


@app.get("/api/tasks/{task_id}")
async def api_task(task_id: str) -> JSONResponse:
    row = await db.task_by_id(task_id)
    if not row:
        return JSONResponse(
            {
                "error": {
                    "code": "TASK_NOT_FOUND",
                    "message": f"No task {task_id}",
                    "httpStatus": 404,
                    "correlationId": None,
                }
            },
            status_code=404,
        )
    return JSONResponse({"task": row})


@app.get("/api/status-updates")
async def api_status_updates(contextId: Optional[str] = None) -> JSONResponse:
    rows = await db.status_updates(contextId)
    for row in rows:
        row["raw"] = _safe_json(row.get("raw_json"))
    return JSONResponse({"statusUpdates": rows})


@app.get("/api/artifacts")
async def api_artifacts() -> JSONResponse:
    rows = await db.artifacts()
    for row in rows:
        row["artifact"] = _safe_json(row.get("artifact_json"))
    return JSONResponse({"artifacts": rows})


@app.get("/api/troop-movement")
async def api_troop_movement() -> JSONResponse:
    """Parse the latest ``deployment-order`` artifact (§12.6) for panel 5."""
    artifact_row = await db.latest_deployment_artifact()
    payload = _extract_artifact_payload(artifact_row)
    status_row = await db.latest_status_update()

    current_phase: Optional[str] = None
    fleet_phase: Optional[str] = None
    if status_row:
        current_phase = status_row.get("phase")
        if (status_row.get("agent_name") or "") == "fleet-agent":
            fleet_phase = status_row.get("phase")

    movement = None
    if payload:
        units = payload.get("units_deployed") or {}
        movement = {
            "deployment_status": payload.get("deployment_status"),
            "destination": payload.get("destination"),
            "eta_minutes": payload.get("eta_minutes"),
            "troop_transports": units.get("troop_transports"),
            "x_wing_squadrons": units.get("x_wing_squadrons"),
            "medical_units": units.get("medical_units"),
            "ground_troops": units.get("ground_troops"),
            "transmission": payload.get("transmission"),
        }

    return JSONResponse(
        {
            "troopMovement": movement,
            "raw": payload,
            "currentPhase": current_phase,
            "fleetPhase": fleet_phase,
        }
    )


@app.get("/api/audit")
async def api_audit() -> JSONResponse:
    rows = await db.audit()
    for row in rows:
        row["details"] = _safe_json(row.get("details_json"))
    return JSONResponse({"auditLogs": rows})


@app.get("/api/dead-letters")
async def api_dead_letters() -> JSONResponse:
    """Dead-letter queue (§17.5).

    Rows from the ``dead_letters`` table — messages that exhausted all retries
    (populated only when the Command Agent runs with ``FAILURE_SIMULATION=true``).
    Empty by default; the panel shows a "nominal" state when there are none.
    """
    rows = await db.dead_letters()
    for row in rows:
        row["request"] = _safe_json(row.get("request_json"))
    return JSONResponse({"deadLetters": rows})


@app.get("/api/schema-validation")
async def api_schema_validation() -> JSONResponse:
    """JSON-Schema validation report (§17.4).

    Validates every ``shared/examples/*.json`` against its matching schema
    ``$def`` and validates each LIVE agent card against
    ``agent-card.schema.json``. Returns
    ``{ "allValid": bool, "results": [ { name, schema, valid, errors } ] }``.

    Robust if ``shared/`` is absent: returns a clear error result (never a 500).
    """
    results = await _run_schema_validation()
    all_valid = all(r.get("valid") for r in results) if results else False
    return JSONResponse({"allValid": all_valid, "results": results})


@app.get("/api/replay")
async def api_replay() -> JSONResponse:
    """All stored timeline events, ordered, for client-side replay.

    This does NOT re-run the mission — it returns the already-persisted
    transmissions, status updates and artifacts so the browser can animate a
    deterministic playback.
    """
    transmissions = await db.timeline()
    status = await db.status_updates(None)
    arts = await db.artifacts()
    for row in arts:
        row["artifact"] = _safe_json(row.get("artifact_json"))
    return JSONResponse(
        {
            "transmissions": transmissions,
            "statusUpdates": status,
            "artifacts": arts,
            "mission": await db.latest_mission(),
        }
    )


@app.get("/api/events/stream")
async def api_events_stream() -> StreamingResponse:
    """Live SSE feed (§12.8) — see ``sse.event_stream``."""
    return StreamingResponse(
        sse.event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/run-mission")
async def api_run_mission(request: Request) -> JSONResponse:
    """Proxy a mission (re)run to the Command Agent (§12.8).

    The dashboard never runs mission logic itself; it forwards to
    ``POST COMMAND_AGENT_URL/mission:start``.
    """
    try:
        incoming = await request.body()
    except Exception:  # noqa: BLE001
        incoming = b""

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Demo-Token": DEMO_TOKEN,
        "A2A-Version": A2A_VERSION,
    }
    body = incoming if incoming else b"{}"

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{COMMAND_AGENT_URL}/mission:start",
                content=body,
                headers=headers,
            )
        _log("run_mission_proxied", status=resp.status_code)
        return JSONResponse(
            {"status": "started", "command": _safe_json(resp.text)},
            status_code=resp.status_code if resp.status_code < 500 else 502,
        )
    except Exception as exc:  # noqa: BLE001
        _log("run_mission_failed", level="error", path=str(exc))
        return JSONResponse(
            {
                "error": {
                    "code": "INTERNAL",
                    "message": f"Failed to reach Command Agent: {exc}",
                    "httpStatus": 502,
                    "correlationId": None,
                }
            },
            status_code=502,
        )


@app.post("/api/reset-mission")
async def api_reset_mission() -> JSONResponse:
    """Proxy a mission reset to the Command Agent (POST /mission:reset), which
    clears the persisted mission so the dashboard returns to a nominal state."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Demo-Token": DEMO_TOKEN,
        "A2A-Version": A2A_VERSION,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(f"{COMMAND_AGENT_URL}/mission:reset", headers=headers)
        _log("reset_mission_proxied", status=resp.status_code)
        return JSONResponse(
            {"status": "reset", "command": _safe_json(resp.text)},
            status_code=resp.status_code if resp.status_code < 500 else 502,
        )
    except Exception as exc:  # noqa: BLE001
        _log("reset_mission_failed", level="error", path=str(exc))
        return JSONResponse(
            {"error": {"code": "INTERNAL",
                       "message": f"Failed to reach Command Agent: {exc}",
                       "httpStatus": 502, "correlationId": None}},
            status_code=502,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# JSON Schema validation (§17.4)
# ---------------------------------------------------------------------------

# Which schema $def each example file validates against. ``scout-request.json``
# is a SendMessageRequest (message.schema.json); every ``*-artifact.json`` is an
# Artifact (artifact.schema.json).
_EXAMPLE_SCHEMAS = {
    "scout-request.json": ("message.schema.json", "#/$defs/SendMessageRequest"),
    "intelligence-artifact.json": ("artifact.schema.json", "#/$defs/Artifact"),
    "tactical-artifact.json": ("artifact.schema.json", "#/$defs/Artifact"),
    "logistics-artifact.json": ("artifact.schema.json", "#/$defs/Artifact"),
    "fleet-artifact.json": ("artifact.schema.json", "#/$defs/Artifact"),
}


def _load_schema_registry(schemas_dir: str):
    """Build a ``referencing`` registry of every ``*.schema.json`` in the dir.

    The schemas cross-reference each other by **bare filename** (e.g.
    ``task.schema.json#/$defs/Task``) while declaring an absolute ``$id``. We
    register each resource under BOTH its filename and its ``$id`` so the
    relative ``$ref``s resolve regardless of which form is used.
    """
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    resources: List[tuple] = []
    schemas: Dict[str, dict] = {}
    for path in sorted(glob.glob(os.path.join(schemas_dir, "*.schema.json"))):
        with open(path, "r", encoding="utf-8") as handle:
            schema = json.load(handle)
        filename = os.path.basename(path)
        schemas[filename] = schema
        resource = Resource.from_contents(schema, default_specification=DRAFT202012)
        resources.append((filename, resource))
        schema_id = schema.get("$id")
        if schema_id:
            resources.append((schema_id, resource))
    registry = Registry().with_resources(resources)
    return registry, schemas


def _validate_instance(
    instance: Any, schema_file: str, fragment: str, schemas: Dict[str, dict], registry
) -> List[str]:
    """Validate ``instance`` against ``schema_file`` + ``$ref`` fragment.

    Returns a (possibly empty) list of human-readable error strings.
    """
    from jsonschema import Draft202012Validator

    base = schemas.get(schema_file)
    if base is None:
        return [f"Schema not found: {schema_file}"]
    # A small wrapper schema that $refs into the target $def, resolved through
    # the shared registry (which carries every schema's $defs).
    wrapper = {"$ref": f"{schema_file}{fragment}"}
    validator = Draft202012Validator(wrapper, registry=registry)
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
    out: List[str] = []
    for err in errors:
        location = "/".join(str(p) for p in err.path) or "(root)"
        out.append(f"{location}: {err.message}")
    return out


async def _run_schema_validation() -> List[Dict[str, Any]]:
    """Validate examples + live agent cards; return the per-item result list."""
    shared = _shared_dir()
    if not shared:
        return [
            {
                "name": "shared/",
                "schema": "—",
                "valid": False,
                "errors": [
                    "shared/ directory not found (schemas/examples unavailable). "
                    "Ensure the image was built with 'COPY shared /app/shared'."
                ],
            }
        ]

    schemas_dir = os.path.join(shared, "schemas")
    examples_dir = os.path.join(shared, "examples")
    if not os.path.isdir(schemas_dir):
        return [
            {
                "name": "shared/schemas",
                "schema": "—",
                "valid": False,
                "errors": [f"Schemas directory not found: {schemas_dir}"],
            }
        ]

    try:
        registry, schemas = _load_schema_registry(schemas_dir)
    except Exception as exc:  # noqa: BLE001 — surface a clear error, not a 500.
        _log("schema_registry_failed", level="error", path=str(exc))
        return [
            {
                "name": "schemas",
                "schema": "—",
                "valid": False,
                "errors": [f"Failed to load schemas: {exc}"],
            }
        ]

    results: List[Dict[str, Any]] = []

    # 1) Each bundled example against its matching schema $def.
    for path in sorted(glob.glob(os.path.join(examples_dir, "*.json"))):
        filename = os.path.basename(path)
        mapping = _EXAMPLE_SCHEMAS.get(filename)
        if mapping is None:
            # Unknown example file — report but don't crash.
            results.append(
                {
                    "name": filename,
                    "schema": "(unmapped)",
                    "valid": False,
                    "errors": [f"No schema mapping for example {filename}"],
                }
            )
            continue
        schema_file, fragment = mapping
        try:
            with open(path, "r", encoding="utf-8") as handle:
                instance = json.load(handle)
            errors = _validate_instance(
                instance, schema_file, fragment, schemas, registry
            )
        except Exception as exc:  # noqa: BLE001
            errors = [f"{type(exc).__name__}: {exc}"]
        results.append(
            {
                "name": filename,
                "schema": f"{schema_file}{fragment}",
                "valid": not errors,
                "errors": errors,
            }
        )

    # 2) Each LIVE agent card against agent-card.schema.json.
    agents = await _agents_list()
    for entry in agents:
        name = entry.get("name") or "unknown"
        card = await _fetch_live_card(entry)
        if card is None:
            results.append(
                {
                    "name": f"agent-card: {name}",
                    "schema": "agent-card.schema.json#/$defs/AgentCard",
                    "valid": False,
                    "errors": ["Live agent card unavailable (agent unreachable)."],
                }
            )
            continue
        try:
            errors = _validate_instance(
                card,
                "agent-card.schema.json",
                "#/$defs/AgentCard",
                schemas,
                registry,
            )
        except Exception as exc:  # noqa: BLE001
            errors = [f"{type(exc).__name__}: {exc}"]
        results.append(
            {
                "name": f"agent-card: {name}",
                "schema": "agent-card.schema.json#/$defs/AgentCard",
                "valid": not errors,
                "errors": errors,
            }
        )

    return results


async def _fetch_live_card(entry: dict) -> Optional[dict]:
    """Fetch one agent's live well-known card; fall back to the cached card."""
    base_url = (
        entry.get("base_url") or (entry.get("card") or {}).get("url") or ""
    ).rstrip("/")
    if base_url:
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.get(
                    f"{base_url}/.well-known/agent-card.json",
                    headers={
                        "X-Demo-Token": DEMO_TOKEN,
                        "A2A-Version": A2A_VERSION,
                        "Accept": "application/json",
                    },
                )
                if resp.status_code == 200:
                    return resp.json()
        except Exception as exc:  # noqa: BLE001 — fall back to the cached card.
            _log("schema_card_fetch_failed", level="warning", path=str(exc))
    card = entry.get("card")
    return card if isinstance(card, dict) else None


def _safe_json(raw: Any) -> Any:
    """Parse a JSON string; return the original on failure / ``None`` passthrough."""
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except (ValueError, TypeError):
            return raw
    return raw


def _extract_artifact_payload(artifact_row: Optional[dict]) -> Optional[dict]:
    """Pull ``parts[0].data`` out of a persisted artifact row (§7)."""
    if not artifact_row:
        return None
    parsed = _safe_json(artifact_row.get("artifact_json"))
    if not isinstance(parsed, dict):
        return None

    # The artifact_json may be the full Artifact object or just the payload.
    parts = parsed.get("parts")
    if isinstance(parts, list) and parts:
        first = parts[0]
        if isinstance(first, dict) and isinstance(first.get("data"), dict):
            return first["data"]

    # Already a bare domain payload (has the expected deployment keys).
    if "units_deployed" in parsed or "deployment_status" in parsed:
        return parsed

    # Or wrapped under a "data" key.
    if isinstance(parsed.get("data"), dict):
        return parsed["data"]

    return parsed
