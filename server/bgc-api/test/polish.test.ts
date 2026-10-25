// One shelf for everyone: adding to your own shelf (by name, from a photo) polishes a new catalog game the same way for
// anyone (blurb, icon; only the blanks), the imports are handed to the jobs worker, and a rulebook upload goes through
// the page service. Stand-ins for BGG, OpenRouter, the Tabler stylesheet and the page service.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timing } from '../src/nathan/openrouter.js';
import { foundIn, planShelfPhoto } from '../src/routes/shelfPhoto.js';
import { THING, searchItemsOf } from './fixtures.js';
import { bearer, fakeDb, fakeJobs, makeAppWith, token } from './helpers.js';

timing.waitMs = 0;
const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const amy = async () => bearer(await token());
const dan = async () => bearer(await token({ email: 'owner@example.com' }));
const ENV = { BGG_TOKEN: 'bgg', OWNER_EMAILS: 'owner@example.com' };
const post = async (app: any, path: string, body: unknown, h: Record<string, string>) =>
  app.request(path, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = async (app: any, path: string, fields: Record<string, string | File>, h: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v as any);
  return app.request(path, { method: 'POST', headers: h, body: fd });
};

// The outside world: BGG, the image service, OpenRouter (icon, blurb, vision), Tabler's stylesheet, the page service
function world(opts: { vision?: any; icon?: string[]; blurb?: any; things?: Record<string, string>; search?: Record<string, string>; pages?: { pages: number; sha256: string } | { error: string } | 'down' } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method || 'GET';
    calls.push({ url: u, method, body: init?.body });
    if (u.includes('xmlapi2/thing')) { const ids = new URL(u).searchParams.get('id')!.split(','); return new Response('<items>' + ids.map((i) => (opts.things || {})[i] || '').join('') + '</items>'); }
    if (u.includes('xmlapi2/search')) { const q = (new URL(u).searchParams.get('query') || '').toLowerCase(); const hit = Object.entries(opts.search || {}).find(([k]) => q.includes(k)); return new Response(hit ? '<items>' + hit[1] + '</items>' : searchItemsOf(opts.things || {})); }
    if (u.includes('api.geekdo.com/api/images/')) return Response.json({ images: { medium: { url: 'https://cf.geekdo-images.com/m.jpg' }, itempage: { url: 'https://cf.geekdo-images.com/l.jpg' } } });
    if (u.includes('tabler-icons.min.css')) return new Response(Array.from({ length: 1200 }, (_, i) => `.ti-icon-${i}:before{content:"x"}`).join('') + '.ti-meeple:before{} .ti-ship:before{} .ti-ship-off:before{} .ti-building-castle:before{}');
    if (u.includes('openrouter.ai')) {
      const body = JSON.parse(init!.body as string);
      const text = typeof body.messages[1]?.content === 'object' ? JSON.stringify(opts.vision ?? { items: [] })
        : body.max_tokens === 1000 ? JSON.stringify({ candidates: opts.icon ?? ['ship-off', 'nope', 'ship'] })
        : JSON.stringify(opts.blurb ?? { genre: 'Trading / Islands', type: 'Dice / Trading', desc: 'Settle an island.' });
      return Response.json({ choices: [{ message: { content: text } }], model: body.model, usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 5 } });
    }
    if (u.startsWith('http://bgc-pages:8000/doc/')) {
      if (method === 'DELETE') return Response.json({ ok: true });
      if (opts.pages === 'down') throw new Error('connect ECONNREFUSED');
      const p = opts.pages ?? { pages: 12, sha256: 'abc' };
      return 'error' in p ? Response.json(p, { status: 400 }) : Response.json(p);
    }
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
// A database where a shelf add lands as a new game that still needs its polish (or not)
function shelfDb(opts: { needsBlurb?: boolean; needsIcon?: boolean; title?: string } = {}) {
  const polished: any[] = [], adds: any[] = [];
  const db = fakeDb({
    'bgc.shelf_add': (p) => { adds.push(p); return { ok: true, added: [{ id: 'recNEW', title: opts.title || 'Azul' }] }; },
    'bgc.game_to_polish': () => ({ ok: true, title: opts.title || 'Azul', genre: '', type: '', description: '', icon: 'meeple', bggId: 77, hasCover: true, needsBlurb: opts.needsBlurb ?? true, needsIcon: opts.needsIcon ?? true }),
    'bgc.polish_game': (p) => { polished.push([p[0], p[1], JSON.parse(p[2] as string)]); return { ok: true }; },
    'bgc.log_ai': () => null,
  });
  return Object.assign(db, { polished, adds });
}
const things = { '77': THING('boardgame', 77, 'Azul', 500) };

