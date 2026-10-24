#!/bin/sh
# Restore a night's backup from the backup repo into a NAMED database, so the restore path is one command, not a memory.
# Runs inside the bgc-backup container (it has psql, git, the ssh key and the repo clone at /repo that backup.sh pushes to):
#   docker exec -it bgc-backup sh /restore.sh bgc_check                     latest bgc.sql into a new database bgc_check
#   docker exec -it bgc-backup sh /restore.sh bgc_check 2026-10-01          the last backup committed on or before that date
#   docker exec -it bgc-backup sh /restore.sh nocodb_check 2026-10-01 nocodb   the NocoDB dump instead of bgc
#   docker exec -it bgc-backup sh /restore.sh bgc --force                   over the LIVE database (stop n8n and the API first)
# The target database is created; one that already exists is only replaced with --force (and never bgc or nocodb without it).
# Check a restored copy with:  docker exec bgc-postgres psql -U bgc -d bgc_check -c 'SELECT count(*) FROM shelves'
# and drop it afterwards with:  docker exec bgc-postgres psql -U bgc -d postgres -c 'DROP DATABASE bgc_check'
set -u
export GIT_SSH_COMMAND="ssh -i /keys/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/known_hosts"

target=""; date=""; src="bgc"; force=0
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    bgc|nocodb) if [ -z "$target" ]; then target=$a; else src=$a; fi ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) date=$a ;;
    *) if [ -z "$target" ]; then target=$a; else echo "restore: don't know what '$a' means"; exit 2; fi ;;
  esac
done
[ -z "$target" ] && { echo "usage: restore.sh <target database> [YYYY-MM-DD] [bgc|nocodb] [--force]"; exit 2; }
case "$target" in *[!a-z0-9_]*) echo "restore: database names are lower-case letters, digits and _"; exit 2 ;; esac
if [ "$target" = "bgc" ] || [ "$target" = "nocodb" ]; then
  [ $force -eq 1 ] || { echo "restore: '$target' is the live database; add --force to replace it (stop n8n and the API first)"; exit 2; }
fi

# The backup repo: the clone backup.sh uses, brought up to date
if [ ! -d /repo/.git ]; then git clone -q "$BACKUP_REPO" /repo || { echo "restore: clone failed"; exit 1; }; fi
cd /repo || exit 1
git fetch -q origin main || { echo "restore: fetch failed"; exit 1; }
if [ -n "$date" ]; then
  commit=$(git rev-list -1 --before="$date 23:59:59" origin/main)
  [ -n "$commit" ] || { echo "restore: no backup on or before $date"; exit 1; }
else
  commit=$(git rev-parse origin/main)
fi
echo "restore: $src.sql from $(git log -1 --format='%cs (%s)' "$commit") -> database $target"
git show "$commit:$src.sql" > /tmp/restore.sql || { echo "restore: no $src.sql in that backup"; exit 1; }

# A fresh database (or, with --force, the old one dropped first, connections closed)
exists=$(psql -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$target'")
if [ "$exists" = "1" ]; then
  [ $force -eq 1 ] || { echo "restore: database $target already exists; pick another name or add --force to replace it"; exit 1; }
  psql -q -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$target' AND pid <> pg_backend_pid()" >/dev/null
  psql -q -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$target\"" || exit 1
fi
psql -q -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$target\"" || exit 1
# The dumps are plain SQL without owners or grants (backup.sh), so they load as the bgc user into any database
psql -q -d "$target" -v ON_ERROR_STOP=1 -f /tmp/restore.sql || { echo "restore: loading $src.sql into $target failed (the database is left as is for a look)"; exit 1; }
rm -f /tmp/restore.sql
if [ "$src" = "bgc" ]; then
  psql -d "$target" -c "SELECT (SELECT count(*) FROM members) AS members, (SELECT count(*) FROM shelves) AS shelf_rows, (SELECT count(*) FROM plays) AS plays, (SELECT max(at) FROM backup_runs) AS last_backup_row"
fi
echo "restore: done. $target holds $src.sql from $(git log -1 --format=%cs "$commit")."
