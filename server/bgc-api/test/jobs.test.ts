// The jobs worker: when schedules are due, how runs are recorded and failures emailed, and each job against a stand-in
// BGG, OpenRouter, page service and database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bgg } from '../src/bgg.js';
import { loadConfig } from '../src/config.js';
import { F, GAMES_TABLE, PF, PLAYERS_TABLE, RATINGS_TABLE, RF } from '../src/fields.js';
import { aiUsage } from '../src/jobs/aiUsage.js';
import { fillCatalog } from '../src/jobs/fillCatalog.js';
import { healthCheck, healthProblems } from '../src/jobs/healthCheck.js';
import { memberPlays, memberPlaysNightly } from '../src/jobs/memberPlays.js';
import { cleanMarkdown, ruleReader, splitSections } from '../src/jobs/ruleReader.js';
import { Runner } from '../src/jobs/runner.js';
import { clock, isDue } from '../src/jobs/schedule.js';
import { PAUSE_MS, askOne, selfTest } from '../src/jobs/selfTest.js';
import { shelfCsv } from '../src/jobs/shelfCsv.js';
import { syncPeople } from '../src/jobs/syncPeople.js';
import { syncPlays } from '../src/jobs/syncPlays.js';
import type { Job, JobCtx } from '../src/jobs/types.js';
import { timing } from '../src/nathan/openrouter.js';
import { THING, searchItemsOf } from './fixtures.js';
import { fakeDb } from './helpers.js';

timing.waitMs = 0;
PAUSE_MS.between = 0;

const ENV = { DATABASE_URL: 'postgres://unused', OPENROUTER_API_KEY: 'sk-test', BGG_TOKEN: 'bgg', OWNER_EMAILS: 'dandehaan@gmail.com', BGG_USERNAME: 'daddo_78', JOBS_TZ: 'America/Detroit', PAGES_URL: 'http://pages:8000' };

test('schedule: a daily job is due at its time, once a day, and still within two hours if the worker was down; hourly and every-N-minutes likewise', () => {
  const tz = 'America/Detroit';
  const at = (iso: string) => clock(new Date(iso), tz);
  // 04:00 Detroit in October (EDT) is 08:00 UTC
  assert.equal(at('2026-10-25T08:00:00Z').minute, 4 * 60);
  assert.equal(at('2026-10-25T08:00:00Z').day, '2026-10-25');
  const daily = { at: '04:00' };
  assert.equal(isDue(daily, at('2026-10-25T07:59:30Z'), null), false);
  assert.equal(isDue(daily, at('2026-10-25T08:00:10Z'), null), true);
  assert.equal(isDue(daily, at('2026-10-25T08:00:40Z'), at('2026-10-25T08:00:10Z')), false); // already ran today
  assert.equal(isDue(daily, at('2026-10-25T09:30:00Z'), at('2026-10-24T08:00:10Z')), true);  // missed, within two hours
  assert.equal(isDue(daily, at('2026-10-25T10:30:00Z'), at('2026-10-24T08:00:10Z')), false); // too late, tomorrow then
  assert.equal(isDue(daily, at('2026-10-26T08:00:10Z'), at('2026-10-25T08:00:10Z')), true);  // the next day
  const hourly = { hourlyAt: 7 };
  assert.equal(isDue(hourly, at('2026-10-25T08:06:00Z'), null), false);
  assert.equal(isDue(hourly, at('2026-10-25T08:07:00Z'), null), true);
  assert.equal(isDue(hourly, at('2026-10-25T08:40:00Z'), at('2026-10-25T08:07:00Z')), false);
  assert.equal(isDue(hourly, at('2026-10-25T09:07:00Z'), at('2026-10-25T08:07:00Z')), true);
  const every = { everyMinutes: 10 };
  assert.equal(isDue(every, at('2026-10-25T08:00:00Z'), null), true);
  assert.equal(isDue(every, at('2026-10-25T08:09:00Z'), at('2026-10-25T08:00:00Z')), false);
  assert.equal(isDue(every, at('2026-10-25T08:10:00Z'), at('2026-10-25T08:00:00Z')), true);
});

