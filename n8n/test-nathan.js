// Asks Nathan the questions in tests/nathan.json (as Dan or Nathan Schmidt) and checks each answer.
// Real AI calls, but they don't use anyone's daily allowance. About 15 seconds a question.
//   node test-nathan.js            all questions
//   node test-nathan.js shame      only questions whose name contains "shame"
// Exit code 1 if any check fails.
const { execFileSync } = require('child_process');
const path = require('path');
const tests = require('./tests/nathan.json');
const only = (process.argv[2] || '').toLowerCase();
const WHO = { dan: { email: 'dandehaan@gmail.com', role: 'owner', shelf: 'main' }, nathan: { email: 'nathan.schmidt@curator.invalid', role: 'friend', shelf: 'mine' } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Everything an answer says, as one string (summary, picks, highlights, notes)
const textOf = (a) => [a.summary, a.note, a.message, a.error, a.pick && [a.pick.title, a.pick.why, a.pick.tableFeel], a.alternative && [a.alternative.title, a.alternative.why],
  ...(a.highlights || []).map((h) => [h.title, h.why]), a.gap && a.gap.missing,
  // What the cards show: "Not on your shelf · Nathan has it"
  ...[a.pick, a.alternative, ...(a.highlights || [])].filter((x) => x && x.off && (x.off.friends || []).length).map((x) => x.off.friends.join(' & ') + ' has it')].flat(3).filter(Boolean).join(' \n ');

let failed = 0, ran = 0;
for (const t of tests) {
  if (only && !t.name.toLowerCase().includes(only)) continue;
  const who = WHO[t.as];
  const env = { ...process.env, JSON: '1', ROLE: who.role, SHELF: t.shelf || who.shelf, PREV: t.prev ? JSON.stringify(t.prev) : '' };
  let a;
  try {
    const out = execFileSync('bash', [path.join(__dirname, 'test-ask.sh'), t.q, who.email], { env, cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    const line = out.split('\n').find((l) => l.startsWith('@@JSON '));
    a = line ? JSON.parse(line.slice(7)) : { error: 'no answer' };
  } catch (e) { a = { error: String(e.message).slice(0, 200) }; }
  const text = textOf(a);
  const low = text.toLowerCase();
  const problems = [];
  if (a.error) problems.push('error: ' + a.error);
  for (const s of t.includes || []) if (!low.includes(s.toLowerCase())) problems.push('missing "' + s + '"');
  if (t.includesAny && !t.includesAny.some((s) => low.includes(s.toLowerCase()))) problems.push('none of ' + JSON.stringify(t.includesAny));
  for (const s of t.excludes || []) if (low.includes(s.toLowerCase())) problems.push('should not say "' + s + '"');
  const n = (a.matchIds || []).length;
  if (t.matchMin != null && n < t.matchMin) problems.push(n + ' games, expected at least ' + t.matchMin);
  if (t.matchMax != null && n > t.matchMax) problems.push(n + ' games, expected at most ' + t.matchMax);
  if (t.intent && a.intent !== t.intent) problems.push('intent ' + a.intent + ', expected ' + t.intent);
  if (t.mode && a.mode !== t.mode) problems.push('mode ' + a.mode + ', expected ' + t.mode);
  if (t.offTopic && !a.offTopic) problems.push('expected an off-topic redirect');
  if (t.playerCount !== undefined && ((a.understood || {}).playerCount ?? null) !== t.playerCount) problems.push('understood ' + ((a.understood || {}).playerCount ?? 'no') + ' players, expected ' + t.playerCount);
  if (t.remembers && !(a.remembered || []).length) problems.push('expected Nathan to remember something');
  if (t.cites && !(a.sources || []).some((x) => !t.cites.page || x.page === t.cites.page)) problems.push('expected a page from the rulebook' + (t.cites.page ? ' (p. ' + t.cites.page + ')' : '') + ', got ' + JSON.stringify((a.sources || []).map((x) => x.label + ' p.' + x.page)));
  ran++;
  if (problems.length) { failed++; console.log('FAIL  ' + t.name + '\n      ' + problems.join('; ') + '\n      answer: ' + text.replace(/\s+/g, ' ').slice(0, 300)); }
  else console.log('PASS  ' + t.name);
  sleep(8000); // gentle on the AI service
}
console.log('\n' + (ran - failed) + ' of ' + ran + ' passed');
process.exit(failed ? 1 : 0);
