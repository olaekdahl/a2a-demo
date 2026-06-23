"""Resistance Command Agent — the orchestrator (§12.1, §13).

FastAPI app exposing:
  * GET  /health
  * GET  /.well-known/agent-card.json
  * POST /message:send         (a {"command":"start_mission"} data part runs the mission)
  * POST /message:stream       (SSE, §9)
  * GET  /tasks/{id}
  * GET  /tasks
  * POST /tasks/{id}:subscribe (SSE)
  * POST /tasks/{id}:cancel
  * POST /mission:start        (re-runs the mission on demand)

It also auto-runs the mission once on startup when AUTOSTART_MISSION=true.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from .a2a_client import A2AClient
from .logging_util import get_logger
from .mission import MissionStore
from .models import (
    AGENT_LANGUAGE,
    AGENT_NAME,
    CONTEXT_ID,
    ERR_AUTH_REQUIRED,
    ERR_BAD_REQUEST,
    ERR_TASK_NOT_CANCELABLE,
    ERR_TASK_NOT_FOUND,
    ERR_VERSION_NOT_SUPPORTED,
    ROLE_AGENT,
    ROLE_USER,
    TASK_STATE_CANCELED,
    TASK_STATE_COMPLETED,
    TASK_STATE_SUBMITTED,
    TASK_STATE_WORKING,
    error_body,
    first_data_part,
    new_artifact_id,
    new_message_id,
    new_task_id,
    now_iso,
)
from .orchestrator import MISSION_NAME, MISSION_OBJECTIVE, Orchestrator

log = get_logger()

PORT = int(os.environ.get("PORT", "8001"))
AUTOSTART_MISSION = os.environ.get("AUTOSTART_MISSION", "true").lower() == "true"
MISSION_START_DELAY_SECONDS = float(os.environ.get("MISSION_START_DELAY_SECONDS", "6"))
SELF_URL = os.environ.get("COMMAND_AGENT_URL", f"http://command-agent:{PORT}")

JSON_CONTENT_TYPES = {"application/json", "application/a2a+json"}

SKILLS = [
    {
        "id": "create_mission",
        "name": "Create Mission",
        "description": "Creates and tracks a Resistance mission.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Start Operation Echo Shield"],
    },
    {
        "id": "discover_agents",
        "name": "Discover Agents",
        "description": "Discovers capable agents via the registry.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Find an agent that can scout a system"],
    },
    {
        "id": "assign_task",
        "name": "Assign Task",
        "description": "Assigns a skill task to a remote agent.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Assign the scouting task to intelligence"],
    },
    {
        "id": "coordinate_agents",
        "name": "Coordinate Agents",
        "description": "Coordinates a multi-agent operation end to end.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Coordinate the Echo Shield operation"],
    },
    {
        "id": "track_status",
        "name": "Track Status",
        "description": "Tracks task and mission status.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Track the mission status"],
    },
    {
        "id": "request_reinforcements",
        "name": "Request Reinforcements",
        "description": "Requests fleet reinforcements for a planet.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Request reinforcements for Echo Base"],
    },
    {
        "id": "complete_mission",
        "name": "Complete Mission",
        "description": "Finalizes a mission and writes the summary.",
        "inputModes": ["text/plain", "application/json"],
        "outputModes": ["application/json"],
        "examples": ["Complete Operation Echo Shield"],
    },
]

AGENT_CARD: Dict[str, Any] = {
    "name": AGENT_NAME,
    "description": "Resistance command and orchestration agent for Operation Echo Shield.",
    "provider": {"organization": "Rebel Alliance", "url": "https://resistance.local"},
    "version": "1.0.0",
    "url": SELF_URL,
    "capabilities": {"streaming": True, "pushNotifications": False},
    "defaultInputModes": ["text/plain", "application/json"],
    "defaultOutputModes": ["text/plain", "application/json"],
    "skills": SKILLS,
    "securitySchemes": {
        "demoApiKey": {"type": "apiKey", "in": "header", "name": "X-Demo-Token"}
    },
    "security": [{"demoApiKey": []}],
}


def _canonical_json(value: Any) -> str:
    """Deterministic JSON: recursively sorted keys, compact separators. Matches
    the canonical form used by the other agents so the §17.1 ETag interoperates."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# Strong validator ETag `"a2a-<first 16 hex of sha256(canonical card JSON)>"`
# (§17.1). The card contents never change at runtime, so compute it once.
CARD_ETAG = (
    '"a2a-'
    + hashlib.sha256(_canonical_json(AGENT_CARD).encode("utf-8")).hexdigest()[:16]
    + '"'
)


