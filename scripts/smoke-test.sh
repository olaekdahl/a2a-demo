#!/usr/bin/env bash
#
# smoke-test.sh — 10 cross-language interoperability checks for Operation Echo
# Shield. Each check hits a real service on its host port, parses the JSON (or
# SSE) response with python3, and asserts the wire contract from docs/protocol.md.
#
# Prints PASS/FAIL with a number for each check and a summary at the end.
# Exits non-zero if any check failed.
#
set -euo pipefail

# Pick up host-port overrides from the repo .env (if present) so the script
# targets the same published ports docker compose used. Safe to skip on a clean
# machine (the documented defaults below apply).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
# shellcheck disable=SC1090
[[ -f "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

HOST="${A2A_HOST:-localhost}"
DEMO_TOKEN="${A2A_DEMO_TOKEN:-resistance-demo-token}"

REGISTRY="http://${HOST}:${REGISTRY_HOST_PORT:-8000}"
COMMAND="http://${HOST}:${COMMAND_HOST_PORT:-8001}"
DASHBOARD="http://${HOST}:${DASHBOARD_HOST_PORT:-8080}"
INTEL="http://${HOST}:${INTEL_HOST_PORT:-8011}"
RELAY="http://${HOST}:${RELAY_HOST_PORT:-8012}"
TACTICAL="http://${HOST}:${TACTICAL_HOST_PORT:-8021}"
LOGISTICS="http://${HOST}:${LOGISTICS_HOST_PORT:-8022}"
FLEET="http://${HOST}:${FLEET_HOST_PORT:-8023}"

PASS_COUNT=0
FAIL_COUNT=0
declare -a RESULTS=()

# Common A2A headers for inter-agent requests.
HDR=(
	-H "X-Demo-Token: ${DEMO_TOKEN}"
	-H "A2A-Version: 1.0"
	-H "Content-Type: application/json"
	-H "Accept: application/json, text/event-stream"
)

# pass <n> <description>
pass() {
	PASS_COUNT=$((PASS_COUNT + 1))
	printf '  [PASS] %2d. %s\n' "$1" "$2"
	RESULTS+=("PASS ${1}")
}

# fail <n> <description> [detail]
fail() {
	FAIL_COUNT=$((FAIL_COUNT + 1))
	printf '  [FAIL] %2d. %s\n' "$1" "$2"
	if [[ -n "${3:-}" ]]; then
		printf '         -> %s\n' "$3"
	fi
	RESULTS+=("FAIL ${1}")
}

# A reusable scout-request SendMessageRequest body for the intelligence agent.
INTEL_BODY='{
  "message": {
    "messageId": "msg-smoke-intel",
    "contextId": "operation-echo-shield",
    "role": "ROLE_USER",
    "parts": [
      { "text": "Scout the Hoth system for Imperial movement.", "mediaType": "text/plain" },
      { "data": { "mission": "operation-echo-shield", "system": "Hoth", "skill": "scout_system" }, "mediaType": "application/json" }
    ],
    "metadata": {
      "sender": "smoke-test",
      "recipient": "intelligence-agent",
      "skillId": "scout_system"
    }
  },
  "configuration": { "acceptedOutputModes": ["application/json", "text/plain"] }
}'

# Tactical analyze request: intelligence-report payload under "intelligence".
TACTICAL_BODY='{
  "message": {
    "messageId": "msg-smoke-tactical",
    "contextId": "operation-echo-shield",
    "role": "ROLE_USER",
    "parts": [
      { "text": "Analyze the Imperial threat at Hoth.", "mediaType": "text/plain" },
      { "data": {
          "intelligence": {
            "system": "Hoth",
            "empire_presence": true,
            "confidence": 0.94,
            "detected_units": {
              "stormtroopers": 1800, "at_at_walkers": 12, "at_st_walkers": 28,
              "star_destroyers": 3, "probe_droids": 9
            },
            "transmission": "Imperial armor columns detected beyond the northern ridge."
          },
          "skill": "calculate_risk"
        }, "mediaType": "application/json" }
    ],
    "metadata": {
      "sender": "smoke-test",
      "recipient": "tactical-agent",
      "skillId": "calculate_risk"
    }
  },
  "configuration": { "acceptedOutputModes": ["application/json"] }
}'

# Fleet stream request: reinforce Hoth with troops.
FLEET_BODY='{
  "message": {
    "messageId": "msg-smoke-fleet",
    "contextId": "operation-echo-shield",
    "role": "ROLE_USER",
    "parts": [
      { "text": "Deploy reinforcements to Hoth.", "mediaType": "text/plain" },
      { "data": {
          "destination": "Hoth",
          "troops": { "reinforce_echo_base": 1200, "evacuate_civilians": 700, "reserve_defensive_units": 300 },
          "skill": "reinforce_planet"
        }, "mediaType": "application/json" }
    ],
    "metadata": {
      "sender": "smoke-test",
      "recipient": "fleet-agent",
      "skillId": "reinforce_planet"
    }
  },
  "configuration": { "acceptedOutputModes": ["application/json"] }
}'

