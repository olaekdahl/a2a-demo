"""Read-only SQLite helpers for the Dashboard API.

The dashboard NEVER writes mission data. It only reads from the shared SQLite
database produced by the Command Agent and the Registry. The single write it
performs is applying ``storage/schema.sql`` idempotently at startup so the
dashboard can boot and serve even before any other service has created tables.

WAL journaling and a busy timeout are enabled so concurrent readers/writers
(the Command Agent writes while the dashboard reads) do not collide.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import aiosqlite

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_PATH: str = os.environ.get("A2A_DB_PATH", "/data/mission.db")

# The schema file is copied into the image at /app/schema.sql by the Dockerfile.
# When running from source the repo path is used as a fallback.
_SCHEMA_CANDIDATES = [
    os.environ.get("A2A_SCHEMA_PATH", ""),
    "/app/schema.sql",
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "storage", "schema.sql"),
]


def _schema_path() -> Optional[str]:
    for candidate in _SCHEMA_CANDIDATES:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


async def _configure(conn: aiosqlite.Connection) -> None:
    """Apply the connection-level pragmas required by the contract (§14)."""
    await conn.execute("PRAGMA journal_mode=WAL;")
    await conn.execute("PRAGMA busy_timeout=5000;")
    await conn.execute("PRAGMA foreign_keys=ON;")
    conn.row_factory = aiosqlite.Row


async def apply_schema() -> None:
    """Apply ``schema.sql`` idempotently so the dashboard can start alone.

    Every statement in the schema uses ``CREATE TABLE IF NOT EXISTS`` /
    ``CREATE INDEX IF NOT EXISTS``, so re-running it is a no-op when the
    Command Agent has already created the tables.
    """
    # Ensure the parent directory exists (helps when running locally).
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)

    path = _schema_path()
    async with aiosqlite.connect(DB_PATH) as conn:
        await _configure(conn)
        if path:
            with open(path, "r", encoding="utf-8") as handle:
                schema_sql = handle.read()
            await conn.executescript(schema_sql)
        await conn.commit()


async def connect() -> aiosqlite.Connection:
    """Open a fully configured read connection."""
    conn = await aiosqlite.connect(DB_PATH)
    await _configure(conn)
    return conn


def _row_to_dict(row: aiosqlite.Row) -> Dict[str, Any]:
    return {key: row[key] for key in row.keys()}


async def fetch_all(query: str, params: tuple = ()) -> List[Dict[str, Any]]:
    conn = await connect()
    try:
        try:
            cursor = await conn.execute(query, params)
        except aiosqlite.OperationalError:
            # Table may not exist yet if no service has run; return empty.
            return []
        rows = await cursor.fetchall()
        return [_row_to_dict(row) for row in rows]
    finally:
        await conn.close()


async def fetch_one(query: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
    conn = await connect()
    try:
        try:
            cursor = await conn.execute(query, params)
        except aiosqlite.OperationalError:
            return None
        row = await cursor.fetchone()
        return _row_to_dict(row) if row else None
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Domain read helpers — column names match storage/schema.sql EXACTLY.
# ---------------------------------------------------------------------------


async def latest_mission() -> Optional[Dict[str, Any]]:
    """The most recent mission row (by id)."""
    return await fetch_one(
        """
        SELECT id, name, objective, context_id, status, phase,
               started_at, completed_at, final_summary
        FROM missions
        ORDER BY id DESC
        LIMIT 1
        """
    )


async def agents() -> List[Dict[str, Any]]:
    """Agents from the registry table, joined with their latest card JSON."""
    rows = await fetch_all(
        """
        SELECT name, language, base_url, health_status, created_at, updated_at
        FROM agents
        ORDER BY id ASC
        """
    )
    out: List[Dict[str, Any]] = []
    for row in rows:
        card = await fetch_one(
            """
            SELECT card_json, version, fetched_at
            FROM agent_cards
            WHERE agent_name = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (row["name"],),
        )
        card_json: Any = None
        if card and card.get("card_json"):
            try:
                card_json = json.loads(card["card_json"])
            except (ValueError, TypeError):
                card_json = None
        out.append(
            {
                "name": row["name"],
                "language": row["language"],
                "base_url": row["base_url"],
                "health_status": row["health_status"],
                "card": card_json,
            }
        )
    return out


