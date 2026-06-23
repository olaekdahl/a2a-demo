"""Pydantic A2A models and helpers to build Messages / Parts / Tasks.

Field names, casing and enum values follow the normative wire contract in
docs/protocol.md (sections 4-9). These shapes are shared by the orchestrator,
the a2a_client and the FastAPI app.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
CONTEXT_ID = "operation-echo-shield"
AGENT_NAME = "resistance-command-agent"
AGENT_LANGUAGE = "python"

# TaskState enum (string values, normative — see §6).
TASK_STATE_SUBMITTED = "TASK_STATE_SUBMITTED"
TASK_STATE_WORKING = "TASK_STATE_WORKING"
TASK_STATE_INPUT_REQUIRED = "TASK_STATE_INPUT_REQUIRED"
TASK_STATE_AUTH_REQUIRED = "TASK_STATE_AUTH_REQUIRED"
TASK_STATE_COMPLETED = "TASK_STATE_COMPLETED"
TASK_STATE_FAILED = "TASK_STATE_FAILED"
TASK_STATE_CANCELED = "TASK_STATE_CANCELED"
TASK_STATE_REJECTED = "TASK_STATE_REJECTED"

ROLE_USER = "ROLE_USER"
ROLE_AGENT = "ROLE_AGENT"

# Error codes (§11).
ERR_AUTH_REQUIRED = "AUTH_REQUIRED"
ERR_BAD_REQUEST = "BAD_REQUEST"
ERR_TASK_NOT_FOUND = "TASK_NOT_FOUND"
ERR_TASK_NOT_CANCELABLE = "TASK_NOT_CANCELABLE"
ERR_SKILL_NOT_FOUND = "SKILL_NOT_FOUND"
ERR_AGENT_NOT_FOUND = "AGENT_NOT_FOUND"
ERR_INTERNAL = "INTERNAL"
# §17.2 — protocol version mismatch on an authenticated A2A request.
ERR_VERSION_NOT_SUPPORTED = "VERSION_NOT_SUPPORTED"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def now_iso() -> str:
    """ISO-8601 UTC timestamp with milliseconds and a trailing Z."""
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def new_message_id() -> str:
    return f"msg-{uuid.uuid4()}"


def new_correlation_id() -> str:
    return f"corr-{uuid.uuid4()}"


def new_trace_id() -> str:
    return f"trace-{uuid.uuid4()}"


def new_task_id() -> str:
    return f"task-{uuid.uuid4()}"


def new_artifact_id() -> str:
    return f"art-{uuid.uuid4()}"


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class Part(BaseModel):
    """A Part holds EITHER text OR data; mediaType is always present (§4)."""
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    text: Optional[str] = None
    data: Optional[Dict[str, Any]] = None
    mediaType: str = "text/plain"


class Message(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    messageId: str = Field(default_factory=new_message_id)
    contextId: str = CONTEXT_ID
    role: str = ROLE_USER
    parts: List[Part] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Configuration(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    acceptedOutputModes: List[str] = Field(
        default_factory=lambda: ["application/json", "text/plain"]
    )


class SendMessageRequest(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    message: Message
    configuration: Configuration = Field(default_factory=Configuration)


class TaskStatus(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    state: str = TASK_STATE_SUBMITTED
    timestamp: str = Field(default_factory=now_iso)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Artifact(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    artifactId: str = Field(default_factory=new_artifact_id)
    name: str = ""
    description: str = ""
    parts: List[Part] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Task(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str = Field(default_factory=new_task_id)
    contextId: str = CONTEXT_ID
    status: TaskStatus = Field(default_factory=TaskStatus)
    history: List[Message] = Field(default_factory=list)
    artifacts: List[Artifact] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
def text_part(text: str, media_type: str = "text/plain") -> Dict[str, Any]:
    return {"text": text, "mediaType": media_type}


def data_part(data: Dict[str, Any], media_type: str = "application/json") -> Dict[str, Any]:
    return {"data": data, "mediaType": media_type}


def build_message(
    *,
    text: str,
    data: Optional[Dict[str, Any]],
    recipient: str,
    skill_id: str,
    correlation_id: str,
    trace_id: str,
    role: str = ROLE_USER,
    sender: str = AGENT_NAME,
    context_id: str = CONTEXT_ID,
    message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a §4 Message dict ready to embed in a SendMessageRequest."""
    parts: List[Dict[str, Any]] = []
    if text is not None:
        parts.append(text_part(text))
    if data is not None:
        parts.append(data_part(data))
    return {
        "messageId": message_id or new_message_id(),
        "contextId": context_id,
        "role": role,
        "parts": parts,
        "metadata": {
            "sender": sender,
            "recipient": recipient,
            "correlationId": correlation_id,
            "traceId": trace_id,
            "skillId": skill_id,
        },
    }


def build_send_request(message: Dict[str, Any]) -> Dict[str, Any]:
    """Wrap a Message into a §5 SendMessageRequest."""
    return {
        "message": message,
        "configuration": {"acceptedOutputModes": ["application/json", "text/plain"]},
    }


def error_body(code: str, message: str, http_status: int, correlation_id: Optional[str]) -> Dict[str, Any]:
    """The standard §11 error body."""
    return {
        "error": {
            "code": code,
            "message": message,
            "httpStatus": http_status,
            "correlationId": correlation_id,
        }
    }


def first_data_part(parts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return the first part that carries a `data` payload, if any."""
    for p in parts or []:
        if isinstance(p, dict) and p.get("data") is not None:
            return p["data"]
    return None


def artifact_payload(artifact: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Extract parts[0].data from an artifact dict."""
    if not artifact:
        return None
    parts = artifact.get("parts") or []
    return first_data_part(parts)