// A database for the jobs: fakeDb's answers by SQL substring, plus a tiny Airtable-shaped store behind at.request
function jobsDb(over: Record<string, (p: unknown[]) => unknown> = {}, store: Record<string, any[]> = {}) {
  const recId = () => 'rec' + Math.random().toString(36).slice(2, 16).padEnd(14, 'x');
  const atRequest = ([table, method, path, body]: unknown[]) => {
    const t = (store[table as string] ??= []);
    const b = body === 'null' ? null : JSON.parse(body as string);
    if (method === 'GET') return { records: t };
    if (method === 'POST') { const made = b.records.map((r: any) => ({ id: recId(), fields: r.fields })); t.push(...made); return { records: made }; }
    if (method === 'PATCH') {
      const list = path ? [{ id: String(path).slice(1), fields: b.fields }] : b.records;
      for (const r of list) {
        let rec = t.find((x: any) => x.id === r.id);
        if (!rec && b.performUpsert) { const key = b.performUpsert.fieldsToMergeOn[0]; rec = t.find((x: any) => x.fields[key] === r.fields[key]); }
        if (rec) Object.assign(rec.fields, r.fields); else t.push({ id: r.id || recId(), fields: r.fields });
      }
      return { records: list };
    }
    if (method === 'DELETE') { const i = t.findIndex((x: any) => x.id === String(path).slice(1)); if (i >= 0) t.splice(i, 1); return { deleted: true }; }
    return null;
  };
  const db = fakeDb({ 'at.request': atRequest, 'INSERT INTO job_runs': () => 1, 'UPDATE job_runs': () => null, ...over, 'bgc.log_ai': () => null });
  return Object.assign(db, { store });
}
const game = (id: string, title: string, bggId: number | null, extra: Record<string, unknown> = {}) => ({ id: 'rec' + id.padEnd(14, 'x'), fields: { [F.title]: title, [F.gameId]: id, [F.num]: Number(id.replace(/\D/g, '')) || 1, [F.bggId]: bggId, [F.playCount]: 0, ...extra } });

// Fetch for the jobs: BGG, the image service, OpenRouter (answers by what's asked), the page service
function jobsFetch(opts: { plays?: string[]; openrouter?: (body: any) => any; pages?: Record<string, any>; key?: any; credits?: any; things?: Record<string, string> } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push({ url: u, method, body: init?.body });
    const q = new URL(u).searchParams;
    if (u.includes('xmlapi2/plays')) { const page = Number(q.get('page') || 1); return new Response((opts.plays || ['<plays></plays>'])[page - 1] || '<plays></plays>'); }
    if (u.includes('xmlapi2/thing')) return new Response('<items>' + q.get('id')!.split(',').map((i) => (opts.things || {})[i] || '').join('') + '</items>');
    if (u.includes('xmlapi2/search')) return new Response(searchItemsOf(opts.things || {}));
    if (u.includes('xmlapi2/collection')) return new Response('<items><item objecttype="thing" objectid="13"><stats><rating value="8"/></stats></item><item objecttype="thing" objectid="77"><stats><rating value="6"/></stats></item></items>');
    if (u.includes('api.geekdo.com/api/images/')) return Response.json({ images: { medium: { url: 'https://cf.geekdo-images.com/m.jpg' }, itempage: { url: 'https://cf.geekdo-images.com/l.jpg' } } });
    if (u.includes('openrouter.ai/api/v1/chat/completions')) {
      const body = JSON.parse(init!.body as string);
      const content = opts.openrouter ? opts.openrouter(body) : '{}';
      return Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], model: body.model, usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 5 } });
    }
    if (u.includes('openrouter.ai/api/v1/key')) return Response.json({ data: opts.key ?? { usage: 4.78, limit: 10 } });
    if (u.includes('openrouter.ai/api/v1/credits')) return Response.json({ data: opts.credits ?? { total_credits: 20, total_usage: 6.1 } });
    if (u.startsWith('http://pages:8000/doc/')) {
      if (method === 'DELETE') return Response.json({ ok: true });
      const m = u.match(/\/page\/(\d+)$/);
      const p = (opts.pages || {})[m ? m[1] : ''];
      return p ? Response.json(p) : new Response('{"error":"no such page"}', { status: 404 });
    }
    if (u.includes('api.resend.com')) return Response.json({ id: 'mail' });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
function ctxWith(db: any, f: typeof fetch, env: Record<string, string> = {}) {
  const config = loadConfig({ ...ENV, ...env });
  const mails: any[] = [];
  const ctx: JobCtx = { db, fetch: f, config, bgg: new Bgg(f, config.bggToken, 0), mail: async (m) => { mails.push(m); return true; } };
  return { ctx, mails, config };
}

