#!/usr/bin/env bash
# Runs a member-gated workflow as a given member (no Google sign-in) and prints what it would answer.
#   run-as.sh <workflow> <email> [queryJSON] [bodyJSON]     e.g. run-as.sh shelf nathan.schmidt@curator.invalid
#   PID=<their player card id> run-as.sh rate ...   (for workflows that need the signed-in player card)
set -euo pipefail
cd "$(dirname "$0")"
. ./env.sh
WF="$1"; EMAIL="$2"; QUERY="${3:-{\}}"; BODY="${4:-{\}}"
TMP="${TEMP:-/tmp}/runas-$$.json"; OUT="${TEMP:-/tmp}/runas-out-$$.json"
node - "$WF" "$EMAIL" "$QUERY" "$BODY" "$TMP" <<'NODE'
const [wf, email, query, body, out] = process.argv.slice(2);
const w = JSON.parse(require('fs').readFileSync('workflows/' + wf + '.json', 'utf8'));
require('./tests/as-member')(w, { id: 'BGVaultTmpRunAs1', name: 'TEMP test: run as',
  roleCode: `return [{ json: { query: ${query}, body: ${body}, headers: {}, _authOk: true, _auth: { role: 'friend', email: ${JSON.stringify(email)}, playerId: ${JSON.stringify(process.env.PID || null)}, playerName: '' } } }];` });
// The answer the page would get, marked so the reader below can find it
for (const n of w.nodes) if (n.type === 'n8n-nodes-base.respondToWebhook') {
  Object.assign(n, { type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return [{ json: { __respond: ' + JSON.stringify(n.name) + ', body: $input.first().json } }];' } });
}
require('fs').writeFileSync(out, JSON.stringify([w]));
NODE
n8n_run_once "$TMP" BGVaultTmpRunAs1 "$OUT"; rm -f "$TMP"
node - "$OUT" <<'NODE'
const fs = require('fs'); const raw = fs.readFileSync(process.argv[2], 'utf8'); fs.rmSync(process.argv[2], { force: true });
const ex = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
const rd = (ex.data || ex).resultData;
if (rd.error) { console.error('ERROR in ' + rd.lastNodeExecuted + ': ' + rd.error.message); process.exit(1); }
for (const [name, runs] of Object.entries(rd.runData)) for (const r of runs) for (const i of ((r.data || {}).main || [[]])[0] || [])
  if (i.json && i.json.__respond) process.stdout.write(JSON.stringify(i.json.body));
NODE
