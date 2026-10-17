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
  [ "$code" = 200 ] && { echo "n8n back up (collection 200)"; exit 0; }
done
echo "n8n did not come back within 60s" >&2; exit 1
