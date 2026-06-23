"""Agent Registry Service — Python / FastAPI (docs/protocol.md §12.7).

A discovery registry (NOT a normal A2A agent — no /message:* endpoints). On
startup it applies the shared SQLite schema, parses AGENT_ENDPOINTS, and launches
a background task that fetches every agent's Agent Card with retry/backoff,
persisting `agents` + `agent_cards` rows and setting `health_status`.

Endpoints (exactly §12.7):
  GET  /health
  GET  /.well-known/agent-card.json   (registry's own card; no auth)
  GET  /agents
  GET  /agents/{name}
  GET  /agents/search?skill=<id>
  POST /agents/refresh

Auth: every endpoint except GET /health and GET /.well-known/agent-card.json
requires the X-Demo-Token header; if absent → HTTP 401 with the §11 error body.
The token value is not validated.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import db
from .registry import Registry, parse_endpoints, search_by_skill

SERVICE_NAME = "agent-registry"
LANGUAGE = "python"
PORT = int(os.environ.get("PORT", "8000"))

JSON_CONTENT_TYPES = {"application/json", "application/a2a+json"}

# Endpoints that do NOT require the X-Demo-Token header. The FastAPI auto-docs
# (/docs, /openapi.json, /redoc) are exempt so the OpenAPI UI is reachable
# unauthenticated, matching the dashboard + command services.
PUBLIC_PATHS = {
    "/health",
    "/.well-known/agent-card.json",
    "/docs",
    "/openapi.json",
    "/redoc",
}


def _is_public(path: str) -> bool:
    """True if `path` is auth-exempt (a public endpoint or under /.well-known)."""
    return path in PUBLIC_PATHS or path.startswith("/.well-known")


# --------------------------------------------------------------------------- #
# Structured JSON logging
# --------------------------------------------------------------------------- #
class JsonLogFormatter(logging.Formatter):
    """Render each log record as a single-line JSON object (docs/protocol.md §16)."""

    def format(self, record: logging.LogRecord) -> str:
        # If the message is already a JSON object string, merge it; else wrap it.
        base: dict[str, Any] = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "service": SERVICE_NAME,
            "language": LANGUAGE,
            "level": record.levelname.lower(),
        }
        msg = record.getMessage()
        merged = False
        if msg.startswith("{") and msg.endswith("}"):
            try:
                payload = json.loads(msg)
                if isinstance(payload, dict):
                    base.update(payload)
                    # Keep canonical service/language/level/timestamp values.
                    base["service"] = SERVICE_NAME
                    base["language"] = LANGUAGE
                    base["level"] = record.levelname.lower()
                    merged = True
            except json.JSONDecodeError:
                merged = False
        if not merged:
            base["event"] = msg
        for key in ("correlationId", "traceId", "contextId", "taskId", "sender", "recipient"):
            val = getattr(record, key, None)
            if val is not None:
                base[key] = val
        return json.dumps(base, ensure_ascii=False)


def _configure_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLogFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    # Quiet uvicorn's default access logger; we log requests ourselves.
    logging.getLogger("uvicorn.access").handlers = [handler]
    logging.getLogger("uvicorn.access").propagate = False
    logging.getLogger("uvicorn.error").handlers = [handler]
    logging.getLogger("uvicorn.error").propagate = False
    return logging.getLogger(SERVICE_NAME)


logger = _configure_logging()


# --------------------------------------------------------------------------- #
# Registry's own Agent Card
# --------------------------------------------------------------------------- #
REGISTRY_SKILLS = [
    {
        "id": "discover_agents",
        "name": "Discover Agents",
        "description": "Lists every registered A2A agent and its Agent Card.",
        "inputModes": ["application/json"],
        "outputModes": ["application/json"],
        "examples": ["List all registered agents"],
    },
    {
        "id": "search_skill",
        "name": "Search By Skill",
        "description": "Finds agents whose Agent Card advertises a given skill id.",
        "inputModes": ["application/json"],
        "outputModes": ["application/json"],
        "examples": ["Find the agent that can scout_system"],
    },
]


def registry_agent_card() -> dict[str, Any]:
    own_url = os.environ.get("REGISTRY_URL", f"http://agent-registry:{PORT}")
    return {
        "name": SERVICE_NAME,
        "description": "A2A discovery registry. Fetches and serves agent cards.",
        "provider": {"organization": "Rebel Alliance", "url": "https://resistance.local"},
        "version": "1.0.0",
        "url": own_url,
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": REGISTRY_SKILLS,
        "securitySchemes": {
            "demoApiKey": {"type": "apiKey", "in": "header", "name": "X-Demo-Token"}
        },
        "security": [{"demoApiKey": []}],
    }


# --------------------------------------------------------------------------- #
# Error helpers (docs/protocol.md §11)
# --------------------------------------------------------------------------- #
def error_response(
    code: str, message: str, http_status: int, correlation_id: Optional[str]
) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content={
            "error": {
                "code": code,
                "message": message,
                "httpStatus": http_status,
                "correlationId": correlation_id,
            }
        },
    )


# --------------------------------------------------------------------------- #
# App lifecycle
# --------------------------------------------------------------------------- #
def _print_banner(endpoints_count: int) -> None:
    skills = ", ".join(s["id"] for s in REGISTRY_SKILLS)
    banner = (
        "\n"
        "==================================================================\n"
        f"  {SERVICE_NAME}  ({LANGUAGE})\n"
        f"  port      : {PORT}\n"
        f"  role      : A2A discovery registry (no /message:* endpoints)\n"
        f"  skills    : {skills}\n"
        f"  endpoints : {endpoints_count} agent(s) configured via AGENT_ENDPOINTS\n"
        f"  db        : {db.db_path()}\n"
        "==================================================================\n"
    )
    print(banner, flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    endpoints = parse_endpoints(os.environ.get("AGENT_ENDPOINTS"))
    app.state.registry = Registry(endpoints)

    await db.init_db()
    _print_banner(len(endpoints))
    logger.info(
        json.dumps(
            {
                "event": "startup",
                "port": PORT,
                "agents_configured": len(endpoints),
                "db_path": db.db_path(),
            }
        )
    )

    # Seed agents immediately so /agents is populated even before fetches finish.
    await app.state.registry.seed_agents()

    # Launch the background warmup loop (fetch cards with retry/backoff).
    import asyncio

    app.state.warmup_task = asyncio.create_task(app.state.registry.warmup_loop())

    try:
        yield
    finally:
        task = getattr(app.state, "warmup_task", None)
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


app = FastAPI(title="Agent Registry Service", version="1.0.0", lifespan=lifespan)


# --------------------------------------------------------------------------- #
# Middleware: structured request logging + auth
# --------------------------------------------------------------------------- #
@app.middleware("http")
async def request_middleware(request: Request, call_next):
    correlation_id = request.headers.get("X-Correlation-ID") or f"corr-{uuid.uuid4()}"
    trace_id = request.headers.get("X-Trace-ID")
    start = time.monotonic()

    path = request.url.path

    # Auth: every endpoint except the public ones requires X-Demo-Token.
    if not _is_public(path):
        if not request.headers.get("X-Demo-Token"):
            logger.warning(
                json.dumps(
                    {
                        "event": "request.unauthorized",
                        "method": request.method,
                        "path": path,
                        "correlationId": correlation_id,
                        "traceId": trace_id,
                    }
                )
            )
            resp = error_response(
                "AUTH_REQUIRED",
                "Missing X-Demo-Token header.",
                401,
                correlation_id,
            )
            resp.headers["X-Correlation-ID"] = correlation_id
            if trace_id:
                resp.headers["X-Trace-ID"] = trace_id
            return resp

        # Protocol version mismatch (docs/protocol.md §17.2): if A2A-Version is
        # present and its major component differs from 1, reject with 400. A
        # matching or absent version passes (1.0/absent are fine).
        a2a_version = request.headers.get("A2A-Version")
        if a2a_version and a2a_version.split(".")[0] != "1":
            logger.warning(
                json.dumps(
                    {
                        "event": "request.version_not_supported",
                        "method": request.method,
                        "path": path,
                        "a2aVersion": a2a_version,
                        "correlationId": correlation_id,
                        "traceId": trace_id,
                    }
                )
            )
            resp = error_response(
                "VERSION_NOT_SUPPORTED",
                f"Unsupported A2A protocol version '{a2a_version}'; this service speaks 1.x.",
                400,
                correlation_id,
            )
            resp.headers["X-Correlation-ID"] = correlation_id
            if trace_id:
                resp.headers["X-Trace-ID"] = trace_id
            return resp

    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            json.dumps(
                {
                    "event": "request.error",
                    "method": request.method,
                    "path": path,
                    "error": str(exc),
                    "correlationId": correlation_id,
                    "traceId": trace_id,
                }
            )
        )
        resp = error_response("INTERNAL", str(exc), 500, correlation_id)
        resp.headers["X-Correlation-ID"] = correlation_id
        if trace_id:
            resp.headers["X-Trace-ID"] = trace_id
        return resp

    duration_ms = round((time.monotonic() - start) * 1000, 2)
    response.headers["X-Correlation-ID"] = correlation_id
    if trace_id:
        response.headers["X-Trace-ID"] = trace_id

    logger.info(
        json.dumps(
            {
                "event": "request",
                "method": request.method,
                "path": path,
                "status": response.status_code,
                "durationMs": duration_ms,
                "correlationId": correlation_id,
                "traceId": trace_id,
            }
        )
    )
    return response


def _corr(request: Request) -> str:
    return request.headers.get("X-Correlation-ID") or f"corr-{uuid.uuid4()}"


# --------------------------------------------------------------------------- #
# Routes (docs/protocol.md §12.7)
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/.well-known/agent-card.json")
async def agent_card() -> JSONResponse:
    return JSONResponse(content=registry_agent_card())


@app.get("/agents")
async def get_agents() -> JSONResponse:
    agents = await db.list_agents()
    return JSONResponse(content={"agents": agents})


@app.get("/agents/search")
async def search_agents(request: Request, skill: Optional[str] = None) -> JSONResponse:
    if not skill:
        return error_response(
            "BAD_REQUEST",
            "Query parameter 'skill' is required.",
            400,
            _corr(request),
        )
    cards = await search_by_skill(skill)
    return JSONResponse(content={"agents": cards})


@app.get("/agents/{name}")
async def get_agent_by_name(name: str, request: Request) -> JSONResponse:
    agent = await db.get_agent(name)
    if agent is None:
        return error_response(
            "AGENT_NOT_FOUND",
            f"No agent {name}",
            404,
            _corr(request),
        )
    return JSONResponse(content=agent)


@app.post("/agents/refresh")
async def refresh_agents(request: Request) -> JSONResponse:
    registry: Registry = request.app.state.registry
    agents = await registry.refresh_all()
    logger.info(
        json.dumps(
            {
                "event": "agents.refreshed",
                "count": len(agents),
                "correlationId": _corr(request),
            }
        )
    )
    return JSONResponse(content={"agents": agents})
