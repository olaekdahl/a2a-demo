"""HTTP client for talking to remote A2A agents and the registry.

Sends the §1 inter-agent headers on every request, parses SSE `data:` lines
into events, and wraps every call in an exponential-backoff retry (3 attempts).
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from .logging_util import get_logger

log = get_logger()

A2A_VERSION = os.environ.get("A2A_VERSION", "1.0")
A2A_DEMO_TOKEN = os.environ.get("A2A_DEMO_TOKEN", "resistance-demo-token")
REGISTRY_URL = os.environ.get("REGISTRY_URL", "http://agent-registry:8000").rstrip("/")

DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
MAX_ATTEMPTS = 3
BASE_BACKOFF = 0.5  # seconds


def build_headers(correlation_id: str, trace_id: str) -> Dict[str, str]:
    """The §1 inter-agent request headers."""
    return {
        "A2A-Version": A2A_VERSION,
        "X-Correlation-ID": correlation_id,
        "X-Trace-ID": trace_id,
        "X-Demo-Token": A2A_DEMO_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }


def registry_headers() -> Dict[str, str]:
    """Headers for registry calls. The registry's auth middleware requires the
    X-Demo-Token on every path except /health and /.well-known/agent-card.json,
    so these MUST be present or the registry returns 401 (§1, §12.7)."""
    return {
        "A2A-Version": A2A_VERSION,
        "X-Demo-Token": A2A_DEMO_TOKEN,
        "Accept": "application/json",
    }


async def _retry(label: str, coro_factory):
    """Run an async factory with exponential backoff (3 attempts)."""
    last_exc: Optional[Exception] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return await coro_factory()
        except Exception as exc:  # noqa: BLE001 — resilience layer, log + retry
            last_exc = exc
            log.warn(
                "a2a_client.retry",
                label=label,
                attempt=attempt,
                max_attempts=MAX_ATTEMPTS,
                error=str(exc),
            )
            if attempt < MAX_ATTEMPTS:
                await asyncio.sleep(BASE_BACKOFF * (2 ** (attempt - 1)))
    assert last_exc is not None
    raise last_exc


class A2AClient:
    """Thin async wrapper over httpx for A2A + registry calls."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ A2A #
    async def send_message(
        self,
        base_url: str,
        request_body: Dict[str, Any],
        *,
        correlation_id: str,
        trace_id: str,
        simulate_transient: bool = False,
    ) -> Dict[str, Any]:
        """POST /message:send → SendMessageResponse dict ({ "task": {...} }).

        When `simulate_transient` is True (failure-simulation demo only, §17.3),
        the FIRST attempt inside `_do` raises a simulated transient error so the
        exponential-backoff retry visibly recovers on attempt 2 against this real,
        reachable agent. The flag is per-call and never set on the default path.
        """
        url = f"{base_url.rstrip('/')}/message:send"
        headers = build_headers(correlation_id, trace_id)
        transient_pending = simulate_transient

        async def _do() -> Dict[str, Any]:
            nonlocal transient_pending
            if transient_pending:
                transient_pending = False
                raise RuntimeError("simulated transient failure (recovers on retry)")
            resp = await self._client.post(url, json=request_body, headers=headers)
            resp.raise_for_status()
            return resp.json()

        return await _retry(f"send_message:{url}", _do)

    async def stream_message(
        self,
        base_url: str,
        request_body: Dict[str, Any],
        *,
        correlation_id: str,
        trace_id: str,
    ) -> List[Dict[str, Any]]:
        """POST /message:stream → list of parsed SSE event JSON objects.

        Parses the SSE `data:` lines (one single-line JSON per event) and
        returns them in arrival order. The `event:` line is ignored because the
        `kind` is embedded in the JSON (§9).
        """
        url = f"{base_url.rstrip('/')}/message:stream"
        headers = build_headers(correlation_id, trace_id)

        async def _do() -> List[Dict[str, Any]]:
            events: List[Dict[str, Any]] = []
            async with self._client.stream(
                "POST", url, json=request_body, headers=headers
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data:"):
                        payload = line[len("data:"):].strip()
                        if payload:
                            events.append(json.loads(payload))
            return events

        return await _retry(f"stream_message:{url}", _do)

    async def get_task(
        self,
        base_url: str,
        task_id: str,
        *,
        correlation_id: str,
        trace_id: str,
    ) -> Dict[str, Any]:
        """GET /tasks/{id} → authoritative Task dict."""
        url = f"{base_url.rstrip('/')}/tasks/{task_id}"
        headers = build_headers(correlation_id, trace_id)

        async def _do() -> Dict[str, Any]:
            resp = await self._client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.json()

        return await _retry(f"get_task:{url}", _do)

    async def fetch_agent_card(
        self,
        base_url: str,
        *,
        correlation_id: str,
        trace_id: str,
    ) -> Dict[str, Any]:
        """GET <base>/.well-known/agent-card.json → Agent Card dict."""
        url = f"{base_url.rstrip('/')}/.well-known/agent-card.json"
        headers = build_headers(correlation_id, trace_id)

        async def _do() -> Dict[str, Any]:
            resp = await self._client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.json()

        return await _retry(f"fetch_card:{url}", _do)

    # -------------------------------------------------------------- Registry #
    async def registry_health(self) -> bool:
        url = f"{REGISTRY_URL}/health"
        try:
            resp = await self._client.get(
                url, headers=registry_headers(), timeout=httpx.Timeout(5.0)
            )
            return resp.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def registry_agents(self) -> List[Dict[str, Any]]:
        """GET registry/agents → list of agent entries."""
        url = f"{REGISTRY_URL}/agents"

        async def _do() -> List[Dict[str, Any]]:
            resp = await self._client.get(url, headers=registry_headers())
            resp.raise_for_status()
            return resp.json().get("agents", [])

        return await _retry(f"registry_agents:{url}", _do)

    async def registry_refresh(self) -> List[Dict[str, Any]]:
        """POST registry/agents/refresh → updated list."""
        url = f"{REGISTRY_URL}/agents/refresh"

        async def _do() -> List[Dict[str, Any]]:
            resp = await self._client.post(url, headers=registry_headers())
            resp.raise_for_status()
            return resp.json().get("agents", [])

        return await _retry(f"registry_refresh:{url}", _do)

    async def registry_search(self, skill_id: str) -> List[Dict[str, Any]]:
        """GET registry/agents/search?skill=<id> → list of matching cards."""
        url = f"{REGISTRY_URL}/agents/search"

        async def _do() -> List[Dict[str, Any]]:
            resp = await self._client.get(
                url, params={"skill": skill_id}, headers=registry_headers()
            )
            resp.raise_for_status()
            return resp.json().get("agents", [])

        return await _retry(f"registry_search:{skill_id}", _do)

    async def find_agent_card_by_skill(
        self, skill_id: str, *, attempts: int = 20, delay: float = 1.0
    ) -> Dict[str, Any]:
        """Poll the registry until a card exposing `skill_id` is found.

        The registry may still be warming up, so retry until found.
        Returns the Agent Card dict for the first matching agent.
        """
        for attempt in range(1, attempts + 1):
            try:
                results = await self.registry_search(skill_id)
            except Exception as exc:  # noqa: BLE001
                log.warn("registry.search_failed", skill=skill_id, attempt=attempt, error=str(exc))
                results = []
            card = _extract_card_for_skill(results, skill_id)
            if card is not None:
                log.info("registry.found", skill=skill_id, attempt=attempt, agent=card.get("name"))
                return card
            log.warn("registry.not_found_yet", skill=skill_id, attempt=attempt)
            await asyncio.sleep(delay)
        raise RuntimeError(f"No agent exposing skill '{skill_id}' found in registry")


def _extract_card_for_skill(results: List[Dict[str, Any]], skill_id: str) -> Optional[Dict[str, Any]]:
    """The registry returns cards (possibly wrapped in {name, card}). Find one
    whose skills contain `skill_id` and return the raw Agent Card dict."""
    for entry in results or []:
        card = entry.get("card") if isinstance(entry, dict) and "card" in entry else entry
        if not isinstance(card, dict):
            continue
        skills = card.get("skills") or []
        for skill in skills:
            if isinstance(skill, dict) and skill.get("id") == skill_id:
                return card
    # Fall back: first card that at least has a url.
    for entry in results or []:
        card = entry.get("card") if isinstance(entry, dict) and "card" in entry else entry
        if isinstance(card, dict) and card.get("url"):
            return card
    return None
