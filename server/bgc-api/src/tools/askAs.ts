// Ask Nathan as a member, from inside the container (no Google sign-in, no web route): for the question set.
//   docker exec <bgc-api container> node dist/tools/askAs.js '<json>'   (or '-', with the json on stdin)
//   json: { email, question, shelf?, previous?, chatKey?, memory?: false, save?: true, stream?: true,
//           testMemory?: { notes: ['Burned out on Point Salad; don't suggest it'], skipBgg: [274960] } }  (in place of their own notes)
// Prints one line "@@JSON <answer>" (as n8n/test-ask.sh does) and "@@TIME <ms to first words> <ms total>".
// Doesn't use the member's daily allowance; costs are logged as "tests"; the chat is saved only with save: true.
import { loadConfig } from '../config.js';
import { pgDb, signIn } from '../db.js';
import { askNathan, respondBody } from '../nathan/ask.js';

const arg = process.argv[2] || '{}';
const a = JSON.parse(arg === '-' ? await new Response(process.stdin as any).text() : arg);
const config = loadConfig();
const db = pgDb(config.databaseUrl);
try {
  if (!config.openrouterKey) throw new Error('OPENROUTER_API_KEY is not set');
  const email = String(a.email || '').toLowerCase();
  const m: any = await signIn(db, email);
  const owner = config.ownerEmails.includes(email);
  if (!owner && !m?.member) throw new Error(email + ' is not a member');
  const auth = { role: owner ? 'owner' : 'friend', email, memberId: m?.id ?? null, admin: owner || !!m?.isAdmin, playerId: m?.playerId ?? null, playerName: m?.playerName ?? null } as const;
  const t0 = Date.now();
  let first = 0;
  const r = await askNathan({ db, openrouterKey: config.openrouterKey, bggToken: config.bggToken }, auth,
    { question: a.question, shelf: a.shelf || 'main', previous: a.previous ?? null, chatKey: a.chatKey || '', noMemory: a.memory === false, test: true, ...(a.testMemory ? { testMemory: a.testMemory } : {}) },
    a.stream ? { partial: (view) => { if (!first && JSON.stringify(view() ?? '').match(/"(summary|why)":"[^"]/)) first = Date.now() - t0; } } : {});
  const total = Date.now() - t0;
  await r.after(!!a.save);
  console.log('@@JSON ' + JSON.stringify(respondBody(r.answer, r.chatKey)));
  console.log('@@TIME ' + (first || total) + ' ' + total);
} catch (e) {
  console.log('@@JSON ' + JSON.stringify({ error: String((e as Error).message || e) }));
  process.exitCode = 1;
} finally {
  await db.close();
}