# --------------------------------------------------------------------------- #
# App + shared state
# --------------------------------------------------------------------------- #
app = FastAPI(title="resistance-command-agent")

store = MissionStore()
client = A2AClient()
orchestrator = Orchestrator(store, client)

# In-memory task store (taskId -> Task dict).
TASKS: Dict[str, Dict[str, Any]] = {}

# Guard against concurrent / double mission runs.
_mission_lock = asyncio.Lock()
_autostart_done = False


def _content_type_ok(request: Request) -> bool:
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    # Empty content type is tolerated (some clients omit it on small bodies).
    return ctype == "" or ctype in JSON_CONTENT_TYPES


def _auth_or_error(request: Request) -> Optional[JSONResponse]:
    """Guard for authenticated A2A endpoints.

    Returns a 401 JSONResponse if X-Demo-Token is absent (§1), or a 400 with
    code VERSION_NOT_SUPPORTED if an A2A-Version header is present whose major
    component differs from 1 (§17.2). Returns None when the request may proceed.
    A matching or absent A2A-Version passes unchanged.
    """
    correlation_id = request.headers.get("x-correlation-id")
    if not request.headers.get("x-demo-token"):
        return _error_response(
            ERR_AUTH_REQUIRED, "Missing X-Demo-Token header", 401, correlation_id
        )
    version = request.headers.get("a2a-version")
    if version and version.split(".")[0] != "1":
        return _error_response(
            ERR_VERSION_NOT_SUPPORTED,
            f"Unsupported A2A protocol version '{version}'",
            400,
            correlation_id,
        )
    return None


def _error_response(code: str, message: str, http_status: int, correlation_id: Optional[str]) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content=error_body(code, message, http_status, correlation_id),
    )


def _log_request(request: Request, event: str, **extra: Any) -> None:
    log.info(
        event,
        method=request.method,
        path=request.url.path,
        correlationId=request.headers.get("x-correlation-id"),
        traceId=request.headers.get("x-trace-id"),
        **extra,
    )


def _echo_headers(request: Request, response: Response) -> None:
    cid = request.headers.get("x-correlation-id")
    tid = request.headers.get("x-trace-id")
    if cid:
        response.headers["X-Correlation-ID"] = cid
    if tid:
        response.headers["X-Trace-ID"] = tid


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #
@app.on_event("startup")
async def on_startup() -> None:
    await store.connect()
    _print_banner()
    if AUTOSTART_MISSION:
        asyncio.create_task(_autostart_mission())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await client.aclose()
    await store.close()


def _print_banner() -> None:
    skills = ", ".join(s["id"] for s in SKILLS)
    banner = (
        "\n"
        "==================================================================\n"
        f"  {AGENT_NAME}  (ORCHESTRATOR)\n"
        "------------------------------------------------------------------\n"
        f"  language : {AGENT_LANGUAGE}\n"
        f"  port     : {PORT}\n"
        f"  skills   : {skills}\n"
        f"  autostart: {AUTOSTART_MISSION} (delay {MISSION_START_DELAY_SECONDS}s)\n"
        "==================================================================\n"
    )
    # Banner is human-facing; also emit a structured line.
    print(banner, flush=True)
    log.info(
        "startup.banner",
        agent=AGENT_NAME,
        language=AGENT_LANGUAGE,
        port=PORT,
        skills=[s["id"] for s in SKILLS],
    )


REQUIRED_REMOTE_AGENTS = {
    "intelligence-agent",
    "communications-relay-agent",
    "tactical-agent",
    "logistics-agent",
    "fleet-agent",
}


async def _wait_for_registry(max_attempts: int = 60, delay: float = 2.0) -> bool:
    """Poll REGISTRY_URL/health and /agents until the five remote agents appear."""
    for attempt in range(1, max_attempts + 1):
        healthy = await client.registry_health()
        if healthy:
            try:
                agents = await client.registry_agents()
                names = {a.get("name") for a in agents}
                if REQUIRED_REMOTE_AGENTS.issubset(names):
                    log.info("autostart.registry_ready", attempt=attempt, agents=sorted(names))
                    return True
                log.info(
                    "autostart.waiting_agents",
                    attempt=attempt,
                    have=sorted(n for n in names if n),
                    missing=sorted(REQUIRED_REMOTE_AGENTS - names),
                )
            except Exception as exc:  # noqa: BLE001
                log.warn("autostart.registry_agents_failed", attempt=attempt, error=str(exc))
        else:
            log.info("autostart.registry_unhealthy", attempt=attempt)
        await asyncio.sleep(delay)
    log.warn("autostart.registry_timeout")
    return False