test('runner: a run is recorded in job_runs; a failure is recorded, emailed once per 30 minutes, and the job can run again', async () => {
  const runs: any[] = [];
  const db = jobsDb({ 'INSERT INTO job_runs': (p) => { runs.push({ start: p }); return 42; }, 'UPDATE job_runs': (p) => { runs.push({ end: p }); return null; } });
  const { f } = jobsFetch();
  const { ctx, mails } = ctxWith(db, f);
  let fail = true;
  const flaky: Job = { name: 'flaky', async run() { if (fail) throw new Error('BGG is down'); return { fine: true }; } };
  const slow: Job = { name: 'slow', async run() { await new Promise((r) => setTimeout(r, 30)); return 'done'; } };
  const runner = new Runner(ctx, [flaky, slow], 'dan@example.com');
  const r1 = await runner.run('flaky', {}, 'run');
  assert.deepEqual([r1.ok, r1.error], [false, 'Error: BGG is down']);
  assert.deepEqual(runs[0].start, ['flaky', 'run']);
  assert.deepEqual(runs[1].end.slice(0, 1), [42]);
  assert.match(runs[1].end[1], /BGG is down/);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /"flaky" failed/);
  await runner.run('flaky', {}, 'run');
  assert.equal(mails.length, 1, 'one email per job per 30 minutes');
  fail = false;
  const r2 = await runner.run('flaky', {}, 'schedule');
  assert.deepEqual(r2, { ok: true, result: { fine: true } });
  assert.deepEqual(JSON.parse(runs.at(-1).end[1]), { fine: true });
  // A job mustn't overlap itself
  const a = runner.run('slow', {}, 'run');
  const b = await runner.run('slow', {}, 'run');
  assert.deepEqual([b.ok, b.skipped], [false, 'running']);
  assert.deepEqual(await a, { ok: true, result: 'done' });
  assert.deepEqual((await runner.run('nope', {}, 'run')).skipped, 'unknown');
  await runner.stop(10);
});

