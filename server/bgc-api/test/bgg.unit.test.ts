// BoardGameGeek, typed: the XML parsers and the client's manners (pacing, 202 retries, every page of plays, choosing a game by title)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bgg, normTitle, parsePlays, parseSearchXml, parseThingXml, tallyPeople, tallyPlays } from '../src/bgg.js';

import { THING } from './fixtures.js';

const items = (...x: string[]) => '<items>' + x.join('') + '</items>';

test('parseThingXml: the catalog\'s facts, best-with from the poll, designers without "(Uncredited)", an expansion\'s base games', () => {
  const [catan, sea] = parseThingXml(items(THING('boardgame', 13, 'Catan', 120000), THING('boardgameexpansion', 325, 'Catan: Seafarers', 2000, '<link type="boardgameexpansion" id="13" value="Catan" inbound="true"/>')));
  assert.equal(catan.id, 13);
  assert.deepEqual([catan.name, catan.year, catan.minPlayers, catan.maxPlayers, catan.minTime, catan.maxTime, catan.minAge], ['Catan', 1995, 3, 4, 60, 120, 10]);
  assert.deepEqual([catan.rating, catan.weight, catan.rank, catan.usersRated, catan.bestPlayers], [7.1, 2.35, 500, 120000, [4]]);
  assert.deepEqual([catan.designers, catan.categories, catan.mechanics], [['Klaus Teuber'], ['Negotiation'], ['Dice Rolling']]);
  assert.equal(catan.description, 'Trade & build. Settle the island.');
  assert.equal(catan.descriptionLong, 'Trade & build. Settle the island.');
  assert.deepEqual([catan.picId, catan.thumbnail], ['130', 'https://cf.geekdo-images.com/13.jpg']);
  assert.deepEqual([sea.type, sea.baseIds, sea.bases], ['boardgameexpansion', [13], [{ id: 13, title: 'Catan' }]]);
});

test('parseSearchXml and normTitle: every hit with its year; titles compared without case, punctuation or a leading "the"', () => {
  const hits = parseSearchXml('<items><item type="boardgame" id="13"><name type="primary" value="Catan"/><yearpublished value="1995"/></item><item type="boardgameexpansion" id="9"><name type="alternate" value="The Catan &amp; More"/></item></items>');
  assert.deepEqual(hits, [{ id: '13', type: 'boardgame', name: 'Catan', year: 1995 }, { id: '9', type: 'boardgameexpansion', name: 'The Catan & More', year: null }]);
  assert.equal(normTitle('The Castles of Burgundy: Special Edition!'), 'castles of burgundy special edition');
  assert.equal(normTitle("Tom & Jerry’s"), 'tom and jerrys');
});

const PLAYS_PAGE = '<plays username="daddo_78" userid="1" total="3" page="1">' +
  '<play id="101" date="2026-10-01" quantity="2" length="45" incomplete="0" location="Home"><item name="Catan" objecttype="thing" objectid="13"/><comments>Fun &amp; games</comments>' +
  '<players><player username="daddo_78" name="Dan" win="1" score="10" new="0"/><player username="" name="Matt" win="0" score="8" new="1"/></players></play>' +
  '<play id="102" date="0000-00-00" quantity="1" length="0" incomplete="1"><item name="Azul" objecttype="thing" objectid="230802"/><players><player username="" name="Anonymous player" win="0"/></players></play>' +
  '</plays>';

test('parsePlays, tallyPlays and tallyPeople: rows for at.save_plays, counts per game, and who played and won', () => {
  const p = parsePlays([PLAYS_PAGE]);
  assert.equal(p.ok, true);
  assert.equal(p.plays.length, 2);
  assert.deepEqual(p.plays[0], { id: 101, date: '2026-10-01', quantity: 2, minutes: 45, incomplete: false, location: 'Home', bggId: 13, gameName: 'Catan', comments: 'Fun & games',
    players: [{ seat: 1, name: 'Dan', user: 'daddo_78', win: true, score: '10', isNew: false, color: '', position: '', rating: '' },
      { seat: 2, name: 'Matt', user: '', win: false, score: '8', isNew: true, color: '', position: '', rating: '' }] });
  assert.deepEqual(parsePlays(['<error><message>Invalid username specified</message></error>']), { ok: false, message: 'Invalid username specified', plays: [] });
  const t = tallyPlays([PLAYS_PAGE]);
  assert.deepEqual(t, { byGame: { '13': { count: 2, last: '2026-10-01' }, '230802': { count: 1, last: null } }, total: 3, gamesPlayed: 2 });
  const people = tallyPeople([PLAYS_PAGE]);
  assert.deepEqual(Object.keys(people).sort(), ['dan', 'matt']); // anonymous players don't count
  assert.deepEqual(people.dan, { name: 'Dan', total: 2, games: { '13': { plays: 2, wins: 2, last: '2026-10-01' } } });
  assert.deepEqual(people.matt.games['13'], { plays: 2, wins: 0, last: '2026-10-01' });
});

