#!/usr/bin/env bash
# Runs a member-gated workflow as a given member (no Google sign-in) and prints what it would answer.
#   run-as.sh <workflow> <email> [queryJSON] [bodyJSON]     e.g. run-as.sh shelf nathan.schmidt@curator.invalid
#   PID=<their player card id> run-as.sh rate ...   (for workflows that need the signed-in player card)
set -euo pipefail
cd "/g/My Drive/GitHub/boardgame-vault/n8n"
WF="$1"; EMAIL="$2"; QUERY="${3:-{\}}"; BODY="${4:-{\}}"
SSH="ssh -i $HOME/.ssh/claude_hostinger claude-ops@148.230.83.130"
C=n8n-ckq4-n8n-1
TMP="${TEMP:-/tmp}/runas-$$.json"; OUT="${TEMP:-/tmp}/runas-out-$$.json"
node - "$WF" "$EMAIL" "$QUERY" "$BODY" "$TMP" <<'NODE'
const [wf, email, query, body, out] = process.argv.slice(2);
const w = JSON.parse(require('fs').readFileSync('workflows/' + wf + '.json', 'utf8'));
w.id = 'BGVaultTmpRunAs1'; w.name = 'TEMP test: run as'; delete w.settings.errorWorkflow;
const member = w.connections['Member?'];
const target = member.main[0][0].node; // where a signed-in member goes next
const drop = (n) => /^Auth: (Read Token|Verify With Google|Check Token|Find Player)$/.test(n) || n === 'Token Valid?' || n === 'Member?';
w.nodes = w.nodes.filter((n) => !drop(n.name));
for (const k of Object.keys(w.connections)) if (drop(k)) delete w.connections[k];
const wh = w.nodes.find((n) => n.name === 'Webhook');
Object.assign(wh, { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }); delete wh.webhookId;
const role = w.nodes.find((n) => n.name === 'Auth: Role');
role.parameters = { jsCode: `return [{ json: { query: ${query}, body: ${body}, headers: {}, _authOk: true, _auth: { role: 'friend', email: ${JSON.stringify(email)}, playerId: ${JSON.stringify(process.env.PID || null)}, playerName: '' } } }];` };
w.connections.Webhook = { main: [[{ node: 'Auth: Role', type: 'main', index: 0 }]] };
w.connections['Auth: Role'] = { main: [[{ node: target, type: 'main', index: 0 }]] };
for (const n of w.nodes) if (n.type === 'n8n-nodes-base.respondToWebhook') {
  const expr = String(n.parameters.responseBody || '{{ $json }}').replace(/^=/, '');
  Object.assign(n, { type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return [{ json: { __respond: ' + JSON.stringify(n.name) + ', body: $input.first().json } }];' } });
}
require('fs').writeFileSync(out, JSON.stringify([w]));
NODE
NAME="runas-$(date +%s)-$$.json"
scp -q -i "$HOME/.ssh/claude_hostinger" "$TMP" "claude-ops@148.230.83.130:/tmp/$NAME"; rm -f "$TMP"
$SSH "cat /tmp/$NAME | docker exec -i $C sh -c 'cat > /tmp/$NAME'; rm -f /tmp/$NAME; docker exec $C n8n import:workflow --input=/tmp/$NAME >/dev/null 2>&1; docker exec $C rm -f /tmp/$NAME;
  docker exec -e N8N_RUNNERS_BROKER_PORT=5691 -e N8N_PORT=5699 -e QUEUE_HEALTH_CHECK_PORT=5698 $C sh -c 'n8n execute --id=BGVaultTmpRunAs1 --rawOutput > /tmp/runas-out.json 2>/dev/null; cat /tmp/runas-out.json; rm -f /tmp/runas-out.json'" > "$OUT" < /dev/null || true
node - "$OUT" <<'NODE'
const fs = require('fs'); const raw = fs.readFileSync(process.argv[2], 'utf8'); fs.rmSync(process.argv[2], { force: true });
const ex = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
const rd = (ex.data || ex).resultData;
if (rd.error) { console.error('ERROR in ' + rd.lastNodeExecuted + ': ' + rd.error.message); process.exit(1); }
for (const [name, runs] of Object.entries(rd.runData)) for (const r of runs) for (const i of ((r.data || {}).main || [[]])[0] || [])
  if (i.json && i.json.__respond) process.stdout.write(JSON.stringify(i.json.body));
NODE
