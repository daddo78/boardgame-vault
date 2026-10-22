#!/usr/bin/env bash
# Test, ship and start bgc-api on the Hostinger VPS without taking it down.
# Usage: ./deploy.sh
#   1. types, tests and build pass here first (check.sh)
#   2. the source goes to ~/bgc-api on the server and the image is built there (tagged with the git commit)
#   3. a new container starts beside the old one; once its health check passes (it can reach Postgres),
#      the old one is stopped (it finishes requests in flight). If the new one never gets healthy, it is
#      removed and the old one keeps serving.
set -euo pipefail
cd "$(dirname "$0")"

HOST=claude-ops@148.230.83.130
KEY="$HOME/.ssh/claude_hostinger"
SSH="ssh -i $KEY $HOST"
PUBLIC=https://api.ondorilabo.com/health   # once the Cloudflare tunnel hostname exists

bash check.sh
TAG=$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . || echo -dirty)
echo "deploying bgc-api $TAG"

tar -czf - src package.json package-lock.json tsconfig.json Dockerfile .dockerignore docker-compose.yml \
  | $SSH "mkdir -p ~/bgc-api && rm -rf ~/bgc-api/src && tar -xzf - -C ~/bgc-api"

$SSH "API_TAG=$TAG bash -s" <<'REMOTE'
set -euo pipefail
cd ~/bgc-api
DC="docker compose --env-file ../bgc-db/.env"
ids() { docker ps -aq --filter label=com.docker.compose.project=bgc-api --filter label=com.docker.compose.service=bgc-api; }

$DC build --quiet bgc-api
old=$(ids)
if [ -z "$old" ]; then $DC up -d bgc-api
else $DC up -d --no-deps --no-recreate --scale bgc-api=$(( $(echo "$old" | wc -l) + 1 )) bgc-api; fi
new=$(ids | grep -vxF -f <(echo "$old") || true)
[ -n "$new" ] || { echo "no new container started" >&2; exit 1; }

state=starting
for i in $(seq 1 30); do
  state=$(docker inspect -f '{{.State.Health.Status}}' "$new")
  [ "$state" = healthy ] && break
  [ "$state" = unhealthy ] && break
  sleep 2
done
if [ "$state" != healthy ]; then
  echo "new container is $state; keeping the old one. Its last lines:" >&2
  docker logs --tail 30 "$new" >&2 || true
  docker rm -f "$new" >/dev/null
  exit 1
fi
echo "new container healthy: $(docker inspect -f '{{.Name}}' "$new")"

# Let the tunnel see the new one, then hand over: the old ones finish what they're doing and stop
if [ -n "$old" ]; then
  sleep 3
  for c in $old; do docker stop -t 15 "$c" >/dev/null && docker rm "$c" >/dev/null && echo "old container stopped"; done
fi

# Keep the last 3 images to roll back to, drop older ones
docker images bgc-api --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | tail -n +4 | cut -f2 \
  | xargs -r docker rmi >/dev/null 2>&1 || true
REMOTE

code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC" || true)
if [ "$code" = 200 ]; then echo "public health check OK ($PUBLIC)"; else echo "public health check: $code (fine until api.ondorilabo.com is set up)"; fi
