"""Pydantic models for the Agent Registry Service.

Field names mirror the A2A wire contract (docs/protocol.md §3) exactly — they are
camelCase and normative. The registry is tolerant of unknown/extra fields so it
can store and re-serve any valid Agent Card verbatim.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class Provider(BaseModel):
    model_config = ConfigDict(extra="allow")

    organization: Optional[str] = None
    url: Optional[str] = None


class Capabilities(BaseModel):
    model_config = ConfigDict(extra="allow")

    streaming: bool = False
    pushNotifications: bool = False


class Skill(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: Optional[str] = None
    description: Optional[str] = None
    inputModes: list[str] = Field(default_factory=list)
    outputModes: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)


class SecurityScheme(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: Optional[str] = None
    in_: Optional[str] = Field(default=None, alias="in")
    name: Optional[str] = None


class AgentCard(BaseModel):
    """An A2A Agent Card (docs/protocol.md §3).

    Extra fields are allowed so the registry can faithfully round-trip any card.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    name: str
    description: Optional[str] = None
    provider: Optional[Provider] = None
    version: Optional[str] = None
    url: Optional[str] = None
    capabilities: Optional[Capabilities] = None
    defaultInputModes: list[str] = Field(default_factory=list)
    defaultOutputModes: list[str] = Field(default_factory=list)
    skills: list[Skill] = Field(default_factory=list)
    securitySchemes: dict[str, Any] = Field(default_factory=dict)
    security: list[Any] = Field(default_factory=list)


class AgentEntry(BaseModel):
    """A row in the registry's `GET /agents` listing (docs/protocol.md §12.7)."""

    model_config = ConfigDict(extra="allow")

    name: str
    language: Optional[str] = None
    base_url: Optional[str] = None
    health_status: str = "unknown"
    card: Optional[dict[str, Any]] = None


class AgentsResponse(BaseModel):
    agents: list[AgentEntry]


class CardsResponse(BaseModel):
    """Search result — a list of raw Agent Cards (docs/protocol.md §12.7)."""

    agents: list[dict[str, Any]]


class HealthResponse(BaseModel):
    status: str = "ok"


class ErrorBody(BaseModel):
    code: str
    message: str
    httpStatus: int
    correlationId: Optional[str] = None


class ErrorResponse(BaseModel):
    error: ErrorBody
