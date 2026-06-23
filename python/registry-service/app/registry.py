"""Agent discovery: fetch + cache Agent Cards, retry/backoff, and skill search.

On startup the registry parses AGENT_ENDPOINTS (docs/protocol.md §15) and fetches
each agent's `/.well-known/agent-card.json` with exponential backoff (agents may
still be warming up). Successful cards are upserted into the shared SQLite DB and
the agent's `health_status` is set accordingly. Failures are tolerated: the agent
is marked `unknown` and re-tried over a few rounds.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from . import db

logger = logging.getLogger("agent-registry")

A2A_VERSION = os.environ.get("A2A_VERSION", "1.0")
A2A_DEMO_TOKEN = os.environ.get("A2A_DEMO_TOKEN", "resistance-demo-token")

WELL_KNOWN_PATH = "/.well-known/agent-card.json"


@dataclass
class Endpoint:
    name: str
    language: str
    base_url: str


def parse_endpoints(raw: Optional[str]) -> list[Endpoint]:
    """Parse the `name|language|baseUrl,...` AGENT_ENDPOINTS string."""
    endpoints: list[Endpoint] = []
    if not raw:
        return endpoints
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split("|")
        if len(parts) < 3:
            logger.warning(
                json.dumps(
                    {
                        "event": "endpoint.parse_skipped",
                        "service": "agent-registry",
                        "language": "python",
                        "level": "warning",
                        "raw": chunk,
                    }
                )
            )
            continue
        name, language, base_url = parts[0].strip(), parts[1].strip(), parts[2].strip()
        endpoints.append(Endpoint(name=name, language=language, base_url=base_url.rstrip("/")))
    return endpoints


def a2a_headers() -> dict[str, str]:
    """Standard inter-agent headers (docs/protocol.md §1) for card fetches."""
    return {
        "A2A-Version": A2A_VERSION,
        "X-Correlation-ID": f"corr-{uuid.uuid4()}",
        "X-Trace-ID": f"trace-{uuid.uuid4()}",
        "X-Demo-Token": A2A_DEMO_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }


class Registry:
    """Holds the configured endpoints and orchestrates card fetching."""

    def __init__(self, endpoints: list[Endpoint]) -> None:
        self.endpoints = endpoints
        # ETag-aware card caching (docs/protocol.md §17.1): remember the strong
        # validator and last-parsed card per agent so subsequent fetches can send
        # If-None-Match and skip re-parsing on a 304 Not Modified.
        self._etags: dict[str, str] = {}
        self._cards: dict[str, dict[str, Any]] = {}

    async def seed_agents(self) -> None:
        """Insert every configured agent as `unknown` before any fetch succeeds."""
        for ep in self.endpoints:
            await db.upsert_agent(ep.name, ep.language, ep.base_url, "unknown")

    async def fetch_card(
        self,
        client: httpx.AsyncClient,
        endpoint: Endpoint,
        attempts: int = 5,
        base_delay: float = 1.0,
        max_delay: float = 10.0,
    ) -> Optional[dict[str, Any]]:
        """Fetch one agent's card with exponential backoff. Returns the card or None.

        Sends `If-None-Match` with the stored ETag (docs/protocol.md §17.1); if the
        agent replies `304 Not Modified`, the cached card is kept (logging
        `card.unchanged`) instead of being re-parsed.
        """
        url = endpoint.base_url + WELL_KNOWN_PATH
        delay = base_delay
        for attempt in range(1, attempts + 1):
            try:
                headers = a2a_headers()
                stored_etag = self._etags.get(endpoint.name)
                if stored_etag:
                    headers["If-None-Match"] = stored_etag
                resp = await client.get(url, headers=headers)

                # 304 Not Modified: the card is unchanged — keep the cached copy.
                if resp.status_code == 304 and endpoint.name in self._cards:
                    logger.info(
                        json.dumps(
                            {
                                "event": "card.unchanged",
                                "service": "agent-registry",
                                "language": "python",
                                "level": "info",
                                "agent": endpoint.name,
                                "url": url,
                                "attempt": attempt,
                                "etag": stored_etag,
                            }
                        )
                    )
                    return self._cards[endpoint.name]

                resp.raise_for_status()
                card = resp.json()
                if not isinstance(card, dict):
                    raise ValueError("agent card is not a JSON object")
                # Cache the card + its ETag for future conditional requests.
                self._cards[endpoint.name] = card
                etag = resp.headers.get("ETag")
                if etag:
                    self._etags[endpoint.name] = etag
                logger.info(
                    json.dumps(
                        {
                            "event": "card.fetched",
                            "service": "agent-registry",
                            "language": "python",
                            "level": "info",
                            "agent": endpoint.name,
                            "url": url,
                            "attempt": attempt,
                            "etag": etag,
                        }
                    )
                )
                return card
            except Exception as exc:  # noqa: BLE001 — tolerate any fetch failure
                logger.warning(
                    json.dumps(
                        {
                            "event": "card.fetch_failed",
                            "service": "agent-registry",
                            "language": "python",
                            "level": "warning",
                            "agent": endpoint.name,
                            "url": url,
                            "attempt": attempt,
                            "error": str(exc),
                        }
                    )
                )
                if attempt < attempts:
                    await asyncio.sleep(delay)
                    delay = min(max_delay, delay * 2)
        return None

    async def refresh_one(self, client: httpx.AsyncClient, endpoint: Endpoint) -> bool:
        """Fetch and persist a single agent's card. Returns True on success."""
        card = await self.fetch_card(client, endpoint)
        if card is None:
            await db.upsert_agent(endpoint.name, endpoint.language, endpoint.base_url, "unknown")
            return False
        await db.upsert_agent(endpoint.name, endpoint.language, endpoint.base_url, "healthy")
        await db.replace_card(endpoint.name, card)
        return True

    async def refresh_all(self) -> list[dict[str, Any]]:
        """Re-fetch every configured agent's card concurrently and persist results."""
        await self.seed_agents()
        async with httpx.AsyncClient(timeout=10.0) as client:
            await asyncio.gather(
                *(self.refresh_one(client, ep) for ep in self.endpoints),
                return_exceptions=True,
            )
        return await db.list_agents()

    async def warmup_loop(self, rounds: int = 6, round_delay: float = 5.0) -> None:
        """Background startup task: keep retrying until all agents are healthy.

        Runs a few rounds so agents that boot slowly are eventually registered.
        Tolerates failures throughout.
        """
        await self.seed_agents()
        for round_no in range(1, rounds + 1):
            async with httpx.AsyncClient(timeout=10.0) as client:
                results = await asyncio.gather(
                    *(self.refresh_one(client, ep) for ep in self.endpoints),
                    return_exceptions=True,
                )
            healthy = sum(1 for r in results if r is True)
            logger.info(
                json.dumps(
                    {
                        "event": "warmup.round",
                        "service": "agent-registry",
                        "language": "python",
                        "level": "info",
                        "round": round_no,
                        "healthy": healthy,
                        "total": len(self.endpoints),
                    }
                )
            )
            if healthy >= len(self.endpoints):
                break
            if round_no < rounds:
                await asyncio.sleep(round_delay)


async def search_by_skill(skill_id: str) -> list[dict[str, Any]]:
    """Return raw Agent Cards whose `skills[].id` equals `skill_id`."""
    matches: list[dict[str, Any]] = []
    for agent in await db.list_agents():
        card = agent.get("card")
        if not card:
            continue
        for skill in card.get("skills", []) or []:
            if isinstance(skill, dict) and skill.get("id") == skill_id:
                matches.append(card)
                break
    return matches
