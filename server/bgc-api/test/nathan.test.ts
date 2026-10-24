// Nathan through the API with a stand-in database and a stand-in OpenRouter: the order of steps, streaming, Stop,
// allowance, and what is saved afterwards. (Whether his answers are good is the question set's job: test-nathan.js.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partialJson } from '../src/nathan/partialJson.js';
import { timing } from '../src/nathan/openrouter.js';
import { bearer, fakeDb, makeAppWith, token } from './helpers.js';

timing.waitMs = 0; // no 5-second pause between OpenRouter retries in tests

// A shelf as bgc.shelf_view returns it (rows still in the old Airtable shape)
const game = (id: string, title: string, min: number, max: number, bggId: number) => ({ id: 'rec' + id.padEnd(14, 'x'), fields: {
  fldOSxvCDWJdYbUZe: title, fldJ1g6gtxWDwlWsI: id, fldzXSHLRYoKjn9YY: min, fldwlQj31eoBIgF32: max, fldbWi7hhf2VGYzZl: bggId, fldmxVhDKLpxevVS4: 30, fldAAPDFVAH2lOax5: 45 } });
const SHELF = { shelf: 'main', ownerName: 'Dan', askerName: 'Amy', games: [game('G1', 'Azul', 2, 4, 230802), game('G2', 'Cascadia', 1, 4, 295947)], players: [], ratings: [] };

const UNDERSTAND = JSON.stringify({ onTopic: true, intent: 'recommend', playerCount: 3, themes: [], avoid: [], excludeIds: [] });
const WRITE = JSON.stringify({ pick: { id: 'G1', quip: 'Tile be there for you.', why: 'Azul is quick and pretty for three.', tableFeel: 'Calm, then cutthroat.' }, alternative: { id: 'G2', why: 'Cascadia is gentler.', tableFeel: 'Relaxing.' }, gap: null, remember: [], signoff: '' });

function nathanDb(over: Record<string, (p: unknown[]) => unknown> = {}) {
  const db: any = fakeDb({ 'bgc.log_ask': () => null, 'bgc.chat_save': () => null, 'bgc.log_ai': () => null, ...over });
  const rows: Record<string, (p: unknown[]) => any> = {
    'bgc.use_ask': () => ({ questions: 1, lim: 30 }),
    'bgc.memory_for': () => ({ mem: {}, rule_games: [] }),
    "bgc.shelf_view($1, 'mine'": () => ({ own: null, fid: null, visit: null }),
    'bgc.shelf_view($1, $2, $3)': () => ({ v: SHELF }),
    'bgc.shelf_view($1, $2, $3, true)': () => ({ v: { ...SHELF, games: [], ratings: [] } }), // people only
    'bgc.lookup_games': () => ({ games: [], pool: null, curator: {}, fpool: null, extras: {}, top_games: [], rules: null }),
    ...over,
  };
  db.row = async (sql: string, params: unknown[]) => {
    db.calls.push({ sql, params });
    const k = Object.keys(rows).find((x) => sql.includes(x));
    if (!k) throw new Error('fake db row: ' + sql);
    return rows[k](params);
  };
  return db;
}

// OpenRouter stand-in: the understand step gets UNDERSTAND, the write step WRITE (streamed in small pieces when asked).
// fail: answer every call with that status (true: 500). stall: the streamed answer sends its first piece, then nothing
// more until the request's signal aborts (as a real fetch would, the body then fails with an AbortError).
function fakeOpenRouter(opts: { write?: string; fail?: boolean | number; stall?: boolean } = {}) {
  const bodies: any[] = [], signals: AbortSignal[] = [];
  let stalled!: () => void;
  const stalling = new Promise<void>((r) => { stalled = r; });
  const f = async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    signals.push(init.signal);
    if (opts.fail) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: opts.fail === true ? 500 : opts.fail });
    const content = body.max_tokens === 1500 ? UNDERSTAND : (opts.write ?? WRITE);
    const usage = { cost: 0.001, prompt_tokens: 100, completion_tokens: 50 };
    if (!body.stream) return Response.json({ choices: [{ message: { content } }], model: body.model, usage });
    const pieces = content.match(/.{1,12}/gs)!;
    const line = (p: string) => 'data: ' + JSON.stringify({ model: body.model, choices: [{ delta: { content: p } }] }) + '\n\n';
    if (opts.stall) {
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode(line(pieces[0])));
          stalled();
          (init.signal as AbortSignal).addEventListener('abort', () => ctl.error(new DOMException('This operation was aborted', 'AbortError')));
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const sse = ': OPENROUTER PROCESSING\n\n' + pieces.map(line).join('') +
      'data: ' + JSON.stringify({ model: body.model, choices: [{ delta: {} }], usage }) + '\n\ndata: [DONE]\n\n';
    return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { f: f as unknown as typeof fetch, bodies, signals, stalling };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
