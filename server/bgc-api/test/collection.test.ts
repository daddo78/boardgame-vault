// The last of n8n's work on the API: adding to Dan's collection (by name, from a photo), a member's photo, the imports
// handed to the jobs worker, and uploading a rulebook. Stand-ins for BGG, OpenRouter, the Tabler stylesheet and the
// page service; an Airtable-shaped store behind at.request.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { F, GAMES_TABLE } from '../src/fields.js';
import { timing } from '../src/nathan/openrouter.js';
import { planCollectionPhoto, foundIn } from '../src/routes/collection.js';
import { THING, searchItemsOf } from './fixtures.js';
import { bearer, fakeDb, fakeJobs, makeAppWith, token } from './helpers.js';

timing.waitMs = 0;
const OWNER = 'owner@example.com';
const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const dan = async () => bearer(await token({ email: OWNER }));
const amy = async () => bearer(await token());

const game = (id: string, title: string, bggId: number | null, extra: Record<string, unknown> = {}) =>
  ({ id: 'rec' + id.padEnd(14, 'x'), fields: { [F.title]: title, [F.gameId]: id, [F.num]: Number(id.replace(/\D/g, '')) || 1, [F.bggId]: bggId, [F.expansions]: '[]', [F.icon]: 'meeple', ...extra } });

// A database with Dan's games behind at.request
function store(games: any[], over: Record<string, (p: unknown[]) => unknown> = {}) {
  const t: any[] = [...games];
  let n = 0;
  const atRequest = ([, method, path, body]: unknown[]) => {
    const b = body === 'null' ? null : JSON.parse(body as string);
    if (method === 'GET') {
      const m = /\{GameID\}='([^']+)'/.exec(String(arguments[0]?.[4] ?? ''));
      return { records: t };
    }
    if (method === 'POST') { const made = b.records.map((r: any) => ({ id: 'recNew' + (++n), fields: r.fields })); t.push(...made); return { records: made }; }
    if (method === 'PATCH') { const list = path ? [{ id: String(path).slice(1), fields: b.fields }] : b.records; for (const r of list) { const rec = t.find((x) => x.id === r.id); if (rec) Object.assign(rec.fields, r.fields); } return { records: list }; }
    if (method === 'DELETE') { const i = t.findIndex((x) => x.id === String(path).slice(1)); if (i >= 0) t.splice(i, 1); return { deleted: true }; }
    return null;
  };
  // A lookup by GameID: the record whose id matches (the adapter's formula)
  const db = fakeDb({ 'at.request': (p) => { const formula = String(p[4] || ''); const m = /\{GameID\}='([^']+)'/.exec(formula); if (m) return { records: t.filter((x) => x.fields[F.gameId] === m[1]) }; return atRequest(p); }, 'bgc.log_ai': () => null, ...over });
  return Object.assign(db, { t });
}

