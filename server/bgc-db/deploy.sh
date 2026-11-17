#!/usr/bin/env bash
# Ship the database files to the Hostinger VPS and apply what's new, like the API's and n8n's deploy.sh.
# Usage: ./deploy.sh            copy, apply the pending migrations (schema/apply.sh), rebuild the compose stack
#        ./deploy.sh --dry-run  copy, then only list what apply.sh would do
#   1. schema/, backup/, backup.sh, restore.sh, docker-compose.yml, .env.example, tests/ and pages/ go to ~/bgc-db
#      (never .env or keys/: those live only on the server)
#   2. apply.sh applies each migration not yet in bgc.schema_migrations, in order, each inside its own transaction
#   3. docker compose up -d --build picks up compose changes (limits, health checks, the backup image); containers
#      whose definition changed are recreated, so Postgres can be away for a few seconds
#   4. bgc.self_check() must pass, as after an n8n deploy
# Try it first on the dev copy on Unraid:  bash dev.sh refresh && bash dev.sh migrate && bash dev.sh check
set -euo pipefail
cd "$(dirname "$0")"
. ../../n8n/env.sh   # N8N_SSH_HOST, N8N_SSH_KEY: the same server
SSH="ssh -i $N8N_SSH_KEY $N8N_SSH_HOST"

echo "copying bgc-db files to $N8N_SSH_HOST:~/bgc-db"
tar -czf - schema backup backup.sh restore.sh docker-compose.yml .env.example tests pages \
  | $SSH "mkdir -p ~/bgc-db && tar -xzf - -C ~/bgc-db && chmod +x ~/bgc-db/schema/apply.sh ~/bgc-db/backup.sh ~/bgc-db/restore.sh"

echo "--- pending migrations ---"
$SSH "cd ~/bgc-db/schema && bash apply.sh --dry-run"
[ "${1:-}" = --dry-run ] && exit 0

echo "--- applying ---"
$SSH "cd ~/bgc-db/schema && bash apply.sh"

# The API's own login (060): its password comes from BGC_APP_PASSWORD in ~/bgc-db/.env and never leaves the server
$SSH 'pw=$(grep -E "^BGC_APP_PASSWORD=[0-9a-f]{32,}$" ~/bgc-db/.env | cut -d= -f2); if [ -n "$pw" ]; then echo "ALTER ROLE bgc_app PASSWORD '"'"'$pw'"'"';" | docker exec -i bgc-postgres psql -U bgc -d bgc -q && echo "bgc_app password set"; else echo "BGC_APP_PASSWORD not in .env: the API keeps using bgc"; fi'

echo "--- compose ---"
$SSH "docker network inspect bgc >/dev/null 2>&1 || docker network create bgc >/dev/null"   # Board Game Curator's own network
$SSH "cd ~/bgc-db && docker compose up -d --build 2>&1 | tail -8 && docker ps --format '{{.Names}}: {{.Status}}' | grep bgc-"

echo "--- checks ---"
res=$($SSH "docker exec bgc-postgres psql -U bgc -d bgc -At -c \"SELECT (x->>'ok') || ' ' || (x->>'what') FROM jsonb_array_elements(bgc.self_check()) x\"")
pass=$(echo "$res" | grep -c "^true ")
fail=$(echo "$res" | grep -v "^true " | grep -v "^$" || true)
if [ -n "$fail" ]; then echo "$fail" | sed "s/^false /FAIL: /" >&2; echo "checks: $pass passed, some failed" >&2; exit 1; fi
echo "checks: $pass passed"
$SSH "docker exec bgc-postgres psql -U bgc -d bgc -At -c \"SELECT string_agg(version, ' ' ORDER BY version) FROM bgc.schema_migrations\"" | sed 's/^/applied: /'