test('partialJson reads an answer that is still being written', () => {
  assert.equal(partialJson('{"summary": "You have 17 sci-fi ga').summary, 'You have 17 sci-fi ga');
  assert.deepEqual(partialJson('Sure! {"pick": {"id": "G1", "why": "Quick'), { pick: { id: 'G1', why: 'Quick' } });
  assert.deepEqual(partialJson('{"pick": {"id": "G1"}, "alter'), { pick: { id: 'G1' } });
  assert.deepEqual(partialJson('{"a": "say \\"hi'), { a: 'say "hi' });
  assert.deepEqual(partialJson('{"h": [{"id": "G1"}, {"id'), { h: [{ id: 'G1' }, {}] });
  assert.equal(partialJson('no json yet'), null);
});

test('ask with the stand-in OpenRouter: pick, alternative, chatKey; allowance used; chat saved; cost logged', async () => {
  const db = nathanDb();
  const or = fakeOpenRouter();
  const app = makeAppWith({ db, fetch: or.f });
  const res = await app.request('/vault/ask', { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'something for 3 of us', test: true }) });
  const a: any = await res.json();
  assert.equal(res.status, 200);
  assert.equal(a.ok, true);
  assert.equal(a.intent, 'recommend');
  assert.deepEqual([a.pick.title, a.alternative.title], ['Azul', 'Cascadia']);
  assert.match(a.chatKey, /^c/);
  assert.equal(a.learn, undefined);
  assert.equal(or.bodies.length, 2);
  assert.equal(or.bodies[0].model, 'google/gemini-2.5-flash-lite');         // understand: the small model
  assert.equal(or.bodies[1].model, 'anthropic/claude-haiku-5.5');          // write: Nathan's model
  assert.deepEqual(or.bodies[1].provider, { order: ['google-vertex'], data_collection: 'deny' });
  assert.ok(db.calls.some((c: any) => c.sql.includes('bgc.use_ask')), 'a test flag from the web still uses the allowance');
  await settle();
  // Log line, saved chat and costs go in one statement: log_ask's 5 inputs, chat_save's 4 more, log_ai's costs
  const saved = db.calls.find((c: any) => c.sql.includes('bgc.chat_save'));
  assert.ok(saved.sql.includes('bgc.log_ask(') && saved.sql.includes('bgc.log_ai('), 'one round trip');
  assert.equal(saved.params[6], 'something for 3 of us');
  const cost = JSON.parse(saved.params[9]);
  assert.deepEqual(cost.map((x: any) => x.feature), ['nathan', 'nathan']);
  assert.ok(!JSON.stringify(cost).includes('something for 3'), 'the question never goes into the cost log');
});

const parseEvents = (text: string) => text.trim().split('\n\n').filter(Boolean).map((b) => ({ event: /event: (\w+)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)![1]) }));

test('ask/stream: stages, the words as they arrive, then the same answer', async () => {
  const db = nathanDb();
  const or = fakeOpenRouter();
  const app = makeAppWith({ db, fetch: or.f });
  const res = await app.request('/vault/ask/stream', { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'something for 3 of us' }) });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events = parseEvents(await res.text());
  assert.deepEqual(events.filter((e) => e.event === 'stage').map((e) => e.data.stage), ['reading', 'looking', 'writing']);
  const partials = events.filter((e) => e.event === 'partial');
  assert.ok(partials.length >= 1, 'some partial answers');
  for (const p of partials) assert.ok(!p.data.pick || p.data.pick.id === 'G1', 'only whole ids from the shortlist');
  const done = events.at(-1)!;
  assert.equal(done.event, 'done');
  assert.equal(done.data.pick.why, 'Azul is quick and pretty for three.');
});

test('ask/stream: Stop (the page closing the connection) stops the OpenRouter call, and nothing is saved', async () => {
  const db = nathanDb();
  const or = fakeOpenRouter({ stall: true });
  const app = makeAppWith({ db, fetch: or.f });
  const res = await app.request('/vault/ask/stream', { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'something for 3 of us' }) });
  // Read until Nathan is writing and OpenRouter has started answering, then hang up. (On Node, Hono notices a closed
  // connection as the response body being cancelled; a request signal is only wired on old Bun, so this is the real path.)
  const reader = res.body!.getReader(); const dec = new TextDecoder();
  let seen = '';
  while (!seen.includes('"writing"')) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value, { stream: true }); }
  await or.stalling;
  assert.equal(or.signals.at(-1)!.aborted, false);
  await reader.cancel();
  await settle();
  assert.equal(or.signals.at(-1)!.aborted, true, 'the OpenRouter request was cut off');
  assert.deepEqual(parseEvents(seen).filter((e) => e.event === 'stage').map((e) => e.data.stage), ['reading', 'looking', 'writing']);
  assert.ok(!db.calls.some((c: any) => c.sql.includes('bgc.chat_save') || c.sql.includes('bgc.log_ai')), 'nothing saved for a stopped answer');
});