// The outside world: BGG, the image service, OpenRouter (the icon, the blurb, the vision model), Tabler's stylesheet, the page service
function world(opts: { vision?: any; icon?: string[]; blurb?: any; things?: Record<string, string>; search?: Record<string, string>; pages?: { pages: number; sha256: string } | { error: string } | 'down' } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method || 'GET';
    calls.push({ url: u, method, body: init?.body });
    if (u.includes('xmlapi2/thing')) { const ids = new URL(u).searchParams.get('id')!.split(','); return new Response('<items>' + ids.map((i) => (opts.things || {})[i] || '').join('') + '</items>'); }
    if (u.includes('xmlapi2/search')) { const q = (new URL(u).searchParams.get('query') || '').toLowerCase(); const hit = Object.entries(opts.search || {}).find(([k]) => q.includes(k)); return new Response(hit ? '<items>' + hit[1] + '</items>' : searchItemsOf(opts.things || {})); }
    if (u.includes('xmlapi2/plays')) return new Response('<plays total="1" page="1"><play id="1" date="2026-10-01" quantity="1"><item objectid="13"/></play></plays>');
    if (u.includes('api.geekdo.com/api/images/')) return Response.json({ images: { medium: { url: 'https://cf.geekdo-images.com/m.jpg' }, itempage: { url: 'https://cf.geekdo-images.com/l.jpg' } } });
    if (u.includes('tabler-icons.min.css')) return new Response(Array.from({ length: 1200 }, (_, i) => `.ti-icon-${i}:before{content:"x"}`).join('') + '.ti-meeple:before{} .ti-ship:before{} .ti-ship-off:before{} .ti-building-castle:before{}');
    if (u.includes('openrouter.ai')) {
      const body = JSON.parse(init!.body as string);
      const text = typeof body.messages[1]?.content === 'object' || typeof body.messages[0]?.content === 'object' ? JSON.stringify(opts.vision ?? { items: [] })
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
const ENV = { BGG_TOKEN: 'bgg', OWNER_EMAILS: OWNER, BGG_USERNAME: 'daddo_78' };
const post = async (app: any, path: string, body: unknown, h: Record<string, string>) =>
  app.request(path, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = async (app: any, path: string, fields: Record<string, string | File>, h: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v as any);
  return app.request(path, { method: 'POST', headers: h, body: fd });
};

test('POST /vault/add: a game not on BGG is created with the next number and an icon; owners only', async () => {
  const db = store([game('manual-g1', 'Azul', 230802)]);
  const { f, calls } = world();
  const app = makeAppWith({ db, fetch: f, env: ENV });
  assert.equal((await post(app, '/vault/add', { title: 'Homemade' }, await amy())).status, 401);
  const r = await json(await post(app, '/vault/add', { title: 'Homemade' }, await dan()));
  assert.deepEqual(r, { status: 200, body: { ok: true, added: [{ id: 'name-g2', title: 'Homemade' }], expansions: [], skipped: [], title: 'Homemade' } });
  const made = db.t.find((x) => x.fields[F.gameId] === 'name-g2');
  assert.deepEqual([made.fields[F.title], made.fields[F.num], made.fields[F.icon], made.fields[F.genre]], ['Homemade', 2, 'ship', '']);
  assert.ok(!calls.some((c) => c.url.includes('xmlapi2')), 'no BGG for a title-only game');
  assert.deepEqual(await json(await post(app, '/vault/add', {}, await dan())), { status: 400, body: { ok: false, message: 'Send a bggId, or a title for a game that is not on BGG' } });
});

test('POST /vault/add by BGG id: refused when owned; an expansion of an owned game is listed under it; a new game gets a blurb, BGG details, art, plays and an icon', async () => {
  const db = store([game('manual-g1', 'Catan', 13)]);
  const things = { '13': THING('boardgame', 13, 'Catan', 100), '325': THING('boardgameexpansion', 325, 'Catan: Seafarers', 20, '<link type="boardgameexpansion" id="13" value="Catan" inbound="true"/>'), '77': THING('boardgame', 77, 'Azul', 500) };
  const { f } = world({ things });
  const app = makeAppWith({ db, fetch: f, env: ENV });
  assert.deepEqual(await json(await post(app, '/vault/add', { bggId: 13 }, await dan())), { status: 409, body: { ok: false, message: '"Catan" is already in your collection' } });
  assert.deepEqual(await json(await post(app, '/vault/add', { bggId: 999 }, await dan())), { status: 404, body: { ok: false, message: 'BGG has no game #999' } });
  const exp = await json(await post(app, '/vault/add', { bggId: 325 }, await dan()));
  assert.deepEqual(exp.body, { ok: true, added: [], expansions: [{ title: 'Catan: Seafarers', base: 'Catan' }], skipped: [] });
  assert.equal(db.t[0].fields[F.expansions], '["Catan: Seafarers"]');
  assert.deepEqual(await json(await post(app, '/vault/add', { bggId: 325 }, await dan())), { status: 409, body: { ok: false, message: '"Catan: Seafarers" is already listed as an expansion of Catan' } });
  const r = await json(await post(app, '/vault/add', { bggId: 77 }, await dan()));
  assert.deepEqual(r.body, { ok: true, added: [{ id: 'name-g2', title: 'Azul' }], expansions: [], skipped: [], title: 'Azul' });
  const azul = db.t.find((x) => x.fields[F.gameId] === 'name-g2').fields;
  assert.deepEqual([azul[F.genre], azul[F.type], azul[F.desc]], ['Trading / Islands', 'Dice / Trading', 'Settle an island.']);
  assert.deepEqual([azul[F.bggId], azul[F.bggRating], azul[F.year], azul[F.coverCard], azul[F.playCount], azul[F.icon]], [77, 7.1, 1995, 'https://cf.geekdo-images.com/m.jpg', 1, 'ship']);
  assert.ok(db.calls.filter((c) => c.sql.includes('bgc.log_ai')).length >= 1, 'the AI calls are logged');
});

test('foundIn and planCollectionPhoto: what the vision model found; owned, expansions, new games (8 at most)', () => {
  const games = [game('manual-g1', 'Catan', 13), game('manual-g2', 'Dune: Imperium', 316554, { [F.expansions]: '["Rise of Ix"]' })].map((r) => ({ ...r.fields, id: r.fields[F.gameId], recordId: r.id, title: r.fields[F.title], num: r.fields[F.num], bggId: r.fields[F.bggId], expansions: JSON.parse(r.fields[F.expansions] as string) })) as any;
  const { found, reason } = foundIn(JSON.stringify({ items: [
    { title: 'Catan', kind: 'game', confidence: 0.9 }, { title: 'Rise of Ix', kind: 'expansion' }, { title: 'Immortality', kind: 'expansion', baseGame: 'Dune: Imperium' },
    { title: 'Blurry', confidence: 0.2 }, { title: 'Wingspan', kind: 'game', genre: 'Birds', type: 'Engine', desc: 'Birds.' }, { title: 'Wingspan', kind: 'game' },
    { title: 'Die Siedler', kind: 'game', owned: 'Catan' }, { title: 'Seafarers', kind: 'expansion', owned: 'Catan' }] }));
  assert.equal(reason, '');
  assert.equal(found.length, 7); // the blurry one is out
  const p = planCollectionPhoto(found, games);
  assert.deepEqual(p.skipped.map((s) => [s.title, s.reason]), [['Catan', 'already in your collection'], ['Rise of Ix', 'already listed as an expansion'], ['Die Siedler', 'already in your collection']]);
  assert.deepEqual(p.expansions, [{ title: 'Immortality', base: 'Dune: Imperium' }, { title: 'Seafarers', base: 'Catan' }]);
  assert.deepEqual(p.creates.map((c) => [c.gameId, c.title, c.fields[F.genre]]), [['photo-g3', 'Wingspan', 'Birds']]);
  assert.equal(p.expRecords.length, 2);
  assert.deepEqual(JSON.parse(p.expRecords[0].fields[F.expansions] as string), ['Rise of Ix', 'Immortality']);
});

test('POST /vault/identify: the photo is read, new games created and enriched, a duplicate by BGG id taken back out, icons assigned', async () => {
  const db = store([game('manual-g1', 'Catan', 13)]);
  const things = { '77': THING('boardgame', 77, 'Azul', 500), '13': THING('boardgame', 13, 'Catan', 100) };
  const { f, calls } = world({ things, search: { siedler: '<item type="boardgame" id="13"><name type="alternate" value="Die Siedler von Catan"/></item>' }, vision: { items: [{ title: 'Azul', kind: 'game', genre: 'Tiles', type: 'Drafting', desc: 'Tiles.' }, { title: 'Die Siedler von Catan', kind: 'game' }] } });
  const app = makeAppWith({ db, fetch: f, env: ENV });
  const photo = new File([new Uint8Array([255, 216, 255])], 'boxes.jpg', { type: 'image/jpeg' });
  assert.equal((await upload(app, '/vault/identify', { photo }, await amy())).status, 401);
  assert.deepEqual(await json(await upload(app, '/vault/identify', {}, await dan())), { status: 400, body: { ok: false, message: 'No photo uploaded' } });
  // Azul is new; "Die Siedler von Catan" turns out to be BGG #13, which Dan owns (the search answers Catan for it)
  const r = await json(await upload(app, '/vault/identify', { photo }, await dan()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.added, [{ id: 'photo-g2', title: 'Azul' }]);
  assert.deepEqual(r.body.skipped, [{ title: 'Die Siedler von Catan', reason: 'same BGG game as one you own', existing: 'Catan' }]);
  assert.equal(db.t.length, 2, 'the duplicate was deleted again');
  const azul = db.t.find((x) => x.fields[F.gameId] === 'photo-g2').fields;
  assert.deepEqual([azul[F.genre], azul[F.bggId], azul[F.coverCard], azul[F.icon]], ['Tiles', 77, 'https://cf.geekdo-images.com/m.jpg', 'ship']);
  const vision = calls.find((c) => c.url.includes('openrouter') && String(c.body).includes('image_url'));
  assert.ok(vision && String(vision.body).includes('"data_collection":"deny"'), 'the photo goes only to providers that don’t keep it');
  const nothing = world({ vision: { items: [], reason: 'too dark' } });
  assert.deepEqual(await json(await upload(makeAppWith({ db, fetch: nothing.f, env: ENV }), '/vault/identify', { photo }, await dan())), { status: 422, body: { ok: false, message: 'Could not identify a game in that photo: too dark' } });
});

test('POST /vault/shelf-identify: a member\'s photo; new titles looked up on BGG and added through bgc.shelf_add, owned ones skipped', async () => {
  const adds: any[] = [];
  const db = fakeDb({ 'bgc.shelf': () => ({ records: [game('mine-1', 'Catan', 13)] }), 'bgc.shelf_add': (p) => { adds.push(p); return JSON.parse(p[1] as string) ? { ok: true, added: [{ id: 'recA', title: 'Azul' }] } : { ok: false, status: 409, message: '"Homemade" is already on your shelf' }; }, 'bgc.log_ai': () => null });
  const { f } = world({ things: { '77': THING('boardgame', 77, 'Azul', 500) }, vision: { items: [{ title: 'Catan', kind: 'game' }, { title: 'Azul', kind: 'game' }, { title: 'Homemade', kind: 'game' }] } });
  const app = makeAppWith({ db, fetch: f, env: ENV });
  const photo = new File([new Uint8Array([1, 2, 3])], 'shelf.jpg', { type: 'image/jpeg' });
  const r = await json(await upload(app, '/vault/shelf-identify', { photo }, await amy()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.added, [{ id: 'recA', title: 'Azul' }]);
  assert.deepEqual(r.body.skipped.map((s: any) => s.title), ['Catan', 'Homemade']);
  assert.equal(adds.length, 2);
  assert.equal(JSON.parse(adds[0][1]).coverCard, 'https://cf.geekdo-images.com/m.jpg');
  assert.deepEqual([adds[1][1], adds[1][2]], ['null', 'Homemade']); // nothing on BGG: added by title alone
});

test('POST /vault/import and /shelf-csv: checked as n8n did, started in the database, then handed to the jobs worker; /sync-plays waits for the worker', async () => {
  const jobs = fakeJobs({ syncPlays: { totalPlays: 3, updated: 1 } });
  const started: any[] = [];
  const db = fakeDb({ 'bgc.start_import': (p) => { started.push(p); return p[1] === 'busy_user' ? { ok: false, message: 'An import is already running' } : { ok: true }; },
    'bgc.start_csv': () => ({ ok: true, ids: [13, 77], search: [{ title: 'Nothing', year: null }], alreadyHad: 2 }) });
  const app = makeAppWith({ db, fetch: world().f, env: ENV, jobs });
  assert.deepEqual(await json(await post(app, '/vault/import', { bggUsername: 'x' }, await amy())), { status: 400, body: { ok: false, message: 'Enter your BoardGameGeek username' } });
  assert.deepEqual(await json(await post(app, '/vault/import', { bggUsername: 'busy_user' }, await amy())), { status: 409, body: { ok: false, message: 'An import is already running' } });
  assert.deepEqual(await json(await post(app, '/vault/import', { bggUsername: 'amy_b' }, await amy())), { status: 200, body: { ok: true, started: true } });
  assert.deepEqual(jobs.runs.at(-1), { name: 'memberPlays', params: { email: 'amy@example.com', username: 'amy_b' }, wait: false });
  assert.deepEqual(await json(await post(app, '/vault/shelf-csv', { rows: [{ title: '' }] }, await amy())), { status: 400, body: { ok: false, message: 'No game names found in that file' } });
  assert.deepEqual(await json(await post(app, '/vault/shelf-csv', { rows: Array.from({ length: 2001 }, () => ({ title: 'x' })) }, await amy())), { status: 400, body: { ok: false, message: 'That’s more than 2,000 games. Split the file in two.' } });
  const csv = await json(await post(app, '/vault/shelf-csv', { rows: [{ title: ' Catan ', bggId: '13abc', year: '1995' }, { title: 'Nothing' }] }, await amy()));
  assert.deepEqual(csv, { status: 200, body: { ok: true, started: true, matched: 2, lookingUp: 1, alreadyHad: 2 } });
  assert.deepEqual(jobs.runs.at(-1), { name: 'shelfCsv', params: { email: 'amy@example.com', start: { ids: [13, 77], search: [{ title: 'Nothing', year: null }], alreadyHad: 2 } }, wait: false });
  assert.deepEqual(JSON.parse(db.calls.find((c) => c.sql.includes('start_csv'))!.params[1] as string), [{ title: 'Catan', bggId: '13', year: '1995' }, { title: 'Nothing', bggId: '', year: '' }]);
  assert.equal((await post(app, '/vault/sync-plays', {}, await amy())).status, 401);
  assert.deepEqual(await json(await post(app, '/vault/sync-plays', {}, await dan())), { status: 200, body: { ok: true, totalPlays: 3, updated: 1 } });
  assert.deepEqual(jobs.runs.at(-1), { name: 'syncPlays', params: {}, wait: true });
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
  const put = good.calls.find((c) => c.method === 'PUT');
  assert.equal(put!.url, 'http://bgc-pages:8000/doc/7');
  assert.deepEqual(jobs.runs.at(-1), { name: 'ruleReader', params: {}, wait: false });
  assert.deepEqual(db.calls.filter((c) => c.sql.includes('rule_doc_new')).at(-1)!.params, ['amy@example.com', 13, 'Catan', 'faq', ' FAQ ', 'https://example.com/rules.pdf']);
  // Too long: the page service lets go of the file and the half-made document goes
  const long = world({ pages: { pages: 90, sha256: 'x' } });
  assert.deepEqual(await json(await upload(makeAppWith({ db, fetch: long.f, env: ENV, jobs }), '/vault/rulebook', { file: pdf, bggId: '13' }, await amy())), { status: 413, body: { ok: false, message: 'That PDF has 90 pages.' } });
  assert.ok(long.calls.some((c) => c.method === 'DELETE' && c.url === 'http://bgc-pages:8000/doc/7'));
  assert.deepEqual(dropped.at(-1), [7]);
  // The page service down: a plain 400, nothing left behind
  const down = world({ pages: 'down' });
  const d = await json(await upload(makeAppWith({ db, fetch: down.f, env: ENV, jobs }), '/vault/rulebook', { file: pdf, bggId: '13' }, await amy()));
  assert.equal(d.status, 400);
  assert.match(d.body.message, /page service didn’t answer/);
});
