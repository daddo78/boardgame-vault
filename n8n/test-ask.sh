#!/usr/bin/env bash
# Ask Nathan a question as a given member, without a Google sign-in, and print the answer plus how long each step took.
# Runs a temporary copy of the Ask workflow on the server (manual trigger, sign-in replaced by a fixed member).
#   ./test-ask.sh "What do you know about me?"                 (as Dan)
#   ./test-ask.sh "something quick for 4" friend@example.com    (as another member; pass a role with ROLE=friend)
#   SHELF=mine ./test-ask.sh "my top ten most played" friend@example.com   (on their own shelf; or SHELF=friend:3)
# Leaves an inactive "TEMP test: ask" workflow in n8n (archive it in the UI when done testing).
set -euo pipefail
cd "$(dirname "$0")"
Q="${1:?question}"; EMAIL="${2:-dandehaan@gmail.com}"; ROLE="${ROLE:-owner}"; SHELF="${SHELF:-main}"
SSH="ssh -i $HOME/.ssh/claude_hostinger claude-ops@148.230.83.130"
CONTAINER=n8n-ckq4-n8n-1
TMP="${TEMP:-/tmp}/tmpask-$$.json"
OUT="${TEMP:-/tmp}/tmpask-out-$$.json"
node - "$Q" "$EMAIL" "$ROLE" "$TMP" "$SHELF" <<'NODE'
const [q, email, role, out, shelf] = process.argv.slice(2);
const w = JSON.parse(require('fs').readFileSync('workflows/ask.json', 'utf8'));
w.id = 'BGVaultTmpAsk001'; w.name = 'TEMP test: ask'; delete w.settings.errorWorkflow;
const drop = (n) => /^Auth: (Read Token|Verify With Google|Check Token|Find Player)$/.test(n) || n === 'Token Valid?' || n === 'Member?';
w.nodes = w.nodes.filter((n) => !drop(n.name));
for (const k of Object.keys(w.connections)) if (drop(k)) delete w.connections[k];
const wh = w.nodes.find((n) => n.name === 'Webhook');
Object.assign(wh, { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }); delete wh.webhookId;
const roleNode = w.nodes.find((n) => n.name === 'Auth: Role');
roleNode.parameters = { jsCode: `return [{ json: { body: { question: ${JSON.stringify(q)}, playerIds: [], shelf: ${JSON.stringify(shelf)}, previous: ${process.env.PREV || "null"} }, _authOk: true, _auth: { role: ${JSON.stringify(role)}, email: ${JSON.stringify(email)}, playerId: $('Who').first().json.playerId, playerName: $('Who').first().json.playerName } } }];` };
// Look up the member's player card the same way sign-in does
w.nodes.push({ id: 'who', name: 'Who', type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [0, 200],
  parameters: { operation: 'executeQuery', options: {},
    query: "SELECT x -> 'records' -> 0 ->> 'id' AS \"playerId\", x -> 'records' -> 0 -> 'fields' ->> 'fldWVws64FVcdtuSJ' AS \"playerName\" FROM (SELECT at.request('tblNahVdHDueJJ0w4', 'GET', '', 'null', 'LOWER({GoogleEmail})=''" + email.toLowerCase().replace(/'/g, '') + "''') AS x) q" },
  credentials: { postgres: { id: 'BGCPostgres00001', name: 'BGC Postgres' } } });
w.connections.Webhook = { main: [[{ node: 'Who', type: 'main', index: 0 }]] };
w.connections.Who = { main: [[{ node: 'Auth: Role', type: 'main', index: 0 }]] };
w.connections['Auth: Role'] = { main: [[{ node: 'Validate', type: 'main', index: 0 }]] };
// Test questions don't use up anyone's daily allowance
const use = w.nodes.find((n) => n.name === 'Use Allowance');
Object.assign(use, { type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return [{ json: { questions: 0 } }];' } }); delete use.credentials;
for (const n of w.nodes) if (n.type === 'n8n-nodes-base.respondToWebhook') Object.assign(n, { type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return $input.all();' } });
require('fs').writeFileSync(out, JSON.stringify([w]));
NODE
NAME="tmpask-$(date +%s).json"
scp -q -i "$HOME/.ssh/claude_hostinger" "$TMP" "claude-ops@148.230.83.130:/tmp/$NAME"; rm -f "$TMP"
$SSH "cat /tmp/$NAME | docker exec -i $CONTAINER sh -c 'cat > /tmp/$NAME'; rm -f /tmp/$NAME; docker exec $CONTAINER n8n import:workflow --input=/tmp/$NAME >/dev/null 2>&1; docker exec $CONTAINER rm -f /tmp/$NAME;
  docker exec -e N8N_RUNNERS_BROKER_PORT=5691 -e N8N_PORT=5699 -e QUEUE_HEALTH_CHECK_PORT=5698 $CONTAINER sh -c 'n8n execute --id=BGVaultTmpAsk001 --rawOutput > /tmp/tmpask-out.json 2>/dev/null; cat /tmp/tmpask-out.json; rm -f /tmp/tmpask-out.json'" > "$OUT" || true
node - "$OUT" <<'NODE'
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
fs.rmSync(process.argv[2], { force: true });
const start = raw.indexOf('{');
let ex;
try { ex = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1)); } catch (e) { console.log(String(e).slice(0, 300), raw.length, raw.slice(-400)); process.exit(1); }
const rd = (ex.data || ex).resultData; if (rd.error) console.log('ERROR in ' + (rd.lastNodeExecuted || '?') + ': ' + (rd.error.message || JSON.stringify(rd.error)).slice(0, 400));
const run = rd.runData;
const steps = Object.entries(run).map(([n, r]) => [n, r.reduce((t, x) => t + (x.executionTime || 0), 0)]).filter(([, t]) => t >= 50).sort((a, b) => b[1] - a[1]);
const total = Object.values(run).flat().reduce((t, x) => t + (x.executionTime || 0), 0);
console.log('TIMING (ms): total ' + total);
for (const [n, t] of steps) console.log('  ' + String(t).padStart(6) + '  ' + n);
if (process.env.SHOW) for (const n of process.env.SHOW.split(',')) if (run[n]) console.log(n + ': ' + JSON.stringify(run[n][0].data.main[0].map((i) => i.json.choices ? i.json.choices[0].message.content : process.env.KEY ? i.json[process.env.KEY] : i.json)).slice(0, 1500));
const last = run['Respond OK'] ? run['Respond OK'][0].data.main[0][0].json : null;
if (last) {
  console.log('\nANSWER: ' + (last.intent || '') + ' matchIds=' + ((last.matchIds || []).length));
  if (last.summary) console.log(last.summary);
  if (last.pick) { console.log('pick: ' + last.pick.title + ' -- ' + (last.pick.why || '')); console.log('alt: ' + (last.alternative || {}).title + ' -- ' + ((last.alternative || {}).why || '')); }
  if (last.gap) console.log('gap: ' + JSON.stringify(last.gap));
  if (last.understood) console.log('understood: ' + JSON.stringify(last.understood));
  if (last.highlights) console.log('highlights: ' + last.highlights.map((h) => h.title).join(', '));
  if (last.note || last.message) console.log(last.note || last.message);
}
NODE