test('POST /vault/shelf-add: a new catalog game gets a blurb from BGG\'s description and an icon, for Dan and members alike; only the blanks', async () => {
  for (const who of [amy, dan]) {
    const db = shelfDb();
    const { f, calls } = world({ things });
    const app = makeAppWith({ db, fetch: f, env: ENV });
    const r = await json(await post(app, '/vault/shelf-add', { bggId: 77 }, await who()));
    assert.deepEqual(r.body, { ok: true, added: [{ id: 'recNEW', title: 'Azul' }] });
    assert.equal(db.polished.length, 1);
    assert.equal(db.polished[0][1], 'recNEW');
    assert.deepEqual(db.polished[0][2], { genre: 'Trading / Islands', type: 'Dice / Trading', desc: 'Settle an island.', icon: 'ship' });
    assert.equal(calls.filter((c) => c.url.includes('openrouter')).length, 2, 'one blurb, one icon');
    assert.ok(db.calls.some((c) => c.sql.includes('bgc.log_ai')), 'the AI calls are logged');
  }
  // Already polished (someone else added it before): no AI call, nothing written
  const done = shelfDb({ needsBlurb: false, needsIcon: false });
  const quiet = world({ things });
  await post(makeAppWith({ db: done, fetch: quiet.f, env: ENV }), '/vault/shelf-add', { bggId: 77 }, await amy());
  assert.equal(done.polished.length, 0);
  assert.equal(quiet.calls.filter((c) => c.url.includes('openrouter')).length, 0);
  // A title alone: no BGG description to write from, so no blurb, but still an icon
  const plain = shelfDb({ title: 'Homemade' });
  const w = world();
  await post(makeAppWith({ db: plain, fetch: w.f, env: ENV }), '/vault/shelf-add', { title: 'Homemade' }, await amy());
  assert.deepEqual(plain.polished[0][2], { icon: 'ship' });
  // The polish failing never fails the add
  const broken = fakeDb({ 'bgc.shelf_add': () => ({ ok: true, added: [{ id: 'recNEW', title: 'Azul' }] }), 'bgc.game_to_polish': () => { throw new Error('db hiccup'); } });
  assert.equal((await post(makeAppWith({ db: broken, fetch: w.f, env: ENV }), '/vault/shelf-add', { title: 'Azul' }, await amy())).status, 200);
});

test('foundIn and planShelfPhoto: what the vision model found; owned games skipped, expansions kept, 8 new at most', () => {
  const games = [{ id: 'g1', title: 'Catan', expansions: ['Seafarers'] }, { id: 'g2', title: 'Dune: Imperium', expansions: [] }] as any;
  const { found, reason } = foundIn(JSON.stringify({ items: [
    { title: 'Catan', kind: 'game', confidence: 0.9 }, { title: 'Seafarers', kind: 'expansion' }, { title: 'Immortality', kind: 'expansion', baseGame: 'Dune: Imperium' },
    { title: 'Blurry', confidence: 0.2 }, { title: 'Wingspan', kind: 'game', genre: 'Birds', type: 'Engine', desc: 'Birds.' }, { title: 'Wingspan', kind: 'game' },
    { title: 'Die Siedler', kind: 'game', owned: 'Catan' }] }));
  assert.equal(reason, '');
  assert.equal(found.length, 6);
  const p = planShelfPhoto(found, games);
  assert.deepEqual(p.skipped.map((s) => [s.title, s.reason]), [['Catan', 'already on your shelf'], ['Seafarers', 'already listed as an expansion'], ['Die Siedler', 'already on your shelf']]);
  assert.deepEqual(p.todo.map((t) => [t.title, t.kind, t.genre]), [['Immortality', 'expansion', ''], ['Wingspan', 'game', 'Birds']]);
  assert.deepEqual(p.deferred, []);
});

