#!/usr/bin/env bash
#
# validate-schemas.sh — ask the Dashboard to validate every shared/examples/*.json
# against its JSON Schema and every live agent card against agent-card.schema.json
# (see docs/protocol.md §17.4). Prints each result name + valid/invalid and exits
# non-zero if allValid is false.
#
set -euo pipefail

# Pick up host-port overrides from the repo .env (if present).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
# shellcheck disable=SC1090
[[ -f "${ENV_FILE}" ]] && { set -a; . "${ENV_FILE}"; set +a; }

HOST="${A2A_HOST:-localhost}"
DASHBOARD="http://${HOST}:${DASHBOARD_HOST_PORT:-8080}"

echo "==> Schema validation at ${DASHBOARD}/api/schema-validation"
echo ""

BODY="$(curl -sS --max-time 20 "${DASHBOARD}/api/schema-validation" 2>/dev/null || true)"

if [[ -z "${BODY}" ]]; then
	echo "!!! No response from ${DASHBOARD}/api/schema-validation (is the stack up?)." >&2
	exit 1
fi

echo "${BODY}" | python3 -c '
import json,sys
try:
    r=json.load(sys.stdin)
except Exception as e:
    print("    invalid JSON response: %s" % e, file=sys.stderr)
    sys.exit(1)

results=r.get("results") or []
for res in results:
    name=res.get("name","<unknown>")
    schema=res.get("schema","")
    valid=bool(res.get("valid"))
    mark="valid" if valid else "invalid"
    tag="PASS" if valid else "FAIL"
    print("  [%s] %-40s %-28s %s" % (tag, name, "("+schema+")" if schema else "", mark))
    if not valid:
        for err in (res.get("errors") or []):
            print("         -> %s" % err)

all_valid=bool(r.get("allValid"))
print("")
print("==> %d result(s); allValid=%s" % (len(results), str(all_valid).lower()))
sys.exit(0 if all_valid else 1)
'