echo "==> Operation Echo Shield — interop smoke test (host: ${HOST})"
echo ""

# The mission no longer auto-runs on startup (AUTOSTART_MISSION defaults false so
# the dashboard opens nominal). Dispatch it here so checks 9 + 10 have a completed
# mission to verify. /mission:start runs synchronously and returns when complete.
echo "==> Dispatching the mission (POST ${COMMAND}/mission:start) ..."
curl -sS --max-time 120 -X POST "${COMMAND}/mission:start" "${HDR[@]}" -d '{}' >/dev/null 2>&1 || true
echo ""

# ---------------------------------------------------------------------------
# 1. TypeScript intelligence-agent card — assert name.
# ---------------------------------------------------------------------------
N=1
if BODY="$(curl -sS --max-time 10 "${INTEL}/.well-known/agent-card.json" 2>/dev/null)"; then
	if echo "${BODY}" | python3 -c '
import json,sys
c=json.load(sys.stdin)
assert c["name"]=="intelligence-agent", "name=%r"%c.get("name")
' >/dev/null 2>&1; then
		pass $N "TS intelligence-agent card has name=intelligence-agent"
	else
		fail $N "TS intelligence-agent card name mismatch" "${BODY:0:200}"
	fi
else
	fail $N "could not fetch TS intelligence-agent card"
fi

# ---------------------------------------------------------------------------
# 2. Go tactical-agent card — assert name.
# ---------------------------------------------------------------------------
N=2
if BODY="$(curl -sS --max-time 10 "${TACTICAL}/.well-known/agent-card.json" 2>/dev/null)"; then
	if echo "${BODY}" | python3 -c '
import json,sys
c=json.load(sys.stdin)
assert c["name"]=="tactical-agent", "name=%r"%c.get("name")
' >/dev/null 2>&1; then
		pass $N "Go tactical-agent card has name=tactical-agent"
	else
		fail $N "Go tactical-agent card name mismatch" "${BODY:0:200}"
	fi
else
	fail $N "could not fetch Go tactical-agent card"
fi

# ---------------------------------------------------------------------------
# 3. POST intel /message:send — task COMPLETED + intelligence-report artifact.
# ---------------------------------------------------------------------------
N=3
INTEL_RESP=""
if INTEL_RESP="$(curl -sS --max-time 20 -X POST "${INTEL}/message:send" "${HDR[@]}" -d "${INTEL_BODY}" 2>/dev/null)"; then
	if echo "${INTEL_RESP}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=r["task"]
assert t["status"]["state"]=="TASK_STATE_COMPLETED", "state=%r"%t["status"]["state"]
arts=t.get("artifacts") or []
names=[a.get("name") for a in arts]
assert "intelligence-report" in names, "artifacts=%r"%names
' >/dev/null 2>&1; then
		pass $N "intel /message:send -> COMPLETED with intelligence-report artifact"
	else
		fail $N "intel /message:send response invalid" "${INTEL_RESP:0:200}"
	fi
else
	fail $N "intel /message:send request failed"
fi

# ---------------------------------------------------------------------------
# 4. POST tactical /message:send — tactical-assessment with threat_level HIGH.
# ---------------------------------------------------------------------------
N=4
TACTICAL_RESP=""
if TACTICAL_RESP="$(curl -sS --max-time 20 -X POST "${TACTICAL}/message:send" "${HDR[@]}" -d "${TACTICAL_BODY}" 2>/dev/null)"; then
	if echo "${TACTICAL_RESP}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=r["task"]
arts=t.get("artifacts") or []
ta=[a for a in arts if a.get("name")=="tactical-assessment"]
assert ta, "no tactical-assessment artifact: %r"%[a.get("name") for a in arts]
data=ta[0]["parts"][0]["data"]
assert data["threat_level"]=="HIGH", "threat_level=%r"%data.get("threat_level")
' >/dev/null 2>&1; then
		pass $N "tactical /message:send -> tactical-assessment threat_level=HIGH"
	else
		fail $N "tactical /message:send response invalid" "${TACTICAL_RESP:0:200}"
	fi
else
	fail $N "tactical /message:send request failed"
fi

# ---------------------------------------------------------------------------
# 5. TS task object shape: id, contextId, status.state, artifacts.
# ---------------------------------------------------------------------------
N=5
if [[ -n "${INTEL_RESP}" ]] && echo "${INTEL_RESP}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=r["task"]
assert isinstance(t["id"], str) and t["id"], "id"
assert isinstance(t["contextId"], str) and t["contextId"], "contextId"
assert isinstance(t["status"]["state"], str), "status.state"
assert isinstance(t["artifacts"], list), "artifacts"
' >/dev/null 2>&1; then
	pass $N "TS task object shape ok (id, contextId, status.state, artifacts)"
else
	fail $N "TS task object shape invalid" "${INTEL_RESP:0:200}"
fi

