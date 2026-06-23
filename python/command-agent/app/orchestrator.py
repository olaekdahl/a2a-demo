"""Mission orchestration — "Operation Echo Shield" (§13).

Runs the full end-to-end sequence: create mission, discover agents in the
registry, scout (stream), analyze, logistics, relay, deploy (stream), and
complete. Every hop persists a messages row, a transmissions row, tasks,
task_status_updates, artifacts and audit_logs.

A single contextId ("operation-echo-shield") and a single mission-wide traceId
are used for the whole run; a fresh correlationId is generated per A2A request.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

from .a2a_client import A2AClient
from .logging_util import get_logger
from .mission import MissionStore
from .models import (
    AGENT_NAME,
    CONTEXT_ID,
    TASK_STATE_COMPLETED,
    artifact_payload,
    build_message,
    build_send_request,
    first_data_part,
    new_correlation_id,
    new_trace_id,
)

log = get_logger()

MISSION_NAME = "Operation Echo Shield"
MISSION_OBJECTIVE = (
    "The Empire is massing forces near Hoth. Assess the threat, determine troop "
    "movement, and deploy reinforcements to Echo Base."
)

# §17.3 — failure simulation is env-gated and OFF by default. When OFF, none of
# the resilience-demo code runs and the mission path is identical to today.
FAILURE_SIMULATION = os.environ.get("FAILURE_SIMULATION", "false").lower() == "true"

# Doomed recipient for the dead-letter demonstration (unreachable on purpose).
DEAD_LETTER_URL = "http://command-agent:9999"


class Orchestrator:
    def __init__(self, store: MissionStore, client: A2AClient) -> None:
        self.store = store
        self.client = client

    # ------------------------------------------------------------- helpers #
    def _headers(self, correlation_id: str, trace_id: str) -> Dict[str, str]:
        from .a2a_client import build_headers

        return build_headers(correlation_id, trace_id)

    async def _audit(self, trace_id: str, correlation_id: str, action: str, details: Any) -> None:
        await self.store.insert_audit(
            trace_id=trace_id,
            correlation_id=correlation_id,
            actor=AGENT_NAME,
            action=action,
            details_json=details,
        )

    async def _discover(
        self, skill_id: str, *, trace_id: str, label: str
    ) -> Dict[str, Any]:
        """Discover an agent card exposing `skill_id` via the registry."""
        correlation_id = new_correlation_id()
        log.info("orchestrator.discover", skill=skill_id, traceId=trace_id, correlationId=correlation_id)
        card = await self.client.find_agent_card_by_skill(skill_id)
        agent_name = card.get("name", "unknown")
        await self._audit(
            trace_id, correlation_id, "discover",
            {"skill": skill_id, "agent": agent_name, "url": card.get("url")},
        )
        await self.store.insert_transmission(
            context_id=CONTEXT_ID,
            task_id=None,
            sender=AGENT_NAME,
            recipient="agent-registry",
            label=label,
            message_type="discover",
            direction="outbound",
            status="ok",
            summary=f"Found {agent_name} for skill {skill_id}",
            message_ref=None,
        )
        return card

    def _persist_status_from_event(self, event: Dict[str, Any]) -> Tuple[str, str, str, str]:
        """Extract (task_id, state, phase, display) from a status-update event."""
        task_id = event.get("taskId", "")
        status = event.get("status") or {}
        state = status.get("state", "")
        metadata = status.get("metadata") or {}
        phase = metadata.get("phase", "")
        display = metadata.get("display", "")
        return task_id, state, phase, display

    async def _consume_stream(
        self,
        events: List[Dict[str, Any]],
        *,
        agent_name: str,
        skill_id: str,
    ) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
        """Persist every status-update + artifact-update from a stream.

        Returns (task_id, last_artifact_payload).
        """
        task_id: Optional[str] = None
        last_payload: Optional[Dict[str, Any]] = None

        for event in events:
            kind = event.get("kind")
            if kind == "task":
                task = event.get("task") or {}
                task_id = task.get("id")
                if task_id:
                    await self.store.upsert_task(
                        task_id=task_id,
                        context_id=CONTEXT_ID,
                        agent_name=agent_name,
                        skill_id=skill_id,
                        state=(task.get("status") or {}).get("state", ""),
                    )
            elif kind == "status-update":
                t_id, state, phase, display = self._persist_status_from_event(event)
                task_id = task_id or t_id
                await self.store.insert_status_update(
                    task_id=t_id or (task_id or ""),
                    context_id=CONTEXT_ID,
                    agent_name=agent_name,
                    state=state,
                    phase=phase,
                    message=display,
                    raw_json=event,
                )
                await self.store.upsert_task(
                    task_id=t_id or (task_id or ""),
                    context_id=CONTEXT_ID,
                    agent_name=agent_name,
                    skill_id=skill_id,
                    state=state,
                    completed_at=None,
                )
                await self.store.insert_transmission(
                    context_id=CONTEXT_ID,
                    task_id=t_id or task_id,
                    sender=agent_name,
                    recipient=AGENT_NAME,
                    label=display or phase,
                    message_type="status",
                    direction="inbound",
                    status=state,
                    summary=f"{phase}: {display}",
                    message_ref=None,
                )
            elif kind == "artifact-update":
                artifact = event.get("artifact") or {}
                t_id = event.get("taskId") or (task_id or "")
                payload = artifact_payload(artifact)
                last_payload = payload or last_payload
                parts = artifact.get("parts") or []
                media_type = (parts[0].get("mediaType") if parts else "application/json") or "application/json"
                await self.store.insert_artifact(
                    artifact_id=artifact.get("artifactId", ""),
                    task_id=t_id,
                    context_id=CONTEXT_ID,
                    agent_name=agent_name,
                    name=artifact.get("name", ""),
                    media_type=media_type,
                    artifact_json=artifact,
                )
                await self.store.insert_transmission(
                    context_id=CONTEXT_ID,
                    task_id=t_id,
                    sender=agent_name,
                    recipient=AGENT_NAME,
                    label=artifact.get("name", "artifact"),
                    message_type="artifact",
                    direction="inbound",
                    status="ok",
                    summary=artifact.get("description", "") or artifact.get("name", ""),
                    message_ref=None,
                )
        return task_id, last_payload

    async def _persist_completed_task(
        self,
        task: Dict[str, Any],
        *,
        agent_name: str,
        skill_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Persist a final completed Task (from /tasks/{id}) and its artifacts.

        Returns the first artifact payload found.
        """
        task_id = task.get("id", "")
        state = (task.get("status") or {}).get("state", "")
        await self.store.upsert_task(
            task_id=task_id,
            context_id=CONTEXT_ID,
            agent_name=agent_name,
            skill_id=skill_id,
            state=state,
            completed_at=(task.get("status") or {}).get("timestamp"),
        )
        payload: Optional[Dict[str, Any]] = None
        for artifact in task.get("artifacts") or []:
            ap = artifact_payload(artifact)
            if payload is None:
                payload = ap
            parts = artifact.get("parts") or []
            media_type = (parts[0].get("mediaType") if parts else "application/json") or "application/json"
            await self.store.insert_artifact(
                artifact_id=artifact.get("artifactId", ""),
                task_id=task_id,
                context_id=CONTEXT_ID,
                agent_name=agent_name,
                name=artifact.get("name", ""),
                media_type=media_type,
                artifact_json=artifact,
            )
        return payload

    async def _record_message(
        self,
        *,
        message: Dict[str, Any],
        recipient: str,
        request_body: Dict[str, Any],
        response_body: Any,
        correlation_id: str,
        trace_id: str,
        task_id: Optional[str],
    ) -> str:
        """Persist a messages row and return the message_id (for message_ref)."""
        message_id = message["messageId"]
        await self.store.insert_message(
            message_id=message_id,
            context_id=CONTEXT_ID,
            task_id=task_id,
            sender=AGENT_NAME,
            recipient=recipient,
            direction="outbound",
            request_json=request_body,
            response_json=response_body,
            headers_json=self._headers(correlation_id, trace_id),
        )
        return message_id

    # -------------------------------------------------------------- send #
    async def _call_send(
        self,
        *,
        card: Dict[str, Any],
        skill_id: str,
        text: str,
        data: Dict[str, Any],
        trace_id: str,
        label: str,
        summary: str,
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """POST /message:send to an agent; persist everything. Returns
        (artifact_payload, message_id)."""
        correlation_id = new_correlation_id()
        recipient = card.get("name", "unknown")
        base_url = card["url"]
        message = build_message(
            text=text,
            data=data,
            recipient=recipient,
            skill_id=skill_id,
            correlation_id=correlation_id,
            trace_id=trace_id,
        )
        request_body = build_send_request(message)
        log.info(
            "orchestrator.message_send",
            recipient=recipient, skill=skill_id,
            traceId=trace_id, correlationId=correlation_id,
        )
        response = await self.client.send_message(
            base_url, request_body, correlation_id=correlation_id, trace_id=trace_id
        )
        task = response.get("task") or {}
        task_id = task.get("id")
        message_id = await self._record_message(
            message=message,
            recipient=recipient,
            request_body=request_body,
            response_body=response,
            correlation_id=correlation_id,
            trace_id=trace_id,
            task_id=task_id,
        )
        payload = await self._persist_completed_task(task, agent_name=recipient, skill_id=skill_id)
        await self._audit(
            trace_id, correlation_id, "message:send",
            {"recipient": recipient, "skill": skill_id, "taskId": task_id},
        )
        await self.store.insert_transmission(
            context_id=CONTEXT_ID,
            task_id=task_id,
            sender=AGENT_NAME,
            recipient=recipient,
            label=label,
            message_type="message:send",
            direction="outbound",
            status="ok",
            summary=summary,
            message_ref=message_id,
        )
        return payload, message_id

    # ------------------------------------------------------------ stream #
    async def _call_stream(
        self,
        *,
        card: Dict[str, Any],
        skill_id: str,
        text: str,
        data: Dict[str, Any],
        trace_id: str,
        label: str,
        summary: str,
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """POST /message:stream, consume SSE, persist, then GET /tasks/{id}.
        Returns (artifact_payload, message_id)."""
        correlation_id = new_correlation_id()
        recipient = card.get("name", "unknown")
        base_url = card["url"]
        message = build_message(
            text=text,
            data=data,
            recipient=recipient,
            skill_id=skill_id,
            correlation_id=correlation_id,
            trace_id=trace_id,
        )
        request_body = build_send_request(message)
        log.info(
            "orchestrator.message_stream",
            recipient=recipient, skill=skill_id,
            traceId=trace_id, correlationId=correlation_id,
        )
        events = await self.client.stream_message(
            base_url, request_body, correlation_id=correlation_id, trace_id=trace_id
        )
        task_id, stream_payload = await self._consume_stream(
            events, agent_name=recipient, skill_id=skill_id
        )

        message_id = await self._record_message(
            message=message,
            recipient=recipient,
            request_body=request_body,
            response_body={"events": events},
            correlation_id=correlation_id,
            trace_id=trace_id,
            task_id=task_id,
        )
        await self.store.insert_transmission(
            context_id=CONTEXT_ID,
            task_id=task_id,
            sender=AGENT_NAME,
            recipient=recipient,
            label=label,
            message_type="message:stream",
            direction="outbound",
            status="ok",
            summary=summary,
            message_ref=message_id,
        )

        # Authoritative completed task via GET /tasks/{id}.
        final_payload = stream_payload
        if task_id:
            task = await self.client.get_task(
                base_url, task_id, correlation_id=correlation_id, trace_id=trace_id
            )
            tp = await self._persist_completed_task(task, agent_name=recipient, skill_id=skill_id)
            final_payload = tp or final_payload

        await self._audit(
            trace_id, correlation_id, "message:stream",
            {"recipient": recipient, "skill": skill_id, "taskId": task_id, "events": len(events)},
        )
        return final_payload, message_id

    # ================================================ resilience demo #
    async def _simulate_resilience(self, trace_id: str) -> None:
        """Failure-simulation demo (§17.3), only when FAILURE_SIMULATION=true.

        (a) Fires ONE transient-failing hop that recovers on attempt 2 against a
            real, reachable agent — the existing a2a_client backoff handles the
            recovery; an audit_logs "resilience.transient_recovered" row is written.
        (b) Fires ONE doomed hop to an unreachable URL that exhausts all retries;
            the failure is dead-lettered (dead_letters table) and surfaced as a
            transmissions row with status="dead-letter".
        """
        # (a) Transient failure that recovers against a healthy reachable agent.
        try:
            healthy_card = await self.client.find_agent_card_by_skill("scout_system")
            recipient = healthy_card.get("name", "unknown")
            base_url = healthy_card["url"]
            correlation_id = new_correlation_id()
            message = build_message(
                text="Resilience probe — transient failure that recovers.",
                data={"mission": CONTEXT_ID, "system": "Hoth", "skill": "scout_system"},
                recipient=recipient,
                skill_id="scout_system",
                correlation_id=correlation_id,
                trace_id=trace_id,
            )
            request_body = build_send_request(message)
            log.info(
                "resilience.transient_probe",
                recipient=recipient, traceId=trace_id, correlationId=correlation_id,
            )
            await self.client.send_message(
                base_url,
                request_body,
                correlation_id=correlation_id,
                trace_id=trace_id,
                simulate_transient=True,
            )
            await self._audit(
                trace_id, correlation_id, "resilience.transient_recovered",
                {
                    "recipient": recipient,
                    "skill": "scout_system",
                    "attempts": 2,
                    "note": "first attempt failed transiently; recovered on retry",
                },
            )
            await self.store.insert_transmission(
                context_id=CONTEXT_ID,
                task_id=None,
                sender=AGENT_NAME,
                recipient=recipient,
                label="Transient glitch recovered on retry",
                message_type="resilience",
                direction="outbound",
                status="recovered",
                summary="A2A hop failed once then recovered via exponential backoff",
                message_ref=None,
            )
        except Exception as exc:  # noqa: BLE001
            log.warn("resilience.transient_probe_failed", error=str(exc))

        # (b) Doomed hop to an unreachable URL — exhausts retries, dead-lettered.
        correlation_id = new_correlation_id()
        message = build_message(
            text="Resilience probe — doomed call to an unreachable archive.",
            data={"skill": "decode_holocron", "archive": "holocron-archive"},
            recipient="holocron-archive",
            skill_id="decode_holocron",
            correlation_id=correlation_id,
            trace_id=trace_id,
        )
        request_body = build_send_request(message)
        log.info(
            "resilience.doomed_probe",
            recipient="holocron-archive", traceId=trace_id, correlationId=correlation_id,
        )
        try:
            await self.client.send_message(
                DEAD_LETTER_URL,
                request_body,
                correlation_id=correlation_id,
                trace_id=trace_id,
            )
        except Exception as exc:  # noqa: BLE001 — expected; all retries exhausted.
            log.warn("resilience.doomed_dead_lettered", error=str(exc))
            await self.store.insert_dead_letter(
                context_id=CONTEXT_ID,
                correlation_id=correlation_id,
                trace_id=trace_id,
                sender=AGENT_NAME,
                recipient="holocron-archive",
                skill_id="decode_holocron",
                attempts=3,
                last_error=str(exc),
                request_json=request_body,
            )
            await self._audit(
                trace_id, correlation_id, "resilience.dead_lettered",
                {
                    "recipient": "holocron-archive",
                    "skill": "decode_holocron",
                    "attempts": 3,
                    "error": str(exc),
                },
            )
            await self.store.insert_transmission(
                context_id=CONTEXT_ID,
                task_id=None,
                sender=AGENT_NAME,
                recipient="holocron-archive",
                label="Holocron decode failed — dead-lettered",
                message_type="dead-letter",
                direction="outbound",
                status="dead-letter",
                summary="Doomed A2A hop exhausted all retries and was dead-lettered",
                message_ref=None,
            )

    # ============================================================== RUN #
    async def run(self) -> Dict[str, Any]:
        """Run the §13 sequence end-to-end. Returns a summary dict."""
        trace_id = new_trace_id()
        log.info("mission.start", contextId=CONTEXT_ID, traceId=trace_id)

        # Step 1 — create mission row.
        await self.store.create_mission(
            name=MISSION_NAME,
            objective=MISSION_OBJECTIVE,
            context_id=CONTEXT_ID,
            status="running",
            phase="created",
        )
        await self._audit(trace_id, new_correlation_id(), "mission_created", {"name": MISSION_NAME})
        await self.store.insert_transmission(
            context_id=CONTEXT_ID,
            task_id=None,
            sender=AGENT_NAME,
            recipient=AGENT_NAME,
            label="Operation Echo Shield begins",
            message_type="mission",
            direction="internal",
            status="running",
            summary=MISSION_OBJECTIVE,
            message_ref=None,
        )

        # §17.3 — optional resilience demo (transient-recovery + dead-letter),
        # env-gated and OFF by default. Runs before the real §13 sequence; with
        # FAILURE_SIMULATION=false nothing here executes (path identical to today).
        if FAILURE_SIMULATION:
            log.info("resilience.simulation_enabled", traceId=trace_id)
            await self._simulate_resilience(trace_id)

        # Prime the registry once (it may still be warming up).
        try:
            await self.client.registry_refresh()
        except Exception as exc:  # noqa: BLE001
            log.warn("registry.refresh_failed", error=str(exc))

        # Step 2-3 — discover + fetch intelligence agent card.
        await self.store.update_mission_phase(CONTEXT_ID, "scouting")
        intel_card = await self._discover(
            "scout_system", trace_id=trace_id, label="Find scout_system capability"
        )
        # Step 3 — fetch the card directly from the agent (§13.3).
        corr = new_correlation_id()
        intel_card = await self.client.fetch_agent_card(
            intel_card["url"], correlation_id=corr, trace_id=trace_id
        )

        # Step 4 — scout (stream). _call_stream returns (artifact_payload, message_id).
        intel_payload, _ = await self._call_stream(
            card=intel_card,
            skill_id="scout_system",
            text="Scout the Hoth system for Imperial movement.",
            data={"mission": CONTEXT_ID, "system": "Hoth", "skill": "scout_system"},
            trace_id=trace_id,
            label="Scout Hoth for Imperial movement",
            summary="Imperial armor detected near Echo Base",
        )
        intel_payload = intel_payload or {}

        # Step 5-6 — discover tactical + analyze.
        await self.store.update_mission_phase(CONTEXT_ID, "analyzing")
        tactical_card = await self._discover(
            "calculate_risk", trace_id=trace_id, label="Find calculate_risk capability"
        )
        tactical_payload, _ = await self._call_send(
            card=tactical_card,
            skill_id="calculate_risk",
            text="Calculate the tactical risk for the Hoth system.",
            data={"intelligence": intel_payload, "skill": "calculate_risk"},
            trace_id=trace_id,
            label="Threat level assessment",
            summary="Threat level HIGH",
        )
        tactical_payload = tactical_payload or {}

        # Step 7-8 — discover logistics + assess.
        await self.store.update_mission_phase(CONTEXT_ID, "logistics")
        logistics_card = await self._discover(
            "assess_transport_capacity", trace_id=trace_id,
            label="Find assess_transport_capacity capability",
        )
        logistics_payload, _ = await self._call_send(
            card=logistics_card,
            skill_id="assess_transport_capacity",
            text="Assess transport capacity for the Hoth evacuation and reinforcement.",
            data={"system": "Hoth", "tactical": tactical_payload, "skill": "assess_transport_capacity"},
            trace_id=trace_id,
            label="Transport capacity check",
            summary="14 transports available, fuel at 82%",
        )
        logistics_payload = logistics_payload or {}

        # Step 9-10 — discover relay + secure transmission.
        await self.store.update_mission_phase(CONTEXT_ID, "relaying")
        relay_card = await self._discover(
            "relay_transmission", trace_id=trace_id, label="Find relay_transmission capability"
        )
        await self._call_send(
            card=relay_card,
            skill_id="relay_transmission",
            text="Relay the secured tactical and logistics transmission.",
            data={
                "tactical": tactical_payload,
                "logistics": logistics_payload,
                "skill": "relay_transmission",
            },
            trace_id=trace_id,
            label="Secure transmission",
            summary="Transmission secured over Fulcrum channel",
        )

        # Step 11-12 — discover fleet + deploy (stream).
        await self.store.update_mission_phase(CONTEXT_ID, "deploying")
        fleet_card = await self._discover(
            "reinforce_planet", trace_id=trace_id, label="Find reinforce_planet capability"
        )
        troops = logistics_payload.get("recommended_troop_movement") or {}
        deployment_payload, _ = await self._call_stream(
            card=fleet_card,
            skill_id="reinforce_planet",
            text="Deploy reinforcements to Hoth and reinforce Echo Base.",
            data={"destination": "Hoth", "troops": troops, "skill": "reinforce_planet"},
            trace_id=trace_id,
            label="Deploy reinforcements to Hoth",
            summary="Reinforcements deployed",
        )
        deployment_payload = deployment_payload or {}

        # Step 13 — complete mission.
        final_summary = "Operation Echo Shield completed. Reinforcements deployed to Hoth."
        await self.store.complete_mission(
            CONTEXT_ID, status="completed", phase="completed", final_summary=final_summary
        )
        await self._audit(trace_id, new_correlation_id(), "mission_completed", {"summary": final_summary})
        await self.store.insert_transmission(
            context_id=CONTEXT_ID,
            task_id=None,
            sender=AGENT_NAME,
            recipient=AGENT_NAME,
            label="Reinforcements deployed",
            message_type="mission",
            direction="internal",
            status="completed",
            summary=final_summary,
            message_ref=None,
        )
        log.info("mission.complete", contextId=CONTEXT_ID, traceId=trace_id)

        return {
            "mission": MISSION_NAME,
            "contextId": CONTEXT_ID,
            "traceId": trace_id,
            "status": "completed",
            "final_summary": final_summary,
            "intelligence": intel_payload,
            "tactical": tactical_payload,
            "logistics": logistics_payload,
            "deployment": deployment_payload,
        }
