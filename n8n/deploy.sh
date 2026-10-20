#!/usr/bin/env bash
# Regenerate, import, publish and reload Board Game Garage workflows on the Hostinger n8n.
# Usage: ./deploy.sh [workflowFile ...]   e.g. ./deploy.sh iconOne bggOne   (default: all)
set -euo pipefail
cd "$(dirname "$0")"

AIRTABLE_CRED=DjPIwMJ1Lmar6CuJ
BGG_CRED=rZyqHvE3jW7FFkmj
BGG_USERNAME="daddo_78"   # BGG account whose plays (posted by BG Stats) are synced
SSH="ssh -i $HOME/.ssh/claude_hostinger claude-ops@148.230.83.130"
CONTAINER=n8n-ckq4-n8n-1

node gen.js "$AIRTABLE_CRED" "$BGG_CRED" "${BGG_USERNAME:-}" >/dev/null
if [ $# -eq 0 ]; then files=(workflows/*.json); else files=(); for n in "$@"; do files+=("workflows/$n.json"); done; fi

STAGE=/tmp/bgv-$(date +%s)
$SSH "mkdir -p $STAGE"
scp -q -i "$HOME/.ssh/claude_hostinger" "${files[@]}" claude-ops@148.230.83.130:$STAGE/
$SSH "docker cp $STAGE $CONTAINER:$STAGE && docker exec $CONTAINER n8n import:workflow --separate --input=$STAGE 2>&1 | grep -i import; rm -rf $STAGE"

# Publish everything with a webhook or schedule (batch runners are manual-only)
for f in "${files[@]}"; do
  if grep -qE '"n8n-nodes-base.(webhook|scheduleTrigger)"' "$f"; then
    id=$(grep -m1 -oE '"id": "BGVault[A-Za-z0-9]+"' "$f" | cut -d'"' -f4)
    $SSH "docker exec $CONTAINER n8n publish:workflow --id=$id >/dev/null 2>&1" && echo "published $id"
  fi
done

$SSH "docker restart $CONTAINER >/dev/null"
for i in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' https://n8n.ondorilabo.com/webhook/vault/collection || true)
  # The collection is members-only, so a 401 ("sign in first") also means n8n is up and answering
  { [ "$code" = 200 ] || [ "$code" = 401 ]; } && { echo "n8n back up (collection $code)"; break; }
done
{ [ "$code" = 200 ] || [ "$code" = 401 ]; } || { echo "n8n did not come back within 60s" >&2; exit 1; }

# The rules that matter (membership, privacy, ratings, wishlists, admin, game matching): fast, and nothing is left behind
out=$($SSH "docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 -q" < ../server/bgc-db/tests/checks.sql 2>&1 | sed "s/^psql:<stdin>:[0-9]*: //; s/NOTICE:  //")
pass=$(echo "$out" | grep -c "^PASS")
if echo "$out" | grep -qE "FAIL|ERROR"; then echo "$out" | grep -E "FAIL|ERROR" >&2; echo "checks: $pass passed, then a failure" >&2; exit 1; fi
echo "checks: $pass passed"
# Nathan's question set (real AI calls, ~5 min):  node test-nathan.js