test('runner.tick: due schedules start, and not twice for the same minute', async () => {
  const db = jobsDb();
  const { f } = jobsFetch();
  const { ctx } = ctxWith(db, f);
  let n = 0;
  const daily: Job = { name: 'daily', schedule: { at: '04:00' }, async run() { n++; return n; } };
  const runner = new Runner(ctx, [daily], undefined);
  runner.tick(new Date('2026-10-25T07:00:00Z'));
  runner.tick(new Date('2026-10-25T08:00:05Z'));
  runner.tick(new Date('2026-10-25T08:00:35Z'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(n, 1);
  await runner.stop(10);
});

test('healthProblems: quiet when the backup is fresh and plays are coming in; otherwise one line each', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.deepEqual(healthProblems({ last_ok: '2026-10-25T09:30:00Z', last_error: null, last_fail: null, newest_play: '2026-10-24' }, now), []);
  const p = healthProblems({ last_ok: '2026-10-23T09:30:00Z', last_error: 'push failed', last_fail: '2026-10-24T09:30:00Z', newest_play: '2026-10-10' }, now);
  assert.equal(p.length, 2);
  assert.match(p[0], /has not succeeded since 2026-10-23/);
  assert.match(p[0], /Last error: push failed/);
  assert.match(p[1], /No new plays have come in since 2026-10-10/);
});

test('healthCheck job: emails Dan only when there is something to look at', async () => {
  const fresh = jobsDb();
  (fresh as any).row = async () => ({ last_ok: new Date().toISOString(), last_error: null, last_fail: null, newest_play: new Date().toISOString().slice(0, 10) });
  const { f } = jobsFetch();
  const a = ctxWith(fresh, f);
  assert.deepEqual(await healthCheck.run(a.ctx, {}), { problems: 0 });
  assert.equal(a.mails.length, 0);
  const stale = jobsDb();
  (stale as any).row = async () => ({ last_ok: null, last_error: null, last_fail: null, newest_play: null });
  const b = ctxWith(stale, f);
  const r: any = await healthCheck.run(b.ctx, {});
  assert.deepEqual([r.problems, r.emailed, b.mails[0].to, b.mails[0].subject], [2, true, 'dandehaan@gmail.com', 'Board Game Curator: 2 things to look at']);
});

test('aiUsage job: the key\'s spending and the account\'s balance go to bgc.log_usage; nothing from OpenRouter is an error', async () => {
  const logged: unknown[] = [];
  const db = jobsDb({ 'bgc.log_usage': (p) => { logged.push(p); return null; } });
  const { f } = jobsFetch();
  const { ctx } = ctxWith(db, f);
  assert.deepEqual(await aiUsage.run(ctx, {}), { keyUsage: 4.78, keyLimit: 10, creditsTotal: 20, creditsUsed: 6.1 });
  assert.deepEqual(logged[0], [4.78, 10, 20, 6.1]);
  const none = jobsFetch({ key: {}, credits: {} });
  await assert.rejects(aiUsage.run(ctxWith(db, none.f).ctx, {}), /didn’t answer/);
});

const PLAYS = ['<plays total="3" page="1"><play id="101" date="2026-10-01" quantity="2" length="45"><item name="Catan" objecttype="thing" objectid="13"/><players><player username="daddo_78" name="Dan" win="1"/><player name="Matt" win="0"/></players></play>' +
  '<play id="102" date="2026-09-01" quantity="1"><item name="Catan 3D" objecttype="thing" objectid="999"/><players><player name="Dan" win="0"/><player name="Keith" win="1"/></players></play></plays>', '<plays total="3" page="2"></plays>'];

test('syncPlays job: Dan\'s plays saved, each game\'s count and last played updated, other editions counted in', async () => {
  const saved: any[] = [];
  const db = jobsDb({ 'at.save_plays': (p) => { saved.push(p); return { plays: 2, newPlays: 2 }; } },
    { [GAMES_TABLE]: [game('g1', 'Catan', 13, { [F.extraBggIds]: '999', [F.playCount]: 1, [F.lastPlayed]: '2026-01-01' }), game('g2', 'Azul', 230802), game('g3', 'Homemade', null)] });
  const { f } = jobsFetch({ plays: PLAYS });
  const { ctx } = ctxWith(db, f);
  const r: any = await syncPlays.run(ctx, {});
  assert.deepEqual([r.totalPlays, r.gamesPlayedOnBgg, r.matchedInCollection, r.updated, r.stored], [3, 2, 1, 1, { plays: 2, newPlays: 2 }]);
  assert.equal(saved[0][0], 'dandehaan@gmail.com');
  assert.equal(JSON.parse(saved[0][1]).length, 2);
  const catan = db.store[GAMES_TABLE][0].fields;
  assert.deepEqual([catan[F.playCount], catan[F.lastPlayed]], [3, '2026-10-01']);
  assert.equal(db.store[GAMES_TABLE][1].fields[F.playCount], 0, 'unplayed stays as it was');
});

test('syncPeople job: a card for everyone played with, histories per owned game, friends\' BGG ratings as half stars', async () => {
  const db = jobsDb({ 'at.save_plays': () => ({ plays: 0, newPlays: 0 }) }, {
    [GAMES_TABLE]: [game('g1', 'Catan', 13, { [F.extraBggIds]: '999' }), game('g2', 'Azul', 77)],
    [PLAYERS_TABLE]: [{ id: 'recDan', fields: { [PF.name]: 'Dan', [PF.bggUsername]: 'daddo_78', [PF.playHistory]: '{}' } }],
  });
  const { f, calls } = jobsFetch({ plays: PLAYS });
  const { ctx } = ctxWith(db, f);
  const r: any = await syncPeople.run(ctx, {});
  assert.deepEqual([r.people, r.playersCreated, r.historiesUpdated, r.bggRatings], [3, 2, 3, 2]); // the two new cards get histories too
  const players = db.store[PLAYERS_TABLE];
  assert.deepEqual(players.map((p: any) => p.fields[PF.name]).sort(), ['Dan', 'Keith', 'Matt']);
  assert.equal(players.find((p: any) => p.fields[PF.name] === 'Keith').fields[PF.active], false);
  // Dan: 2 plays of Catan (13) + 1 of its other edition (999) -> 3 under Catan's own id, 2 wins
  assert.deepEqual(JSON.parse(players[0].fields[PF.playHistory]), { '13': { plays: 3, wins: 2, last: '2026-10-01' } });
  const ratings = db.store[RATINGS_TABLE];
  assert.deepEqual(ratings.map((x: any) => [x.fields[RF.key], x.fields[RF.stars], x.fields[RF.source]]), [['recDan|g1|bgg', 4, 'bgg'], ['recDan|g2|bgg', 3, 'bgg']]);
  assert.ok(calls.some((c) => c.url.includes('xmlapi2/collection') && c.url.includes('username=daddo_78')));
});

test('memberPlays job: plays saved and the shelf refreshed, progress marked done; a bad username marks an error; the nightly runs each member', async () => {
  const marks: any[] = [];
  const db = jobsDb({ 'at.save_plays': () => ({ plays: 2, newPlays: 1 }), 'bgc.refresh_member': () => ({ players: 4 }), 'bgc.set_import': ([, p]) => { marks.push(JSON.parse(p as string)); return null; },
    'bgc.start_import': () => [{ ok: 'true', email: 'amy@example.com', username: 'amy_b' }, { ok: 'false', email: 'bob@example.com', username: 'bob' }] });
  const { f } = jobsFetch({ plays: PLAYS });
  const { ctx } = ctxWith(db, f);
  const r: any = await memberPlays.run(ctx, { email: 'amy@example.com', username: 'amy_b' });
  assert.deepEqual([r.ok, r.plays, r.newPlays, r.players], [true, 2, 1, 4]);
  assert.deepEqual([marks[0].state, marks[0].plays, marks[0].players], ['done', 2, 4]);
  const bad = jobsFetch({ plays: ['<error><message>Invalid username specified</message></error>'] });
  const r2: any = await memberPlays.run(ctxWith(db, bad.f).ctx, { email: 'amy@example.com', username: 'nobody' });
  assert.deepEqual([r2.ok, marks.at(-1).state, marks.at(-1).message], [false, 'error', 'Invalid username specified']);
  const n: any = await memberPlaysNightly.run(ctx, {});
  assert.deepEqual([n.members, n.synced], [2, 1]); // bob's import was already running
});

test('fillCatalog job: the games the database names get their details and box art through bgc.enrich_games', async () => {
  const enriched: any[] = [];
  const db = jobsDb({ 'bgc.catalog_to_fill': () => '13,77', 'bgc.enrich_games': ([things]) => { enriched.push(JSON.parse(things as string)); return { ok: true }; } });
  const { f } = jobsFetch({ things: { '13': THING('boardgame', 13, 'Catan', 100) } });
  const { ctx } = ctxWith(db, f);
  assert.deepEqual(await fillCatalog.run(ctx, {}), { asked: 2, found: 1 });
  assert.deepEqual([enriched[0][0].id, enriched[0][0].coverCard], [13, 'https://cf.geekdo-images.com/m.jpg']);
  const empty = jobsDb({ 'bgc.catalog_to_fill': () => null });
  assert.deepEqual(await fillCatalog.run(ctxWith(empty, f).ctx, {}), { asked: 0, found: 0 });
});

test('splitSections and cleanMarkdown: headings start sections, tiny ones join the next, long ones split; remarks and fences go', () => {
  const md = '# Setup\nShort.\n## Turn\n' + 'A rule. '.repeat(40) + '\n\nMore.\n### Icons\n[purple hand icon] means pass.';
  const s = splitSections(md);
  assert.deepEqual(s.map((x) => x.heading), ['Turn', 'Icons']);
  assert.match(s[0].body, /^Setup: Short\./);
  const long = splitSections('# Big\n' + ('Paragraph. '.repeat(100) + '\n\n').repeat(4));
  assert.ok(long.length >= 2 && long.every((x) => x.heading === 'Big' && x.body.length <= 2400));
  assert.equal(cleanMarkdown('```markdown\nHere is the page:\n# Setup\nText\n```'), '# Setup\nText');
  assert.equal(cleanMarkdown('The PDF reader pulled no text.\nI will rewrite it.\n# Rules\nPlay.'), '# Rules\nPlay.');
});

test('ruleReader job: each unread page is read by the vision model and saved with its sections; when all are read the PDF is let go and the document named', async () => {
  const saved: any[] = [], named: any[] = [];
  let finished = 0;
  const db = jobsDb({
    'bgc.rule_doc_claim': () => ({ id: 7, pages: 3, label: 'Rulebook', title: '', game: 'SETI', done: [1] }),
    'bgc.rule_page_save': (p) => { saved.push(p); return null; },
    'bgc.rule_doc_finish': () => { finished++; return { ok: true, status: 'ready', pages: 2, missing: '3' }; },
    'bgc.rule_doc_naming': () => ({ doc: 7, game: 'SETI', kind: 'rulebook', need: true, text: '# SETI Rules\n...' }),
    'bgc.rule_doc_autoname': (p) => { named.push(p); return { ok: true }; },
  });
  const { f, calls } = jobsFetch({
    pages: { '2': { text: 'raw text 2', jpeg_b64: 'AAAA' }, '3': { text: 'no image here' } },
    openrouter: (body) => (body.max_tokens === 80 ? { kind: 'appendix', name: 'The Edge Cases' } : '# Page two\nA rule about [purple hand icon].'),
  });
  const { ctx } = ctxWith(db, f);
  const r: any = await ruleReader.run(ctx, {});
  assert.deepEqual([r.document, r.read, r.skipped, r.status], [7, 1, 1, 'ready']);
  assert.deepEqual(saved[0].slice(0, 4), [7, 2, '# Page two\nA rule about [purple hand icon].', false]);
  assert.deepEqual(JSON.parse(saved[0][4]), [{ heading: 'Page two', body: 'A rule about [purple hand icon].' }]);
  assert.equal(JSON.parse(saved[0][5])[0].feature, 'rulebook');
  assert.equal(finished, 1);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === 'http://pages:8000/doc/7'));
  assert.deepEqual(named[0].slice(0, 3), [7, 'appendix', 'The Edge Cases']);
  const quiet = jobsDb({ 'bgc.rule_doc_claim': () => null });
  assert.deepEqual(await ruleReader.run(ctxWith(quiet, f).ctx, {}), { document: null });
});

