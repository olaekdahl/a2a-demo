"""aiosqlite helpers for the Agent Registry Service.

Applies storage/schema.sql idempotently at startup, enables WAL journalling and a
5000 ms busy timeout (docs/protocol.md §14), and provides upsert/query helpers for
the `agents` and `agent_cards` tables. The DB file path comes from A2A_DB_PATH.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

import aiosqlite

DEFAULT_DB_PATH = "/data/mission.db"


def db_path() -> str:
    return os.environ.get("A2A_DB_PATH", DEFAULT_DB_PATH)


def _schema_path() -> str:
    """Locate storage/schema.sql.

    In the Docker image the schema is copied to /app/schema.sql. When running from
    the repo it lives at <repo>/storage/schema.sql. Try both.
    """
    candidates = [
        "/app/schema.sql",
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "storage", "schema.sql"),
        os.path.join(os.path.dirname(__file__), "..", "schema.sql"),
    ]
    for c in candidates:
        rp = os.path.abspath(c)
        if os.path.exists(rp):
            return rp
    # Fall back to the Docker location even if missing so the error is explicit.
    return "/app/schema.sql"


async def init_db() -> None:
    """Apply the schema idempotently and set the required PRAGMAs."""
    path = db_path()
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)

    schema_sql = ""
    sp = _schema_path()
    if os.path.exists(sp):
        with open(sp, "r", encoding="utf-8") as fh:
            schema_sql = fh.read()

    async with aiosqlite.connect(path) as conn:
        await conn.execute("PRAGMA journal_mode=WAL;")
        await conn.execute("PRAGMA busy_timeout=5000;")
        await conn.execute("PRAGMA foreign_keys=ON;")
        if schema_sql:
            await conn.executescript(schema_sql)
        await conn.commit()


async def _connect() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(db_path())
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA busy_timeout=5000;")
    return conn


async def upsert_agent(
    name: str,
    language: Optional[str],
    base_url: Optional[str],
    health_status: str,
) -> None:
    """Insert or update an `agents` row keyed by the unique `name`."""
    now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    conn = await _connect()
    try:
        await conn.execute(
            f"""
            INSERT INTO agents (name, language, base_url, health_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, {now}, {now})
            ON CONFLICT(name) DO UPDATE SET
                language = excluded.language,
                base_url = excluded.base_url,
                health_status = excluded.health_status,
                updated_at = {now}
            """,
            (name, language, base_url, health_status),
        )
        await conn.commit()
    finally:
        await conn.close()


async def update_health(name: str, health_status: str) -> None:
    conn = await _connect()
    try:
        await conn.execute(
            "UPDATE agents SET health_status = ?, "
            "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?",
            (health_status, name),
        )
        await conn.commit()
    finally:
        await conn.close()


async def replace_card(agent_name: str, card: dict[str, Any]) -> None:
    """Store the freshest Agent Card for an agent.

    Replaces any prior card rows for this agent so `agent_cards` holds the latest.
    """
    card_json = json.dumps(card, separators=(",", ":"), ensure_ascii=False)
    version = card.get("version")
    conn = await _connect()
    try:
        await conn.execute("DELETE FROM agent_cards WHERE agent_name = ?", (agent_name,))
        await conn.execute(
            """
            INSERT INTO agent_cards (agent_name, card_json, version, fetched_at)
            VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            """,
            (agent_name, card_json, version),
        )
        await conn.commit()
    finally:
        await conn.close()


async def get_card(agent_name: str) -> Optional[dict[str, Any]]:
    conn = await _connect()
    try:
        async with conn.execute(
            "SELECT card_json FROM agent_cards WHERE agent_name = ? ORDER BY id DESC LIMIT 1",
            (agent_name,),
        ) as cur:
            row = await cur.fetchone()
            if row and row["card_json"]:
                return json.loads(row["card_json"])
            return None
    finally:
        await conn.close()


async def list_agents() -> list[dict[str, Any]]:
    """Return every agent joined with its latest card (if any)."""
    conn = await _connect()
    try:
        async with conn.execute(
            "SELECT name, language, base_url, health_status FROM agents ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
        agents: list[dict[str, Any]] = []
        for row in rows:
            card = await get_card(row["name"])
            agents.append(
                {
                    "name": row["name"],
                    "language": row["language"],
                    "base_url": row["base_url"],
                    "health_status": row["health_status"],
                    "card": card,
                }
            )
        return agents
    finally:
        await conn.close()


async def get_agent(name: str) -> Optional[dict[str, Any]]:
    conn = await _connect()
    try:
        async with conn.execute(
            "SELECT name, language, base_url, health_status FROM agents WHERE name = ?",
            (name,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        card = await get_card(row["name"])
        return {
            "name": row["name"],
            "language": row["language"],
            "base_url": row["base_url"],
            "health_status": row["health_status"],
            "card": card,
        }
    finally:
        await conn.close()
