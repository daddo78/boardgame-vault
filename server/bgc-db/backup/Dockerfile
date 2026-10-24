# The backup job's image: postgres:16-alpine (pg_dump and psql matching the server) plus git and ssh, installed once here
# instead of by backup.sh on every container start, which needed the Alpine mirrors reachable each time the box rebooted.
# Built by docker compose (build: ./backup); backup.sh and restore.sh stay mounted from the host, so they can change without a rebuild.
FROM postgres:16-alpine
RUN apk add --no-cache git openssh-client
