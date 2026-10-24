# The Hostinger server that runs n8n. Sourced by deploy.sh, run-as.sh and test-ask.sh; test-nathan.js reads it too
# (plain NAME=value lines only, $HOME allowed).
N8N_SSH_HOST=claude-ops@148.230.83.130
N8N_SSH_KEY="$HOME/.ssh/claude_hostinger"
N8N_CONTAINER=n8n-ckq4-n8n-1

# Imports a one-off workflow JSON into n8n, runs it once with `n8n execute`, and leaves the raw execution in $3.
#   n8n_run_once <local json> <workflow id> <output file>
# (The CLI needs its own ports, or it collides with the running n8n in the same container.)
n8n_run_once() {
  local name="once-$(date +%s)-$$.json"
  scp -q -i "$N8N_SSH_KEY" "$1" "$N8N_SSH_HOST:/tmp/$name"
  ssh -i "$N8N_SSH_KEY" "$N8N_SSH_HOST" "cat /tmp/$name | docker exec -i $N8N_CONTAINER sh -c 'cat > /tmp/$name'; rm -f /tmp/$name;
    docker exec $N8N_CONTAINER n8n import:workflow --input=/tmp/$name >/dev/null 2>&1; docker exec $N8N_CONTAINER rm -f /tmp/$name;
    docker exec -e N8N_RUNNERS_BROKER_PORT=5691 -e N8N_PORT=5699 -e QUEUE_HEALTH_CHECK_PORT=5698 $N8N_CONTAINER sh -c 'n8n execute --id=$2 --rawOutput > /tmp/$name.out 2>/dev/null; cat /tmp/$name.out; rm -f /tmp/$name.out'" > "$3" < /dev/null || true
}
