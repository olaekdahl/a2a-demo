"""Persistence layer for the Command Agent (§14).

Writes missions, messages, tasks, task_status_updates, artifacts,
transmissions and audit_logs to the shared SQLite database, exactly per
storage/schema.sql. Uses aiosqlite with WAL + busy_timeout=5000 and applies the
schema idempotently at startup.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

import aiosqlite

from .logging_util import get_logger
from .models import now_iso

log = get_logger()

DB_PATH = os.environ.get("A2A_DB_PATH", "/data/mission.db")
SCHEMA_PATH = os.environ.get("SCHEMA_PATH", "/app/schema.sql")


def _dumps(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)


class MissionStore:
    """Async SQLite persistence. One shared connection guarded by aiosqlite."""

    def __init__(self, db_path: str = DB_PATH) -> None:
        self.db_path = db_path
        self._db: Optional[aiosqlite.Connection] = None

    async def connect(self) -> None:
        # Ensure the directory exists when running outside docker.
        parent = os.path.dirname(self.db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)
        await self._db.execute("PRAGMA journal_mode=WAL;")
        await self._db.execute("PRAGMA busy_timeout=5000;")
        await self._db.execute("PRAGMA foreign_keys=ON;")
        await self._db.commit()
        await self.apply_schema()
        log.info("db.connected", db_path=self.db_path)

    async def apply_schema(self) -> None:
        """Apply storage/schema.sql idempotently (CREATE TABLE IF NOT EXISTS)."""
        assert self._db is not None
        schema_sql: Optional[str] = None
        for path in (SCHEMA_PATH, "/app/schema.sql", "storage/schema.sql"):
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as fh:
                    schema_sql = fh.read()
                break
        if schema_sql is None:
            log.warn("db.schema_missing", searched=SCHEMA_PATH)
            return
        await self._db.executescript(schema_sql)
        await self._db.commit()
        log.info("db.schema_applied")

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        assert self._db is not None, "MissionStore.connect() not called"
        return self._db

    # ----------------------------------------------------------- missions #
    async def clear_context(self, context_id: str) -> None:
        """Remove all mission rows for a contextId so a fresh run is clean."""
        tables_ctx = [
            "missions",
            "messages",
            "tasks",
            "task_status_updates",
            "artifacts",
            "transmissions",
            "dead_letters",
        ]
        for table in tables_ctx:
            await self.db.execute(
                f"DELETE FROM {table} WHERE context_id = ?", (context_id,)
            )
        await self.db.commit()
        log.info("db.context_cleared", contextId=context_id)

    async def create_mission(
        self, *, name: str, objective: str, context_id: str, status: str, phase: str
    ) -> int:
        cur = await self.db.execute(
            """INSERT INTO missions
               (name, objective, context_id, status, phase, started_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (name, objective, context_id, status, phase, now_iso()),
        )
        await self.db.commit()
        return cur.lastrowid or 0

    async def update_mission_phase(self, context_id: str, phase: str) -> None:
        await self.db.execute(
            "UPDATE missions SET phase = ? WHERE context_id = ?",
            (phase, context_id),
        )
        await self.db.commit()

    async def complete_mission(
        self, context_id: str, *, status: str, phase: str, final_summary: str
    ) -> None:
        await self.db.execute(
            """UPDATE missions
               SET status = ?, phase = ?, completed_at = ?, final_summary = ?
               WHERE context_id = ?""",
            (status, phase, now_iso(), final_summary, context_id),
        )
        await self.db.commit()

    async def latest_mission(self) -> Optional[Dict[str, Any]]:
        self.db.row_factory = aiosqlite.Row
        cur = await self.db.execute(
            "SELECT * FROM missions ORDER BY id DESC LIMIT 1"
        )
        row = await cur.fetchone()
        self.db.row_factory = None
        return dict(row) if row else None

    # ----------------------------------------------------------- messages #
    async def insert_message(
        self,
        *,
        message_id: str,
        context_id: str,
        task_id: Optional[str],
        sender: str,
        recipient: str,
        direction: str,
        request_json: Any,
        response_json: Any,
        headers_json: Any,
    ) -> None:
        await self.db.execute(
            """INSERT INTO messages
               (message_id, context_id, task_id, sender, recipient, direction,
                request_json, response_json, headers_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                message_id,
                context_id,
                task_id,
                sender,
                recipient,
                direction,
                _dumps(request_json),
                _dumps(response_json),
                _dumps(headers_json),
            ),
        )
        await self.db.commit()

    # -------------------------------------------------------------- tasks #
    async def upsert_task(
        self,
        *,
        task_id: str,
        context_id: str,
        agent_name: str,
        skill_id: str,
        state: str,
        completed_at: Optional[str] = None,
    ) -> None:
        self.db.row_factory = aiosqlite.Row
        cur = await self.db.execute(
            "SELECT id FROM tasks WHERE task_id = ? AND context_id = ?",
            (task_id, context_id),
        )
        existing = await cur.fetchone()
        self.db.row_factory = None
        if existing:
            # COALESCE so intermediate WORKING updates (completed_at=None) never
            # clear a completion timestamp that was already recorded.
            await self.db.execute(
                """UPDATE tasks SET state = ?, updated_at = ?,
                       completed_at = COALESCE(?, completed_at)
                   WHERE task_id = ? AND context_id = ?""",
                (state, now_iso(), completed_at, task_id, context_id),
            )
        else:
            await self.db.execute(
                """INSERT INTO tasks
                   (task_id, context_id, agent_name, skill_id, state, completed_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (task_id, context_id, agent_name, skill_id, state, completed_at),
            )
        await self.db.commit()

    async def list_tasks(
        self,
        *,
        context_id: Optional[str] = None,
        state: Optional[str] = None,
        page_size: int = 50,
    ) -> List[Dict[str, Any]]:
        self.db.row_factory = aiosqlite.Row
        clauses: List[str] = []
        params: List[Any] = []
        if context_id:
            clauses.append("context_id = ?")
            params.append(context_id)
        if state:
            clauses.append("state = ?")
            params.append(state)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(page_size)
        cur = await self.db.execute(
            f"SELECT * FROM tasks{where} ORDER BY id DESC LIMIT ?", params
        )
        rows = await cur.fetchall()
        self.db.row_factory = None
        return [dict(r) for r in rows]

    # ----------------------------------------------- task_status_updates #
    async def insert_status_update(
        self,
        *,
        task_id: str,
        context_id: str,
        agent_name: str,
        state: str,
        phase: str,
        message: str,
        raw_json: Any,
    ) -> None:
        await self.db.execute(
            """INSERT INTO task_status_updates
               (task_id, context_id, agent_name, state, phase, message, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (task_id, context_id, agent_name, state, phase, message, _dumps(raw_json)),
        )
        await self.db.commit()

    # ---------------------------------------------------------- artifacts #
    async def insert_artifact(
        self,
        *,
        artifact_id: str,
        task_id: str,
        context_id: str,
        agent_name: str,
        name: str,
        media_type: str,
        artifact_json: Any,
    ) -> None:
        # Streamed artifacts arrive twice — once live from the SSE artifact-update
        # event and once from the authoritative GET /tasks/{id}. They share the
        # same artifactId, so dedupe to keep a single row per artifact.
        if artifact_id:
            cur = await self.db.execute(
                "SELECT 1 FROM artifacts WHERE artifact_id = ? AND context_id = ? LIMIT 1",
                (artifact_id, context_id),
            )
            if await cur.fetchone():
                return
        await self.db.execute(
            """INSERT INTO artifacts
               (artifact_id, task_id, context_id, agent_name, name, media_type, artifact_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                artifact_id,
                task_id,
                context_id,
                agent_name,
                name,
                media_type,
                _dumps(artifact_json),
            ),
        )
        await self.db.commit()

    # ------------------------------------------------------ transmissions #
    async def insert_transmission(
        self,
        *,
        context_id: str,
        task_id: Optional[str],
        sender: str,
        recipient: str,
        label: str,
        message_type: str,
        direction: str,
        status: str,
        summary: str,
        message_ref: Optional[str],
    ) -> None:
        await self.db.execute(
            """INSERT INTO transmissions
               (context_id, task_id, sender, recipient, label, message_type,
                direction, status, summary, message_ref)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                context_id,
                task_id,
                sender,
                recipient,
                label,
                message_type,
                direction,
                status,
                summary,
                message_ref,
            ),
        )
        await self.db.commit()

    # ------------------------------------------------------- dead_letters #
    async def insert_dead_letter(
        self,
        *,
        context_id: str,
        correlation_id: str,
        trace_id: str,
        sender: str,
        recipient: str,
        skill_id: str,
        attempts: int,
        last_error: str,
        request_json: Any,
    ) -> None:
        """Write one exhausted-retry message to the dead_letters table (§17.3).

        Populated only when FAILURE_SIMULATION is on; demonstrates the
        retry/backoff -> dead-letter-queue resilience path.
        """
        await self.db.execute(
            """INSERT INTO dead_letters
               (context_id, correlation_id, trace_id, sender, recipient,
                skill_id, attempts, last_error, request_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                context_id,
                correlation_id,
                trace_id,
                sender,
                recipient,
                skill_id,
                attempts,
                last_error,
                _dumps(request_json),
            ),
        )
        await self.db.commit()

    # -------------------------------------------------------- audit_logs #
    async def insert_audit(
        self,
        *,
        trace_id: str,
        correlation_id: str,
        actor: str,
        action: str,
        details_json: Any,
    ) -> None:
        await self.db.execute(
            """INSERT INTO audit_logs
               (trace_id, correlation_id, actor, action, details_json)
               VALUES (?, ?, ?, ?, ?)""",
            (trace_id, correlation_id, actor, action, _dumps(details_json)),
        )
        await self.db.commit()