test('POST /vault/shelf-identify: the photo is read, new titles looked up on BGG and added, polished with the vision model\'s own words', async () => {
  const db = shelfDb();
  (db as any).calls.length = 0;
  const adds: any[] = [];
  const db2 = fakeDb({
    'bgc.shelf': () => ({ records: [{ id: 'recC', fields: { fldOSxvCDWJdYbUZe: 'Catan', fldJ1g6gtxWDwlWsI: 'c1', fldVITaI4eagPe9tS: '[]' } }] }),
    'bgc.shelf_add': (p) => { adds.push(p); return JSON.parse(p[1] as string) ? { ok: true, added: [{ id: 'recA', title: 'Azul' }] } : { ok: false, status: 409, message: '"Homemade" is already on your shelf' }; },
    'bgc.game_to_polish': () => ({ ok: true, title: 'Azul', genre: '', type: '', description: '', icon: 'meeple', needsBlurb: true, needsIcon: true }),
    'bgc.polish_game': (p) => { db.polished.push([p[0], p[1], JSON.parse(p[2] as string)]); return { ok: true }; },
    'bgc.log_ai': () => null,
  });
  const { f, calls } = world({ things, vision: { items: [{ title: 'Catan', kind: 'game' }, { title: 'Azul', kind: 'game', genre: 'Tiles', type: 'Drafting', desc: 'Tiles.' }, { title: 'Homemade', kind: 'game' }] } });
  const app = makeAppWith({ db: db2, fetch: f, env: ENV });
  const photo = new File([new Uint8Array([1, 2, 3])], 'shelf.jpg', { type: 'image/jpeg' });
  assert.deepEqual(await json(await upload(app, '/vault/shelf-identify', {}, await amy())), { status: 400, body: { ok: false, message: 'No photo uploaded' } });
  const r = await json(await upload(app, '/vault/shelf-identify', { photo }, await dan()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.added, [{ id: 'recA', title: 'Azul' }]);
  assert.deepEqual(r.body.skipped.map((s: any) => s.title), ['Catan', 'Homemade']);
  assert.equal(adds.length, 2);
  assert.equal(JSON.parse(adds[0][1]).coverCard, 'https://cf.geekdo-images.com/m.jpg');
  assert.deepEqual([adds[1][1], adds[1][2]], ['null', 'Homemade']); // nothing on BGG: added by title alone
  // The vision model's genre, type and one-liner become the blurb: no second AI call for it, one for the icon
  assert.deepEqual(db.polished[0][2], { genre: 'Tiles', type: 'Drafting', desc: 'Tiles.', icon: 'ship' });
  const ai = calls.filter((c) => c.url.includes('openrouter'));
  assert.equal(ai.length, 2, 'the photo, then the icon');
  assert.ok(String(ai[0].body).includes('"data_collection":"deny"'), 'the photo goes only to providers that don’t keep it');
  const nothing = world({ vision: { items: [], reason: 'too dark' } });
  assert.deepEqual(await json(await upload(makeAppWith({ db: db2, fetch: nothing.f, env: ENV }), '/vault/shelf-identify', { photo }, await amy())), { status: 422, body: { ok: false, message: 'Could not identify a game in that photo: too dark' } });
});

test('POST /vault/import and /shelf-csv: checked as n8n did, started in the database, then handed to the jobs worker', async () => {
  const jobs = fakeJobs();
  const db = fakeDb({ 'bgc.start_import': (p) => (p[1] === 'busy_user' ? { ok: false, message: 'An import is already running' } : { ok: true }),
    'bgc.start_csv': () => ({ ok: true, ids: [13, 77], search: [{ title: 'Nothing', year: null }], alreadyHad: 2 }) });
  const app = makeAppWith({ db, fetch: world().f, env: ENV, jobs });
  assert.deepEqual(await json(await post(app, '/vault/import', { bggUsername: 'x' }, await amy())), { status: 400, body: { ok: false, message: 'Enter your BoardGameGeek username' } });
  assert.deepEqual(await json(await post(app, '/vault/import', { bggUsername: 'busy_user' }, await amy())), { status: 409, body: { ok: false, message: 'An import is already running' } });
  assert.deepEqual(await json(await post(app, '/vault/import', { bggUsername: 'daddo_78' }, await dan())), { status: 200, body: { ok: true, started: true } });
  assert.deepEqual(jobs.runs.at(-1), { name: 'memberPlays', params: { email: 'owner@example.com', username: 'daddo_78' }, wait: false });
  assert.deepEqual(await json(await post(app, '/vault/shelf-csv', { rows: [{ title: '' }] }, await amy())), { status: 400, body: { ok: false, message: 'No game names found in that file' } });
  assert.deepEqual(await json(await post(app, '/vault/shelf-csv', { rows: Array.from({ length: 2001 }, () => ({ title: 'x' })) }, await amy())), { status: 400, body: { ok: false, message: 'That’s more than 2,000 games. Split the file in two.' } });
  const csv = await json(await post(app, '/vault/shelf-csv', { rows: [{ title: ' Catan ', bggId: '13abc', year: '1995' }, { title: 'Nothing' }] }, await amy()));
  assert.deepEqual(csv, { status: 200, body: { ok: true, started: true, matched: 2, lookingUp: 1, alreadyHad: 2 } });
  assert.deepEqual(jobs.runs.at(-1), { name: 'shelfCsv', params: { email: 'amy@example.com', start: { ids: [13, 77], search: [{ title: 'Nothing', year: null }], alreadyHad: 2 } }, wait: false });
  assert.deepEqual(JSON.parse(db.calls.find((c) => c.sql.includes('start_csv'))!.params[1] as string), [{ title: 'Catan', bggId: '13', year: '1995' }, { title: 'Nothing', bggId: '', year: '' }]);
  assert.equal((await post(app, '/vault/sync-plays', {}, await dan())).status, 404, 'the owner-only sync route is gone');
});

test('POST /vault/rulebook: the PDF goes to the page service, the document is queued and the reader poked; what can\'t be queued is dropped again', async () => {
  const jobs = fakeJobs();
  const dropped: unknown[] = [];
  const db = fakeDb({ 'bgc.rule_doc_new': ([, bgg]) => (bgg === 999 ? { ok: false, status: 429, message: 'You’ve added 5 rulebooks today' } : { ok: true, id: 7 }),
    'bgc.rule_doc_stored': ([, pages]) => (Number(pages) > 60 ? { ok: false, status: 413, message: 'That PDF has 90 pages.' } : { ok: true, id: 7, pages }),
    'bgc.rule_doc_drop': (p) => { dropped.push(p); return null; }, 'bgc.rule_docs_of': () => ({ ok: true, docs: [{ id: 7, status: 'queued' }], limits: { mb: 60 } }) });
  const pdf = new File([new TextEncoder().encode('%PDF-1.4 ...')], 'rules.pdf', { type: 'application/pdf' });
  const good = world();
  const app = makeAppWith({ db, fetch: good.f, env: ENV, jobs });
  assert.deepEqual(await json(await upload(app, '/vault/rulebook', { bggId: '13' }, await amy())), { status: 400, body: { ok: false, message: 'Choose a PDF to upload' } });
  assert.deepEqual(await json(await upload(app, '/vault/rulebook', { file: new File(['x'], 'a.txt', { type: 'text/plain' }), bggId: '13' }, await amy())), { status: 400, body: { ok: false, message: 'Rulebooks need to be PDFs' } });
  assert.deepEqual(await json(await upload(app, '/vault/rulebook', { file: pdf }, await amy())), { status: 400, body: { ok: false, message: 'Which game is this for?' } });
  assert.deepEqual(await json(await upload(app, '/vault/rulebook', { file: pdf, bggId: '13', source: 'ftp://x' }, await amy())), { status: 400, body: { ok: false, message: 'The link to the official copy should start with https://' } });
  assert.deepEqual((await json(await upload(app, '/vault/rulebook', { file: pdf, bggId: '999' }, await amy()))).status, 429);
  const r = await json(await upload(app, '/vault/rulebook', { file: pdf, bggId: '13', gameTitle: 'Catan', kind: 'faq', title: ' FAQ ', source: 'https://example.com/rules.pdf' }, await amy()));
  assert.deepEqual(r, { status: 200, body: { ok: true, docs: [{ id: 7, status: 'queued' }], limits: { mb: 60 }, queued: 7 } });
  assert.equal(good.calls.find((c) => c.method === 'PUT')!.url, 'http://bgc-pages:8000/doc/7');
  assert.deepEqual(jobs.runs.at(-1), { name: 'ruleReader', params: {}, wait: false });
  assert.deepEqual(db.calls.filter((c) => c.sql.includes('rule_doc_new')).at(-1)!.params, ['amy@example.com', 13, 'Catan', 'faq', ' FAQ ', 'https://example.com/rules.pdf']);
  const long = world({ pages: { pages: 90, sha256: 'x' } });
  assert.deepEqual(await json(await upload(makeAppWith({ db, fetch: long.f, env: ENV, jobs }), '/vault/rulebook', { file: pdf, bggId: '13' }, await amy())), { status: 413, body: { ok: false, message: 'That PDF has 90 pages.' } });
  assert.ok(long.calls.some((c) => c.method === 'DELETE' && c.url === 'http://bgc-pages:8000/doc/7'));
  assert.deepEqual(dropped.at(-1), [7]);
  const down = world({ pages: 'down' });
  const d = await json(await upload(makeAppWith({ db, fetch: down.f, env: ENV, jobs }), '/vault/rulebook', { file: pdf, bggId: '13' }, await amy()));
  assert.equal(d.status, 400);
  assert.match(d.body.message, /page service didn’t answer/);
});
