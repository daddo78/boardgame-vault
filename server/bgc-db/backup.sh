#!/bin/sh
# Nightly backup: dump both databases as plain SQL and push to the private backup repo.
# Git keeps every night as a version, and plain SQL means each night only stores what changed.
#   /backup.sh        wait for BACKUP_AT (UTC) every day, then back up
#   /backup.sh now    back up once and exit (used to test)
set -u
# git and ssh come with the image (backup/Dockerfile); restore.sh restores a night from the same repo
export GIT_SSH_COMMAND="ssh -i /keys/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/known_hosts"

run() {
  if [ ! -d /repo/.git ]; then
    git clone -q "$BACKUP_REPO" /repo || { echo "backup: clone failed"; return 1; }
  fi
  cd /repo || return 1
  git pull -q --rebase origin main 2>/dev/null || true
  for db in bgc nocodb; do
    pg_dump --no-owner --no-privileges -d "$db" > "$db.sql.tmp" && mv "$db.sql.tmp" "$db.sql" || { echo "backup: dump of $db failed"; rm -f "$db.sql.tmp"; return 1; }
  done
  git add -A
  if git -c user.name="BGC backup" -c user.email="backup@bgc.invalid" commit -qm "Backup $(date -u +%F)"; then
    git push -q origin HEAD:main || { echo "backup: push failed"; return 1; }
    echo "backup: pushed $(date -u +%FT%TZ)"
  else
    echo "backup: nothing changed $(date -u +%FT%TZ)"
  fi
}

# Every attempt is recorded in the database; a daily n8n health check emails if backups stop succeeding
record() {
  msg=$(printf '%s' "$2" | tail -c 500 | sed "s/'/''/g")
  psql -q -d bgc -c "INSERT INTO backup_runs (ok, message) VALUES ($1, '$msg')" >/dev/null 2>&1 || true
}
backup() {
  out=$(run 2>&1); rc=$?
  echo "$out"
  if [ $rc -eq 0 ]; then record true "$out"; else record false "$out"; fi
  return $rc
}

if [ "${1:-}" = "now" ]; then backup; exit $?; fi
while true; do
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) $BACKUP_AT" +%s)
  [ "$target" -le "$now" ] && target=$((target + 86400))
  sleep $((target - now))
  backup
done