async def _autostart_mission() -> None:
    """Background task: wait, ensure agents discoverable, run the mission once."""
    global _autostart_done
    await asyncio.sleep(MISSION_START_DELAY_SECONDS)
    if not await _wait_for_registry():
        log.warn("autostart.skipped", reason="registry/agents not ready")
        return
    if _mission_lock.locked():
        log.info("autostart.skipped", reason="mission already running")
        return
    async with _mission_lock:
        if _autostart_done:
            return
        _autostart_done = True
        try:
            log.info("autostart.run")
            # Clear any prior run for this contextId so every container start
            # re-runs the mission cleanly (missions.context_id is UNIQUE, so a
            # stale completed mission would otherwise abort create_mission).
            await store.clear_context(CONTEXT_ID)
            await orchestrator.run()
        except Exception as exc:  # noqa: BLE001
            log.error("autostart.failed", error=str(exc))


async def _run_mission_fresh() -> Dict[str, Any]:
    """Clear prior rows for this contextId and run the mission once."""
    global _autostart_done
    async with _mission_lock:
        _autostart_done = True  # an explicit run satisfies the autostart-once guard
        await store.clear_context(CONTEXT_ID)
        return await orchestrator.run()


# --------------------------------------------------------------------------- #
# Health + Agent Card (no auth)
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok", "agent": AGENT_NAME, "language": AGENT_LANGUAGE}


@app.get("/.well-known/agent-card.json")
async def agent_card(request: Request) -> Response:
    # §17.1 — carry a strong ETag validator and honor If-None-Match with 304.
    if request.headers.get("if-none-match") == CARD_ETAG:
        return Response(status_code=304, headers={"ETag": CARD_ETAG})
    return JSONResponse(content=AGENT_CARD, headers={"ETag": CARD_ETAG})


# --------------------------------------------------------------------------- #
# Mission control
# --------------------------------------------------------------------------- #
@app.post("/mission:start")
async def mission_start(request: Request) -> JSONResponse:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    _log_request(request, "mission.start_requested")
    summary = await _run_mission_fresh()
    response = JSONResponse(content=summary)
    _echo_headers(request, response)
    return response


@app.post("/mission:reset")
async def mission_reset(request: Request) -> JSONResponse:
    """Clear all persisted rows for the mission contextId WITHOUT re-running, so
    the dashboard returns to a nominal/standby state."""
    global _autostart_done
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    _log_request(request, "mission.reset_requested")
    async with _mission_lock:
        _autostart_done = True  # a reset also satisfies the autostart-once guard
        await store.clear_context(CONTEXT_ID)
    log.info("mission.reset", contextId=CONTEXT_ID)
    response = JSONResponse(content={"status": "reset", "contextId": CONTEXT_ID})
    _echo_headers(request, response)
    return response