test('shelfCsv job: unknown titles looked up on BGG, every match given details and art, bgc.csv_add puts them on the shelf; a failure marks the import', async () => {
  const marks: any[] = [], adds: any[] = [];
  const db = jobsDb({ 'bgc.set_import': ([, p]) => { marks.push(JSON.parse(p as string)); return null; }, 'bgc.csv_add': (p) => { adds.push(p); return { state: 'done', added: 2 }; } });
  const { f } = jobsFetch({ things: { '13': THING('boardgame', 13, 'Catan', 100), '77': THING('boardgame', 77, 'Azul', 50) } });
  const { ctx } = ctxWith(db, f);
  const r: any = await shelfCsv.run(ctx, { email: 'amy@example.com', start: { ids: [77], search: [{ title: 'Catan', year: null }, { title: 'Nothing Like It', year: null }], alreadyHad: 1 } });
  assert.deepEqual([r.lookedUp, r.found, r.notFound], [2, 2, 1]);
  assert.deepEqual(marks.map((m) => m.step), ['Looking up 2 games on BGG', 'Getting game details and box art']);
  assert.deepEqual([adds[0][0], JSON.parse(adds[0][1]).map((t: any) => t.id).sort(), JSON.parse(adds[0][2]), adds[0][3]], ['amy@example.com', [13, 77], ['Nothing Like It'], 1]);
  const broken = jobsDb({ 'bgc.set_import': ([, p]) => { marks.push(JSON.parse(p as string)); return null; }, 'bgc.csv_add': () => { throw new Error('boom'); } });
  await assert.rejects(shelfCsv.run(ctxWith(broken, f).ctx, { email: 'amy@example.com', start: { ids: [77], search: [], alreadyHad: 0 } }), /boom/);
  assert.deepEqual([marks.at(-1).state, marks.at(-1).message], ['error', 'The import didn’t finish: boom']);
});

test('selfTest job: the database checks are saved and a failed one emails Dan; a question that can\'t be asked is a failed check', async () => {
  const saved: any[] = [];
  const db = jobsDb({ 'bgc.self_check': () => [{ what: 'a member can sign in', ok: true }, { what: 'a stranger can\'t', ok: false }], 'INSERT INTO settings': ([v]) => { saved.push(JSON.parse(v as string)); return null; } });
  const { f } = jobsFetch();
  const { ctx, mails } = ctxWith(db, f);
  const r: any = await selfTest.run(ctx, { only: 'no such question' });
  assert.deepEqual([r.dbPassed, r.dbTotal, r.nathanTotal, r.emailed], [1, 2, 0, true]);
  assert.deepEqual(saved[0].failures, [{ what: 'a stranger can\'t', problems: [] }]);
  assert.match(mails[0].text, /Database checks: 1 of 2 passed/);
  const one = await askOne(ctx, { name: 'Top ten', as: 'nathan', q: 'What are my top ten?', includes: ['Catan'] });
  assert.equal(one.ok, false);
  assert.match(one.problems![0], /^error: /);
});