test('OpenRouter: a 5xx is tried three times, a 4xx (our request is wrong) once', async () => {
  const orig = console.error; console.error = () => {};
  try {
    for (const [status, tries] of [[500, 3], [429, 3], [400, 1], [402, 1]] as const) {
      const or = fakeOpenRouter({ fail: status });
      const app = makeAppWith({ db: nathanDb(), fetch: or.f });
      const r = await app.request('/vault/ask', { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'a co-op for 3' }) });
      assert.equal(r.status, 502, String(status));
      assert.equal(or.bodies.length, tries, String(status));
    }
  } finally { console.error = orig; }
});

test('ask: understanding starts on the people while the whole shelf is still loading; the picks come from the whole shelf', async () => {
  let release!: () => void;
  const loaded = new Promise<void>((r) => { release = r; });
  const or = fakeOpenRouter();
  const db = nathanDb({ 'bgc.shelf_view($1, $2, $3)': async () => { await loaded; return { v: SHELF }; } });
  const app = makeAppWith({ db, fetch: or.f });
  const res = app.request('/vault/ask', { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'something for 3 of us' }) });
  await settle();
  assert.equal(or.bodies.length, 1, 'understand asked before the shelf arrived');
  release();
  const a: any = await (await res).json();
  assert.deepEqual([a.pick.title, a.alternative.title], ['Azul', 'Cascadia']);
});

test('ask: out of questions for today is a 429 with Nathan’s message, and no AI is called', async () => {
  const or = fakeOpenRouter();
  const app = makeAppWith({ db: nathanDb({ 'bgc.use_ask': () => ({ questions: 31, lim: 30 }) }), fetch: or.f });
  const res = await app.request('/vault/ask', { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'one more?' }) });
  assert.equal(res.status, 429);
  assert.match(((await res.json()) as any).message, /answered your 30 questions/);
  assert.equal(or.bodies.length, 0);
});

test('ask: bad input gets n8n’s own messages; no key means not set up; OpenRouter down is a plain 502', async () => {
  const or = fakeOpenRouter();
  const app = makeAppWith({ db: nathanDb(), fetch: or.f });
  const t = { ...bearer(await token()), 'Content-Type': 'application/json' };
  const ask = (a: any, body: string) => a.request('/vault/ask', { method: 'POST', headers: t, body });
  assert.deepEqual(await (await ask(app, JSON.stringify({ question: 'hi' }))).json(), { ok: false, message: 'Ask a question, like "a co-op for 3 under an hour".' });
  assert.equal((await ask(app, 'not json')).status, 400);
  assert.equal((await ask(app, JSON.stringify({ question: 5 }))).status, 400);
  const bare = makeAppWith({ db: nathanDb(), fetch: or.f, env: { OPENROUTER_API_KEY: '' } });
  assert.equal((await ask(bare, JSON.stringify({ question: 'a co-op for 3' }))).status, 503);
  const down = makeAppWith({ db: nathanDb(), fetch: fakeOpenRouter({ fail: true }).f });
  const orig = console.error; console.error = () => {};
  try {
    const r = await ask(down, JSON.stringify({ question: 'a co-op for 3' }));
    assert.deepEqual([r.status, ((await r.json()) as any).message], [502, 'Nathan couldn’t answer just now. Try again in a moment.']);
  } finally { console.error = orig; }
});

test('nathan-mode: off by default; admins only; everyone; only admins may change it', async () => {
  let mode: string | null = null;
  const db = nathanDb({ "FROM settings WHERE key = 'nathan_api'": () => mode, 'to_jsonb': (p) => { mode = p[0] as string; return null; } });
  const app = makeAppWith({ db, fetch: fakeOpenRouter().f });
  const amy = bearer(await token()), dan = bearer(await token({ email: 'owner@example.com' }));
  const get = async (h: any) => (await app.request('/vault/nathan-mode', { headers: h })).json() as any;
  const set = (h: any, m: string) => app.request('/vault/nathan-mode', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: m }) });
  assert.deepEqual(await get(amy), { ok: true, useApi: false });
  assert.deepEqual(await get(dan), { ok: true, useApi: false, mode: 'off' });
  assert.equal((await set(amy, 'everyone')).status, 403);
  assert.equal((await set(dan, 'sometimes')).status, 400);
  assert.equal((await set(dan, 'admins')).status, 200);
  assert.deepEqual([(await get(amy)).useApi, (await get(dan)).useApi], [false, true]);
  await set(dan, 'everyone');
  assert.equal((await get(amy)).useApi, true);
  const bare = makeAppWith({ db, fetch: fakeOpenRouter().f, env: { OPENROUTER_API_KEY: '' } });
  assert.equal(((await (await bare.request('/vault/nathan-mode', { headers: amy })).json()) as any).useApi, false, 'never while Nathan isn’t set up here');
});
