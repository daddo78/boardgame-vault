#!/usr/bin/env bash
# A dev copy of the Board Game Curator database, on Unraid, so a migration and the checks run against real data before
# deploy.sh touches the VPS. One Postgres container (bgc-postgres-dev) holding yesterday's-or-fresher copy of bgc.
#   bash dev.sh up                 create the container (or start it), data under /mnt/evo870pool/devbox/bgc-dev
#   bash dev.sh refresh            replace its data with a dump of the live database, taken now (about 26 MB, a minute)
#   bash dev.sh migrate [--dry-run]  copy schema/ over and apply the pending migrations there (schema/apply.sh)
#   bash dev.sh check              run tests/checks.sql against it: PASS lines, stops at the first FAIL
#   bash dev.sh sql 'SELECT count(*) FROM shelves'
#   bash dev.sh down               stop and remove the container (the data folder stays)
# Before a database deploy:  bash dev.sh refresh && bash dev.sh migrate && bash dev.sh check
# The dev password is made once on Unraid (/mnt/evo870pool/devbox/bgc-dev/.env, root only) and never leaves it. The container
# publishes no port: everything goes through `ssh unraid docker exec`. The copy holds members' emails like the live
# database does; it lives on Dan's own server and nowhere else.
set -euo pipefail
cd "$(dirname "$0")"

UNRAID=unraid                                              # ssh alias (root@ondorilabo.local)
VPS="ssh -i $HOME/.ssh/claude_hostinger claude-ops@100.101.202.120"
DIR=/mnt/evo870pool/devbox/bgc-dev
C=bgc-postgres-dev
U="ssh $UNRAID"
PSQL="docker exec -i $C psql -U bgc -d bgc -v ON_ERROR_STOP=1"

case "${1:-}" in
  up)
    $U "set -e; mkdir -p $DIR/pgdata $DIR/schema $DIR/tests
      if [ ! -f $DIR/.env ]; then (umask 077; echo POSTGRES_PASSWORD=\$(openssl rand -hex 24) > $DIR/.env); echo 'dev password made'; fi
      if docker ps -a --format '{{.Names}}' | grep -qx $C; then docker start $C >/dev/null; echo '$C started'
      else docker run -d --name $C --restart unless-stopped --memory 512m --env-file $DIR/.env -e POSTGRES_USER=bgc -e POSTGRES_DB=bgc \
             -v $DIR/pgdata:/var/lib/postgresql/data postgres:16-alpine >/dev/null; echo '$C created (postgres:16-alpine)'; fi
      for i in \$(seq 1 30); do docker exec $C pg_isready -U bgc -d bgc >/dev/null 2>&1 && { echo 'postgres ready'; exit 0; }; sleep 1; done
      echo 'postgres not ready after 30 s' >&2; exit 1" ;;

  refresh)
    echo "replacing bgc on $C with a dump of the live database..."
    $U "docker exec $C psql -U bgc -d postgres -q -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS bgc WITH (FORCE)' -c 'CREATE DATABASE bgc'"
    $VPS 'docker exec bgc-postgres pg_dump -U bgc --no-owner --no-privileges -d bgc' | $U "$PSQL -q"
    $U "$PSQL -At -c \"SELECT (SELECT count(*) FROM members) || ' members, ' || (SELECT count(*) FROM shelves) || ' shelf rows, ' || (SELECT count(*) FROM plays) || ' plays; ledger at ' || (SELECT max(version) FROM bgc.schema_migrations)\"" ;;

  migrate)
    tar -czf - -C schema . | $U "tar -xzf - -C $DIR/schema"
    $U "cd $DIR/schema && BGC_PG=$C bash apply.sh ${2:-}" ;;

  check)
    $U "$PSQL -q -o /dev/null" < tests/checks.sql 2>&1 | grep -v '^NOTICE:  PASS' | sed 's/^psql:[^:]*:[0-9]*: //' || true
    $U "$PSQL -At -c \"SELECT count(*) || ' checks in bgc.self_check(), ' || count(*) FILTER (WHERE (x ->> 'ok')::boolean) || ' passed' FROM jsonb_array_elements(bgc.self_check()) x\"" ;;

  sql)
    printf '%s\n' "${2:?a SQL statement}" | $U "$PSQL -At" ;;

  down)
    $U "docker rm -f $C >/dev/null && echo '$C removed; data kept in $DIR/pgdata'" ;;

  *)
    sed -n '2,13p' "$0"; exit 2 ;;
esac
