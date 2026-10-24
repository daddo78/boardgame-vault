// Asks Nathan the questions in tests/nathan.json (as Dan or Nathan Schmidt) and checks each answer.
// Real AI calls, but they don't use anyone's daily allowance. About 15 seconds a question.
//   node test-nathan.js            all questions
//   node test-nathan.js shame      only questions whose name contains "shame"
//   TARGET=api node test-nathan.js the same questions to the new API (server/bgc-api), with when his first words came
//   API_TAG=<tag> TARGET=api ...    to a build that isn't serving yet (server/bgc-api/deploy.sh --trial)
// Exit code 1 if any check fails.
const { execFileSync } = require('child_process');
const path = require('path');
const tests = require('./tests/nathan.json');
const { textOf, score } = require('./tests/score'); // the same scorer the nightly self-test runs
// The server (host, key) from env.sh, the file the shell scripts source: plain NAME=value lines, $HOME allowed
const ENV = Object.fromEntries([...require('fs').readFileSync(path.join(__dirname, 'env.sh'), 'utf8').matchAll(/^(\w+)=("?)(.*?)\2\s*$/gm)]
  .map((m) => [m[1], m[3].replace(/\$\{?HOME\}?/g, require('os').homedir())]));
const only = (process.argv[2] || '').toLowerCase();
const WHO = { dan: { email: 'dandehaan@gmail.com', role: 'owner', shelf: 'main' }, nathan: { email: 'nathan.schmidt@curator.invalid', role: 'friend', shelf: 'mine' } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let failed = 0, ran = 0;
for (const t of tests) {
  if (only && !t.name.toLowerCase().includes(only)) continue;
  // Starting from given notes ("memory") needs the API's test tool; n8n's webhook can't take them
  if (t.memory && process.env.TARGET !== 'api') { console.log('SKIP  ' + t.name + '  (memory tests run with TARGET=api)'); continue; }
  const who = WHO[t.as];
  const env = { ...process.env, JSON: '1', ROLE: who.role, SHELF: t.shelf || who.shelf, PREV: t.prev ? JSON.stringify(t.prev) : '' };
  let a, time = '';
  try {
    const out = process.env.TARGET === 'api'
      ? execFileSync('ssh', ['-i', ENV.N8N_SSH_KEY, ENV.N8N_SSH_HOST,
          process.env.API_TAG // a build not yet serving (deploy.sh --trial), in a throwaway container the tunnel can't reach
            ? 'cd ~/bgc-api && API_TAG=' + process.env.API_TAG.replace(/[^\w.-]/g, '') + ' docker compose --env-file ../bgc-db/.env run --rm -T --no-deps bgc-api node dist/tools/askAs.js -'
            : 'docker exec -i $(docker ps -q --filter label=com.docker.compose.service=bgc-api --filter label=com.docker.compose.oneoff=False | head -1) node dist/tools/askAs.js -'],
          { input: JSON.stringify({ email: who.email, question: t.q, shelf: t.shelf || who.shelf, previous: t.prev || null, stream: true, ...(t.memory ? { testMemory: t.memory } : {}) }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 })
      : execFileSync('bash', [path.join(__dirname, 'test-ask.sh'), t.q, who.email], { env, cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const tl = out.split('\n').find((l) => l.startsWith('@@TIME '));
    if (tl) { const [first, total] = tl.slice(7).split(' ').map(Number); time = '  (first words ' + (first / 1000).toFixed(1) + ' s, done ' + (total / 1000).toFixed(1) + ' s)'; }
    const line = out.split('\n').find((l) => l.startsWith('@@JSON '));
    a = line ? JSON.parse(line.slice(7)) : { error: 'no answer' };
  } catch (e) { a = { error: String(e.message).slice(0, 200) }; }
  const text = textOf(a);
  const problems = score(t, a);
  ran++;
  if (problems.length) { failed++; console.log('FAIL  ' + t.name + time + '\n      ' + problems.join('; ') + '\n      answer: ' + text.replace(/\s+/g, ' ').slice(0, 300)); }
  else console.log('PASS  ' + t.name + time);
  if (a.ask) console.log('      asks: ' + a.ask);
  sleep(8000); // gentle on the AI service
}
console.log('\n' + (ran - failed) + ' of ' + ran + ' passed');
process.exit(failed ? 1 : 0);