async def timeline() -> List[Dict[str, Any]]:
    """Transmissions ordered by id — the live event stream."""
    return await fetch_all(
        """
        SELECT id, context_id, task_id, sender, recipient, label,
               message_type, direction, status, summary, message_ref, created_at
        FROM transmissions
        ORDER BY id ASC
        """
    )


async def timeline_after(last_id: int) -> List[Dict[str, Any]]:
    """Transmissions with id greater than ``last_id`` (for SSE polling)."""
    return await fetch_all(
        """
        SELECT id, context_id, task_id, sender, recipient, label,
               message_type, direction, status, summary, message_ref, created_at
        FROM transmissions
        WHERE id > ?
        ORDER BY id ASC
        """,
        (last_id,),
    )


async def message_by_id(message_id: str) -> Optional[Dict[str, Any]]:
    """Raw request/response/headers JSON for the inspector."""
    return await fetch_one(
        """
        SELECT id, message_id, context_id, task_id, sender, recipient,
               direction, request_json, response_json, headers_json, created_at
        FROM messages
        WHERE message_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (message_id,),
    )


async def tasks() -> List[Dict[str, Any]]:
    return await fetch_all(
        """
        SELECT id, task_id, context_id, agent_name, skill_id, state,
               created_at, updated_at, completed_at
        FROM tasks
        ORDER BY id ASC
        """
    )


async def task_by_id(task_id: str) -> Optional[Dict[str, Any]]:
    return await fetch_one(
        """
        SELECT id, task_id, context_id, agent_name, skill_id, state,
               created_at, updated_at, completed_at
        FROM tasks
        WHERE task_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (task_id,),
    )


async def status_updates(context_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if context_id:
        return await fetch_all(
            """
            SELECT id, task_id, context_id, agent_name, state, phase,
                   message, raw_json, created_at
            FROM task_status_updates
            WHERE context_id = ?
            ORDER BY id ASC
            """,
            (context_id,),
        )
    return await fetch_all(
        """
        SELECT id, task_id, context_id, agent_name, state, phase,
               message, raw_json, created_at
        FROM task_status_updates
        ORDER BY id ASC
        """
    )


async def status_updates_after(last_id: int) -> List[Dict[str, Any]]:
    return await fetch_all(
        """
        SELECT id, task_id, context_id, agent_name, state, phase,
               message, raw_json, created_at
        FROM task_status_updates
        WHERE id > ?
        ORDER BY id ASC
        """,
        (last_id,),
    )


async def artifacts() -> List[Dict[str, Any]]:
    return await fetch_all(
        """
        SELECT id, artifact_id, task_id, context_id, agent_name, name,
               media_type, artifact_json, created_at
        FROM artifacts
        ORDER BY id ASC
        """
    )


async def latest_deployment_artifact() -> Optional[Dict[str, Any]]:
    """The most recent ``deployment-order`` artifact (Fleet Movement Agent)."""
    return await fetch_one(
        """
        SELECT id, artifact_id, task_id, context_id, agent_name, name,
               media_type, artifact_json, created_at
        FROM artifacts
        WHERE name = 'deployment-order'
        ORDER BY id DESC
        LIMIT 1
        """
    )


async def latest_status_update() -> Optional[Dict[str, Any]]:
    """Most recent fleet/intel status update (for the 'current phase' label)."""
    return await fetch_one(
        """
        SELECT id, task_id, context_id, agent_name, state, phase,
               message, raw_json, created_at
        FROM task_status_updates
        ORDER BY id DESC
        LIMIT 1
        """
    )


async def audit() -> List[Dict[str, Any]]:
    return await fetch_all(
        """
        SELECT id, trace_id, correlation_id, actor, action,
               details_json, created_at
        FROM audit_logs
        ORDER BY id ASC
        """
    )


async def dead_letters() -> List[Dict[str, Any]]:
    """Dead-letter queue rows (messages that exhausted all retries, §17.5)."""
    return await fetch_all(
        """
        SELECT id, context_id, correlation_id, trace_id, sender, recipient,
               skill_id, attempts, last_error, request_json, created_at
        FROM dead_letters
        ORDER BY id ASC
        """
    )


async def max_transmission_id() -> int:
    row = await fetch_one("SELECT COALESCE(MAX(id), 0) AS m FROM transmissions")
    return int(row["m"]) if row else 0


async def max_status_update_id() -> int:
    row = await fetch_one("SELECT COALESCE(MAX(id), 0) AS m FROM task_status_updates")
    return int(row["m"]) if row else 0
