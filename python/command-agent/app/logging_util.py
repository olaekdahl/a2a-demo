"""Structured JSON logging (§16).

Each log line is a single-line JSON object including timestamp, service,
language, level, event and any provided context (correlationId, traceId,
contextId, taskId, sender, recipient, ...).
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any

SERVICE = "resistance-command-agent"
LANGUAGE = "python"


def _ts() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


class StructuredLogger:
    def _emit(self, level: str, event: str, **fields: Any) -> None:
        record = {
            "timestamp": _ts(),
            "service": SERVICE,
            "language": LANGUAGE,
            "level": level,
            "event": event,
        }
        for key, value in fields.items():
            if value is not None:
                record[key] = value
        sys.stdout.write(json.dumps(record, default=str) + "\n")
        sys.stdout.flush()

    def info(self, event: str, **fields: Any) -> None:
        self._emit("info", event, **fields)

    def warn(self, event: str, **fields: Any) -> None:
        self._emit("warn", event, **fields)

    def error(self, event: str, **fields: Any) -> None:
        self._emit("error", event, **fields)

    def debug(self, event: str, **fields: Any) -> None:
        self._emit("debug", event, **fields)


_LOGGER = StructuredLogger()


def get_logger() -> StructuredLogger:
    return _LOGGER
