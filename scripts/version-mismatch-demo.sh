#!/usr/bin/env bash
#
# version-mismatch-demo.sh — demonstrate A2A protocol version negotiation on the
# Python command agent (see docs/protocol.md §17.2). An authenticated A2A request
# whose `A2A-Version` major component differs from 1 (e.g. 9.9) is rejected with
# HTTP 400 and error code VERSION_NOT_SUPPORTED; a matching version (1.0) passes.
#
# Prints PASS/FAIL for each assertion and exits non-zero if any check fails.
#
set -euo pipefail

# Pick up host-port overrides from the repo .env (if present).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
# shellcheck disable=SC1090
[[ -f "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

HOST="${A2A_HOST:-localhost}"
DEMO_TOKEN="${A2A_DEMO_TOKEN:-resistance-demo-token}"
COMMAND="http://${HOST}:${COMMAND_HOST_PORT:-8001}"

PASS_COUNT=0
FAIL_COUNT=0

# pass <description>
pass() {
	PASS_COUNT=$((PASS_COUNT + 1))
	printf '  [PASS] %s\n' "$1"
}

# fail <description> [detail]
fail() {
	FAIL_COUNT=$((FAIL_COUNT + 1))
	printf '  [FAIL] %s\n' "$1"
	if [[ -n "${2:-}" ]]; then
		printf '         -> %s\n' "$2"
	fi
}

echo "==> A2A protocol version-mismatch demo at ${COMMAND}/tasks (host: ${HOST})"
echo ""

# ---------------------------------------------------------------------------
# 1. Unsupported version 9.9 -> HTTP 400 + code VERSION_NOT_SUPPORTED.
# ---------------------------------------------------------------------------
BODY_FILE="/tmp/version-mismatch-bad.$$"
# GET /tasks is a real authenticated A2A endpoint; the version guard runs inside
# its handler (a wrong HTTP method would 405 before the guard is reached).
BAD_STATUS="$(curl -sS -o "${BODY_FILE}" -w '%{http_code}' --max-time 10 \
	"${COMMAND}/tasks" \
	-H "A2A-Version: 9.9" \
	-H "X-Demo-Token: ${DEMO_TOKEN}" 2>/dev/null || echo "000")"
BAD_BODY="$(cat "${BODY_FILE}" 2>/dev/null || true)"
rm -f "${BODY_FILE}"

if [[ "${BAD_STATUS}" == "400" ]]; then
	pass "A2A-Version: 9.9 -> HTTP 400"
else
	fail "A2A-Version: 9.9 should return HTTP 400" "got HTTP ${BAD_STATUS}: ${BAD_BODY:0:200}"
fi

if [[ -n "${BAD_BODY}" ]] && echo "${BAD_BODY}" | python3 -c '
import json,sys
r=json.load(sys.stdin)
code=(r.get("error") or {}).get("code")
assert code=="VERSION_NOT_SUPPORTED", "code=%r"%code
' >/dev/null 2>&1; then
	pass "A2A-Version: 9.9 -> error code VERSION_NOT_SUPPORTED"
else
	fail "A2A-Version: 9.9 should return code VERSION_NOT_SUPPORTED" "${BAD_BODY:0:200}"
fi

# ---------------------------------------------------------------------------
# 2. Supported version 1.0 -> NOT HTTP 400 (version check passes).
# ---------------------------------------------------------------------------
GOOD_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
	"${COMMAND}/tasks" \
	-H "A2A-Version: 1.0" \
	-H "X-Demo-Token: ${DEMO_TOKEN}" 2>/dev/null || echo "000")"

if [[ "${GOOD_STATUS}" != "400" ]]; then
	pass "A2A-Version: 1.0 -> NOT HTTP 400 (got HTTP ${GOOD_STATUS})"
else
	fail "A2A-Version: 1.0 should NOT return HTTP 400" "got HTTP ${GOOD_STATUS}"
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo ""
echo "==> Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed (of $((PASS_COUNT + FAIL_COUNT)) checks)."
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
	exit 1
fi
echo "    Protocol version negotiation verified. May the Force be with you."