# --------------------------------------------------------------------------- #
# A2A endpoints
# --------------------------------------------------------------------------- #
def _summary_task(
    summary: Dict[str, Any], inbound_message: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Build a completed Task summarizing a mission run, stored in TASKS.

    Populates `history` (§6) with the inbound ROLE_USER message (when present)
    followed by an appended ROLE_AGENT summary message, like the other agents.
    """
    task_id = new_task_id()
    display = summary.get("final_summary", "Operation Echo Shield completed.")
    history: List[Dict[str, Any]] = []
    if inbound_message:
        history.append(inbound_message)
    history.append(
        {
            "messageId": new_message_id(),
            "contextId": CONTEXT_ID,
            "role": ROLE_AGENT,
            "parts": [{"text": display, "mediaType": "text/plain"}],
            "metadata": {"sender": AGENT_NAME},
        }
    )
    task = {
        "id": task_id,
        "contextId": CONTEXT_ID,
        "status": {
            "state": TASK_STATE_COMPLETED,
            "timestamp": now_iso(),
            "metadata": {
                "phase": "completed",
                "display": display,
            },
        },
        "history": history,
        "artifacts": [
            {
                "artifactId": new_artifact_id(),
                "name": "mission-summary",
                "description": "Summary of Operation Echo Shield.",
                "parts": [{"data": summary, "mediaType": "application/json"}],
                "metadata": {"producedBy": AGENT_NAME},
            }
        ],
    }
    TASKS[task_id] = task
    return task


@app.post("/message:send")
async def message_send(request: Request) -> JSONResponse:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    if not _content_type_ok(request):
        return _error_response(
            ERR_BAD_REQUEST, "Unsupported Content-Type", 400,
            request.headers.get("x-correlation-id"),
        )
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _error_response(
            ERR_BAD_REQUEST, "Invalid JSON body", 400,
            request.headers.get("x-correlation-id"),
        )

    _log_request(request, "message.send")
    message = (body or {}).get("message") or {}
    parts = message.get("parts") or []
    data = first_data_part(parts) or {}
    command = data.get("command")

    if command == "start_mission":
        summary = await _run_mission_fresh()
        task = _summary_task(summary, inbound_message=message or None)
        response = JSONResponse(content={"task": task})
        _echo_headers(request, response)
        return response

    # Default: acknowledge with a completed task (no domain work to do here).
    task = _summary_task(
        {
            "final_summary": "Resistance Command Agent acknowledged the request.",
            "contextId": message.get("contextId", CONTEXT_ID),
        },
        inbound_message=message or None,
    )
    response = JSONResponse(content={"task": task})
    _echo_headers(request, response)
    return response


async def _orchestrator_sse(summary_future: "asyncio.Future[Dict[str, Any]]") -> AsyncIterator[str]:
    """Stream the §9 events for a command-agent task while it runs the mission."""
    task_id = new_task_id()
    submitted = {
        "id": task_id,
        "contextId": CONTEXT_ID,
        "status": {
            "state": TASK_STATE_SUBMITTED,
            "timestamp": now_iso(),
            "metadata": {"phase": "submitted", "display": "Operation Echo Shield received."},
        },
        "history": [],
        "artifacts": [],
    }
    TASKS[task_id] = submitted

    # task event
    yield _sse("task", {"kind": "task", "task": submitted})

    phases = [
        ("coordinating_agents", "Coordinating the Resistance fleet."),
        ("orchestrating_mission", "Orchestrating Operation Echo Shield."),
    ]
    for phase, display in phases:
        await asyncio.sleep(0.3)
        evt = {
            "kind": "status-update",
            "taskId": task_id,
            "contextId": CONTEXT_ID,
            "status": {
                "state": TASK_STATE_WORKING,
                "timestamp": now_iso(),
                "metadata": {"phase": phase, "display": display},
            },
            "final": False,
        }
        yield _sse("status-update", evt)

    # Run the actual mission and await its result.
    summary = await summary_future

    artifact = {
        "artifactId": new_artifact_id(),
        "name": "mission-summary",
        "description": "Summary of Operation Echo Shield.",
        "parts": [{"data": summary, "mediaType": "application/json"}],
        "metadata": {"producedBy": AGENT_NAME},
    }
    yield _sse(
        "artifact-update",
        {
            "kind": "artifact-update",
            "taskId": task_id,
            "contextId": CONTEXT_ID,
            "artifact": artifact,
            "final": False,
        },
    )

    final_task = {
        "id": task_id,
        "contextId": CONTEXT_ID,
        "status": {
            "state": TASK_STATE_COMPLETED,
            "timestamp": now_iso(),
            "metadata": {
                "phase": "completed",
                "display": summary.get("final_summary", "Operation Echo Shield completed."),
            },
        },
        "history": [],
        "artifacts": [artifact],
    }
    TASKS[task_id] = final_task
    yield _sse(
        "status-update",
        {
            "kind": "status-update",
            "taskId": task_id,
            "contextId": CONTEXT_ID,
            "status": final_task["status"],
            "final": True,
        },
    )


def _sse(kind: str, payload: Dict[str, Any]) -> str:
    """Format one SSE event per §9: event line, data line, blank line."""
    return f"event: {kind}\ndata: {json.dumps(payload, default=str)}\n\n"


@app.post("/message:stream")
async def message_stream(request: Request) -> Response:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    if not _content_type_ok(request):
        return _error_response(
            ERR_BAD_REQUEST, "Unsupported Content-Type", 400,
            request.headers.get("x-correlation-id"),
        )
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _error_response(
            ERR_BAD_REQUEST, "Invalid JSON body", 400,
            request.headers.get("x-correlation-id"),
        )
    _log_request(request, "message.stream")

    # Kick off the mission concurrently; the SSE generator awaits it.
    loop = asyncio.get_event_loop()
    summary_future: "asyncio.Future[Dict[str, Any]]" = loop.create_future()

    async def _run() -> None:
        try:
            result = await _run_mission_fresh()
            if not summary_future.done():
                summary_future.set_result(result)
        except Exception as exc:  # noqa: BLE001
            log.error("message_stream.mission_failed", error=str(exc))
            if not summary_future.done():
                summary_future.set_result(
                    {"final_summary": f"Mission failed: {exc}", "status": "failed"}
                )

    asyncio.create_task(_run())

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    }
    cid = request.headers.get("x-correlation-id")
    tid = request.headers.get("x-trace-id")
    if cid:
        headers["X-Correlation-ID"] = cid
    if tid:
        headers["X-Trace-ID"] = tid

    return StreamingResponse(
        _orchestrator_sse(summary_future),
        media_type="text/event-stream",
        headers=headers,
    )


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, request: Request) -> JSONResponse:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    _log_request(request, "tasks.get", taskId=task_id)
    task = TASKS.get(task_id)
    if not task:
        return _error_response(
            ERR_TASK_NOT_FOUND, f"No task {task_id}", 404,
            request.headers.get("x-correlation-id"),
        )
    response = JSONResponse(content=task)
    _echo_headers(request, response)
    return response


@app.get("/tasks")
async def list_tasks(
    request: Request,
    contextId: Optional[str] = Query(default=None),
    state: Optional[str] = Query(default=None),
    pageSize: int = Query(default=50),
) -> JSONResponse:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    _log_request(request, "tasks.list")
    tasks: List[Dict[str, Any]] = list(TASKS.values())
    if contextId:
        tasks = [t for t in tasks if t.get("contextId") == contextId]
    if state:
        tasks = [t for t in tasks if (t.get("status") or {}).get("state") == state]
    tasks = tasks[: max(0, pageSize)]
    response = JSONResponse(content={"tasks": tasks})
    _echo_headers(request, response)
    return response


@app.post("/tasks/{task_id}:subscribe")
async def subscribe_task(task_id: str, request: Request) -> Response:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    _log_request(request, "tasks.subscribe", taskId=task_id)
    task = TASKS.get(task_id)
    if not task:
        return _error_response(
            ERR_TASK_NOT_FOUND, f"No task {task_id}", 404,
            request.headers.get("x-correlation-id"),
        )

    async def _gen() -> AsyncIterator[str]:
        # Replay the known task, then a final completed status update (§9).
        yield _sse("task", {"kind": "task", "task": task})
        status = task.get("status") or {}
        state = status.get("state")
        if state != TASK_STATE_COMPLETED:
            yield _sse(
                "status-update",
                {
                    "kind": "status-update",
                    "taskId": task_id,
                    "contextId": task.get("contextId", CONTEXT_ID),
                    "status": {
                        "state": TASK_STATE_WORKING,
                        "timestamp": now_iso(),
                        "metadata": {"phase": "orchestrating_mission", "display": "Mission in progress."},
                    },
                    "final": False,
                },
            )
        for artifact in task.get("artifacts") or []:
            yield _sse(
                "artifact-update",
                {
                    "kind": "artifact-update",
                    "taskId": task_id,
                    "contextId": task.get("contextId", CONTEXT_ID),
                    "artifact": artifact,
                    "final": False,
                },
            )
        yield _sse(
            "status-update",
            {
                "kind": "status-update",
                "taskId": task_id,
                "contextId": task.get("contextId", CONTEXT_ID),
                "status": {
                    "state": TASK_STATE_COMPLETED,
                    "timestamp": now_iso(),
                    "metadata": {"phase": "completed", "display": "Mission complete."},
                },
                "final": True,
            },
        )

    return StreamingResponse(_gen(), media_type="text/event-stream")


@app.post("/tasks/{task_id}:cancel")
async def cancel_task(task_id: str, request: Request) -> JSONResponse:
    auth_err = _auth_or_error(request)
    if auth_err:
        return auth_err
    _log_request(request, "tasks.cancel", taskId=task_id)
    task = TASKS.get(task_id)
    if not task:
        return _error_response(
            ERR_TASK_NOT_FOUND, f"No task {task_id}", 404,
            request.headers.get("x-correlation-id"),
        )
    state = (task.get("status") or {}).get("state")
    if state in (TASK_STATE_COMPLETED, TASK_STATE_CANCELED):
        return _error_response(
            ERR_TASK_NOT_CANCELABLE, f"Task {task_id} is not cancelable", 409,
            request.headers.get("x-correlation-id"),
        )
    task["status"] = {
        "state": TASK_STATE_CANCELED,
        "timestamp": now_iso(),
        "metadata": {"phase": "canceled", "display": "Mission canceled."},
    }
    TASKS[task_id] = task
    response = JSONResponse(content=task)
    _echo_headers(request, response)
    return response