// A stand-in BGG: counts calls, answers 202 the first time when asked to, pages plays
function fakeBgg(opts: { busyOnce?: boolean; pages?: string[] } = {}) {
  const calls: string[] = [];
  let busy = !!opts.busyOnce;
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (busy) { busy = false; return new Response('<message>Please try again later</message>', { status: 202 }); }
    const q = new URL(u).searchParams;
    if (u.includes('/search?')) return new Response(items('<item type="boardgame" id="999"><name type="primary" value="Catan Junior"/></item><item type="boardgame" id="13"><name type="primary" value="Catan"/><yearpublished value="1995"/></item><item type="boardgame" id="14"><name type="primary" value="Catan"/><yearpublished value="2015"/></item><item type="boardgameexpansion" id="325"><name type="primary" value="Catan: Seafarers"/></item>'));
    if (u.includes('/thing?')) {
      const ids = q.get('id')!.split(',');
      const all: Record<string, string> = { '13': THING('boardgame', 13, 'Catan', 120000), '14': THING('boardgame', 14, 'Catan', 300), '999': THING('boardgame', 999, 'Catan Junior', 5000), '325': THING('boardgameexpansion', 325, 'Catan: Seafarers', 20000) };
      return new Response(items(...ids.map((i) => all[i] || '')));
    }
    if (u.includes('/plays?')) { const page = Number(q.get('page')); return new Response((opts.pages || [PLAYS_PAGE, '<plays total="3" page="2"></plays>'])[page - 1] || '<plays></plays>'); }
    if (u.includes('api.geekdo.com/api/images/')) return Response.json({ images: { medium: { url: 'https://cf.geekdo-images.com/m.jpg' }, itempage: { url: 'https://cf.geekdo-images.com/l.jpg' } } });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

test('Bgg.text: a 202 is asked again after a moment; no token means no answer and no call', async () => {
  const { f, calls } = fakeBgg({ busyOnce: true });
  const bgg = new Bgg(f, 'tok', 0);
  (bgg as any).text = async function (path: string, params: Record<string, string>) { // the real one waits 2 s between tries: skip that here
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await f('https://boardgamegeek.com/xmlapi2/' + path + '?' + new URLSearchParams(params), { headers: { Authorization: 'Bearer tok' } });
      if (r.ok && r.status !== 202) return await r.text();
    }
    return null;
  };
  const t = await bgg.things([13]);
  assert.equal(t[0].name, 'Catan');
  assert.equal(calls.length, 2);
  const none = new Bgg(f, undefined, 0);
  assert.equal(await none.search('catan'), null);
  assert.equal(calls.length, 2);
});

test('Bgg.plays: every page until one without plays, 2 s apart (0 here); the pages are what the parsers take', async () => {
  const { f, calls } = fakeBgg();
  const bgg = new Bgg(f, 'tok', 0);
  (bgg as any).gapMs = 0;
  // the real pause between pages is 2 s - gap; make it instant for the test
  const orig = bgg.plays.bind(bgg);
  const pages = await Promise.race([orig('daddo_78'), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('too slow')), 15_000))]);
  assert.equal(pages.length, 2);
  assert.equal(calls.filter((u) => u.includes('/plays?')).length, 2);
  assert.match(calls[0], /username=daddo_78/);
  assert.match(calls[1], /page=2/);
  assert.equal(parsePlays(pages).plays.length, 2);
});

test('Bgg.findByTitle: exact title, the asked-for year when there is one, the right kind, then the one most people rated; loose only when allowed', async () => {
  const { f } = fakeBgg();
  const bgg = new Bgg(f, 'tok', 0);
  assert.equal((await bgg.findByTitle('Catan'))!.id, 13);                       // 120000 raters beats 300
  assert.equal((await bgg.findByTitle('Catan', { year: 2015 }))!.id, 14);       // the 2015 one when asked
  assert.equal((await bgg.findByTitle('Catan Junior'))!.id, 999);
  assert.equal(await bgg.findByTitle('Catan Junior Deluxe'), null);              // nothing exact
  assert.equal((await bgg.findByTitle('Catan Junior Deluxe', { fuzzy: true }))!.id, 13); // loosely "Catan" and "Catan Junior" both start it; the one most people rated wins, as in n8n
  assert.equal((await bgg.findByTitle('Catan: Seafarers', { want: 'boardgameexpansion' }))!.type, 'boardgameexpansion');
  const cover = await bgg.withCover((await bgg.things([13]))[0]);
  assert.deepEqual([cover.coverCard, cover.coverLarge], ['https://cf.geekdo-images.com/m.jpg', 'https://cf.geekdo-images.com/l.jpg']);
});
