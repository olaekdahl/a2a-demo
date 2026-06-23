"""Server-Sent-Events feed for the live dashboard.

``GET /api/events/stream`` polls the shared SQLite database every ~500 ms and
pushes three kinds of events to the browser:

* ``transmission``  — a new ``transmissions`` row (a fresh A2A hop / timeline
  event).
* ``status-update`` — a new ``task_status_updates`` row (fleet/intel progress).
* ``mission``       — the current mission state, emitted on connect and whenever
  the mission status/phase changes.

Each SSE event follows the standard wire format used across the demo::

    event: <kind>
    data: <single-line-json>

    (blank line)

The ``kind`` is also embedded inside the JSON payload so clients may rely on
either the ``event:`` line or the ``data:`` body.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator, Optional

from . import db

POLL_INTERVAL_SECONDS = 0.5
HEARTBEAT_EVERY_TICKS = 30  # ~15s keep-alive comment when nothing changes


def _sse(kind: str, payload: dict) -> str:
    """Format one SSE event. JSON is serialized to a single line."""
    body = dict(payload)
    body.setdefault("kind", kind)
    data = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    return f"event: {kind}\ndata: {data}\n\n"


def _mission_signature(mission: Optional[dict]) -> Optional[str]:
    if mission is None:
        return None
    return f"{mission.get('id')}|{mission.get('status')}|{mission.get('phase')}|{mission.get('completed_at')}"


async def event_stream() -> AsyncIterator[str]:
    """Yield SSE-formatted strings for the lifetime of the connection."""
    # Seed cursors at the current high-water marks so we only push *new* rows.
    last_transmission_id = await db.max_transmission_id()
    last_status_id = await db.max_status_update_id()
    last_mission_sig: Optional[str] = None

    # Emit an initial mission snapshot and a connected marker immediately.
    mission = await db.latest_mission()
    last_mission_sig = _mission_signature(mission)
    yield _sse("mission", {"mission": mission})
    yield _sse("connected", {"transmissionCursor": last_transmission_id})

    ticks = 0
    while True:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        ticks += 1
        emitted = False

        # New timeline transmissions.
        new_transmissions = await db.timeline_after(last_transmission_id)
        for row in new_transmissions:
            last_transmission_id = max(last_transmission_id, int(row["id"]))
            yield _sse("transmission", {"transmission": row})
            emitted = True

        # New status updates (fleet/intel streaming progress).
        new_status = await db.status_updates_after(last_status_id)
        for row in new_status:
            last_status_id = max(last_status_id, int(row["id"]))
            yield _sse("status-update", {"statusUpdate": row})
            emitted = True

        # Mission state changes.
        mission = await db.latest_mission()
        sig = _mission_signature(mission)
        if sig != last_mission_sig:
            last_mission_sig = sig
            yield _sse("mission", {"mission": mission})
            emitted = True

        # Periodic heartbeat comment so proxies keep the connection alive.
        if not emitted and ticks % HEARTBEAT_EVERY_TICKS == 0:
            yield ": keep-alive\n\n"
