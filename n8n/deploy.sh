#!/usr/bin/env bash
# Regenerate, import, publish and reload Board Game Garage workflows on the Hostinger n8n.
# Usage: ./deploy.sh [workflowFile ...]   e.g. ./deploy.sh iconOne bggOne   (default: all)
set -euo pipefail
cd "$(dirname "$0")"
. ./env.sh

BGG_CRED=rZyqHvE3jW7FFkmj
BGG_USERNAME="daddo_78"   # BGG account whose plays (posted by BG Stats) are synced
SSH="ssh -i $N8N_SSH_KEY $N8N_SSH_HOST"

node gen.js "$BGG_CRED" "${BGG_USERNAME:-}" >/dev/null
names=("$@")
# askTest and selfTest are built from Ask (a clone, and the nightly runner that bakes in server/bgc-api/src/selftest/nathan.json): they go along
if [ $# -gt 0 ]; then
  for n in "$@"; do [ "$n" = ask ] && names+=(askTest selfTest); done
  git diff --quiet HEAD -- ../server/bgc-api/src/selftest/nathan.json tests/score.js || names+=(selfTest)   # uncommitted test changes
fi
if [ $# -eq 0 ]; then files=(workflows/*.json); else files=(); for n in $(printf '%s\n' "${names[@]}" | awk '!seen[$0]++'); do files+=("workflows/$n.json"); done; fi

STAGE=/tmp/bgv-$(date +%s)
$SSH "mkdir -p $STAGE"
scp -q -i "$N8N_SSH_KEY" "${files[@]}" "$N8N_SSH_HOST:$STAGE/"
$SSH "docker cp $STAGE $N8N_CONTAINER:$STAGE && docker exec $N8N_CONTAINER n8n import:workflow --separate --input=$STAGE 2>&1 | grep -i import; rm -rf $STAGE"

# Publish everything with a webhook or schedule (batch runners are manual-only)
for f in "${files[@]}"; do
  if grep -qE '"n8n-nodes-base.(webhook|scheduleTrigger|executeWorkflowTrigger)"' "$f"; then
    id=$(grep -m1 -oE '"id": "BGVault[A-Za-z0-9]+"' "$f" | cut -d'"' -f4)
    $SSH "docker exec $N8N_CONTAINER n8n publish:workflow --id=$id >/dev/null 2>&1" && echo "published $id"
  fi
done

# The restart is what makes n8n pick up the imported, published versions. Hypothesis (untested): publish:workflow alone
# may be enough on this n8n version and the restart (~20 s of downtime) could go; try a deploy without it some quiet day.
$SSH "docker restart $N8N_CONTAINER >/dev/null"
for i in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' https://n8n.ondorilabo.com/webhook/vault/collection || true)
  # The collection is members-only, so a 401 ("sign in first") also means n8n is up and answering
  { [ "$code" = 200 ] || [ "$code" = 401 ]; } && { echo "n8n back up (collection $code)"; break; }
done
{ [ "$code" = 200 ] || [ "$code" = 401 ]; } || { echo "n8n did not come back within 60s" >&2; exit 1; }

# The rules that matter (membership, privacy, ratings, wishlists, admin, game matching): fast, and nothing is left behind
res=$($SSH "docker exec bgc-postgres psql -U bgc -d bgc -At -c \"SELECT (x->>'ok') || ' ' || (x->>'what') FROM jsonb_array_elements(bgc.self_check()) x\"" 2>&1)
pass=$(echo "$res" | grep -c "^true ")
fail=$(echo "$res" | grep -v "^true " | grep -v "^$" || true)
if [ -n "$fail" ]; then echo "$fail" | sed "s/^false /FAIL: /" >&2; echo "checks: $pass passed, some failed" >&2; exit 1; fi
echo "checks: $pass passed"
# Nathan's question set (real AI calls, ~5 min):  node test-nathan.js