# ---------------------------------------------------------------------------
# 6. Go task object shape.
# ---------------------------------------------------------------------------
N=6
if [[ -n "${TACTICAL_RESP}" ]] && echo "${TACTICAL_RESP}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
t=r["task"]
assert isinstance(t["id"], str) and t["id"], "id"
assert isinstance(t["contextId"], str) and t["contextId"], "contextId"
assert isinstance(t["status"]["state"], str), "status.state"
assert isinstance(t["artifacts"], list), "artifacts"
' >/dev/null 2>&1; then
	pass $N "Go task object shape ok (id, contextId, status.state, artifacts)"
else
	fail $N "Go task object shape invalid" "${TACTICAL_RESP:0:200}"
fi

# ---------------------------------------------------------------------------
# 7. POST fleet /message:stream — SSE has COMPLETED + a jump_to_lightspeed phase.
# ---------------------------------------------------------------------------
N=7
FLEET_SSE=""
if FLEET_SSE="$(curl -sS --max-time 30 -N -X POST "${FLEET}/message:stream" "${HDR[@]}" -d "${FLEET_BODY}" 2>/dev/null)"; then
	if printf '%s' "${FLEET_SSE}" | python3 -c '
import json,sys
raw=sys.stdin.read()
saw_completed=False
saw_jump=False
for line in raw.splitlines():
    line=line.strip()
    if not line.startswith("data:"):
        continue
    payload=line[len("data:"):].strip()
    if not payload:
        continue
    try:
        ev=json.loads(payload)
    except Exception:
        continue
    if "TASK_STATE_COMPLETED" in json.dumps(ev):
        saw_completed=True
    md=(ev.get("status") or {}).get("metadata") or {}
    if md.get("phase")=="jump_to_lightspeed":
        saw_jump=True
assert saw_completed, "no TASK_STATE_COMPLETED in stream"
assert saw_jump, "no jump_to_lightspeed phase in stream"
' >/dev/null 2>&1; then
		pass $N "fleet /message:stream SSE has COMPLETED + jump_to_lightspeed phase"
	else
		fail $N "fleet SSE missing COMPLETED or jump_to_lightspeed" "${FLEET_SSE:0:200}"
	fi
else
	fail $N "fleet /message:stream request failed"
fi

# ---------------------------------------------------------------------------
# 8. Registry search?skill=scout_system returns intelligence-agent.
# ---------------------------------------------------------------------------
N=8
if BODY="$(curl -sS --max-time 10 "${HDR[@]}" "${REGISTRY}/agents/search?skill=scout_system" 2>/dev/null)"; then
	if echo "${BODY}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
agents=r.get("agents") or []
names=[a.get("name") for a in agents]
assert "intelligence-agent" in names, "names=%r"%names
' >/dev/null 2>&1; then
		pass $N "registry search skill=scout_system returns intelligence-agent"
	else
		fail $N "registry search did not return intelligence-agent" "${BODY:0:200}"
	fi
else
	fail $N "registry search request failed"
fi

# ---------------------------------------------------------------------------
# 9. Mission shows completed (poll the dashboard up to ~60s).
# ---------------------------------------------------------------------------
N=9
MISSION_OK=0
for _ in $(seq 1 30); do
	BODY="$(curl -sS --max-time 5 "${DASHBOARD}/api/mission" 2>/dev/null || true)"
	if [[ -n "${BODY}" ]] && echo "${BODY}" | python3 -c '
import json,sys
m=json.load(sys.stdin)
if isinstance(m, dict) and m.get("mission"):
    m=m["mission"]
status=str(m.get("status","")).lower()
phase=str(m.get("phase","")).lower()
assert status=="completed" or phase=="completed", "status=%r phase=%r"%(status,phase)
' >/dev/null 2>&1; then
		MISSION_OK=1
		break
	fi
	sleep 2
done
if [[ "${MISSION_OK}" -eq 1 ]]; then
	pass $N "dashboard /api/mission shows mission completed"
else
	fail $N "mission did not reach completed within ~60s"
fi

# ---------------------------------------------------------------------------
# 10. Dashboard /api/timeline returns persisted (non-empty) events.
# ---------------------------------------------------------------------------
N=10
if BODY="$(curl -sS --max-time 10 "${DASHBOARD}/api/timeline" 2>/dev/null)"; then
	if echo "${BODY}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
events=r
if isinstance(r, dict):
    for k in ("transmissions","events","timeline"):
        if k in r:
            events=r[k]; break
assert isinstance(events, list), "not a list: %r"%type(events)
assert len(events) > 0, "timeline is empty"
' >/dev/null 2>&1; then
		pass $N "dashboard /api/timeline returns persisted events (non-empty)"
	else
		fail $N "dashboard /api/timeline empty or invalid" "${BODY:0:200}"
	fi
else
	fail $N "dashboard /api/timeline request failed"
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo ""
echo "==> Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed (of $((PASS_COUNT + FAIL_COUNT)) checks)."
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
	echo "    Failed checks:"
	for r in "${RESULTS[@]}"; do
		if [[ "${r}" == FAIL* ]]; then
			echo "      - check ${r#FAIL }"
		fi
	done
	exit 1
fi
echo "    All interop checks passed. May the Force be with you."
