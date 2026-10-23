// BGG search and adding to your shelf, with a stand-in BoardGameGeek: n8n's own code finds, ranks and shapes the results
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, fakeDb, makeAppWith, token } from './helpers.js';

const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });

// What BGG's XML API answers for "catan", and the details of the two games it finds
const SEARCH = '<items><item type="boardgame" id="999"><name type="primary" value="Catan Junior"/></item>' +
  '<item type="boardgame" id="13"><name type="primary" value="Catan"/></item>' +
  '<item type="boardgameexpansion" id="325"><name type="primary" value="Catan: Seafarers"/></item></items>';
const thing = (type: string, id: number, name: string, users: number, extra = '') =>
  `<item type="${type}" id="${id}"><thumbnail>https://cf.geekdo-images.com/${id}.jpg</thumbnail><image>https://cf.geekdo-images.com/pic${id}0.jpg</image>` +
  `<name type="primary" sortindex="1" value="${name}"/><yearpublished value="1995"/><minplayers value="3"/><maxplayers value="4"/>${extra}` +
  `<statistics><ratings><usersrated value="${users}"/><average value="7.1"/><averageweight value="2.3"/><ranks><rank type="subtype" id="1" name="boardgame" value="500"/></ranks></ratings></statistics></item>`;
const ALL = [thing('boardgame', 999, 'Catan Junior', 5000), thing('boardgame', 13, 'Catan', 120000),
  thing('boardgameexpansion', 325, 'Catan: Seafarers', 20000, '<link type="boardgameexpansion" id="13" value="Catan" inbound="true"/>')];
const things = (ids: string[]) => '<items>' + ALL.filter((x) => ids.some((id) => x.includes(' id="' + id + '">'))).join('') + '</items>';

function bggFetch(opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const f = async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (opts.down) return new Response('busy', { status: 503 });
    if (u.includes('/search?')) return new Response(SEARCH);
    if (u.includes('/thing?')) return new Response(things(new URL(u).searchParams.get('id')!.split(',')));
    if (u.includes('api.geekdo.com/api/images/')) return Response.json({ images: { medium: { url: 'https://cf.geekdo-images.com/medium.jpg' }, itempage: { url: 'https://cf.geekdo-images.com/large.jpg' } } });
    return new Response('?', { status: 404 });
  };
  return { f: f as typeof fetch, calls };
}

const appWith = async (f: typeof fetch, db = fakeDb()) => ({ app: makeAppWith({ db, fetch: f, env: { BGG_TOKEN: 'bgg-test' } }), db });

test('GET /vault/bgg-search: exact match first, then by how many rated it; expansions say what they expand', async () => {
  const { f, calls } = bggFetch();
  const { app } = await appWith(f);
  const r = await json(await app.request('/vault/bgg-search?q=catan', { headers: bearer(await token()) }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x: any) => x.title), ['Catan', 'Catan: Seafarers', 'Catan Junior']);
  assert.deepEqual(r.body.results[1].expands, [{ id: 13, title: 'Catan' }]);
  assert.equal(r.body.results[1].kind, 'expansion');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /query=catan/);
});

test('GET /vault/bgg-search: too short is a 400 and BGG is never asked; BGG down is a plain 502', async () => {
  const { f, calls } = bggFetch();
  const { app } = await appWith(f);
  assert.deepEqual(await json(await app.request('/vault/bgg-search?q=c', { headers: bearer(await token()) })), { status: 400, body: { ok: false, message: 'Type 2-100 characters to search' } });
  assert.equal(calls.length, 0);
  const down = bggFetch({ down: true });
  const { app: app2 } = await appWith(down.f);
  const r = await json(await app2.request('/vault/bgg-search?q=catan', { headers: bearer(await token()) }));
  assert.deepEqual(r, { status: 502, body: { ok: false, message: 'BoardGameGeek isn’t answering right now. Try again in a minute.' } });
  assert.equal(down.calls.length, 2); // one more try
});

test('POST /vault/shelf-add: BGG details and box art go to bgc.shelf_add; a title alone needs no BGG', async () => {
  const { f } = bggFetch();
  const db = fakeDb({ 'bgc.shelf_add': (p) => ({ ok: true, got: p }) });
  const { app } = await appWith(f, db);
  const add = (b: unknown) => token().then((t) => app.request('/vault/shelf-add', { method: 'POST', headers: { ...bearer(t), 'Content-Type': 'application/json' }, body: JSON.stringify(b) }));
  const r = await json(await add({ bggId: 13 }));
  const [email, thingJson, title] = r.body.got;
  const t = JSON.parse(thingJson);
  assert.deepEqual([email, title, t.id, t.coverCard, t.coverLarge], ['amy@example.com', '', 13, 'https://cf.geekdo-images.com/medium.jpg', 'https://cf.geekdo-images.com/large.jpg']);
  const r2 = await json(await add({ title: 'Homemade Game' }));
  assert.deepEqual(r2.body.got, ['amy@example.com', 'null', 'Homemade Game']);
  assert.deepEqual(await json(await add({})), { status: 400, body: { ok: false, message: 'Send a bggId, or a title for a game that is not on BGG' } });
});
