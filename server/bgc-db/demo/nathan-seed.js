// Usage: export the catalog to catalog.json (see the query in the comment below), then
//   node nathan-seed.js catalog.json nathan-seed.sql  and apply nathan-seed.sql with psql (refuses to run twice).
// Catalog query: select jsonb_agg(jsonb_build_object('id',id,'bgg',bgg_id,'t',title,'w',weight,'r',bgg_rank,'rt',bgg_rating,'mn',min_players,'mx',max_players,'tm',coalesce(max_time,min_time),'c',categories,'m',mechanics)) from games where bgg_rank is not null and enriched_at is not null and cover_card is not null and min_players is not null
// Builds the SQL for a demo member, Nathan Schmidt: 150 games from the catalog, ~3 years of plays, his own ratings, friends with Dan.
// Deterministic (seeded), so re-running produces the same shelf.
const fs = require('fs');
const [catalogFile, outFile] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
let seed = 20261020;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const has = (g, re) => [...g.c, ...g.m].some((x) => re.test(x));
const coop = (g) => g.m.some((m) => /cooperative/i.test(m));
const party = (g) => has(g, /party|deduction|word game|communication limits/i);
const two = (g) => g.mx === 2;

// His taste: medium-heavy strategy, co-ops and clever card games; easy on take-that and player elimination
const taste = (g) => {
  let s = (g.rt || 6.5) - 6.5;
  if (g.w >= 2.5 && g.w <= 4) s += 1.2;
  if (coop(g)) s += 0.4;
  if (has(g, /engine building|worker placement|tile placement|deck, bag|drafting|trick-taking/i)) s += 0.7;
  if (has(g, /science fiction|nature|animals|exploration|economic/i)) s += 0.4;
  if (has(g, /take that|player elimination/i)) s -= 0.9;
  if (has(g, /wargame|miniatures/i)) s -= 0.4;
  return s;
};
const pool = catalog.filter((g) => g.r && g.r <= 1500 && g.mn && g.t && !/:.*(expansion|promo)/i.test(g.t) && !/series$/i.test(g.t));
const chosen = new Map();
const coops = () => [...chosen.values()].filter(coop).length;
const take = (list, n) => { for (const g of list) { if (chosen.size >= 150 || n <= 0) break; if (chosen.has(g.bgg) || (coop(g) && coops() >= 38)) continue; chosen.set(g.bgg, g); n--; } };
const byTaste = (list) => list.map((g) => ({ g, s: taste(g) + rnd() * 1.2 })).sort((a, b) => b.s - a.s).map((x) => x.g);
take(byTaste(pool.filter((g) => g.w >= 3)), 40);          // the big strategy shelf
take(byTaste(pool.filter((g) => coop(g))), 30);            // co-ops
take(byTaste(pool.filter((g) => party(g) && g.w < 2.2)), 22); // party and table-talk games
take(byTaste(pool.filter((g) => two(g))), 14);             // two-player
take(byTaste(pool.filter((g) => g.w < 2.3)), 22);          // light and family
take(byTaste(pool), 150);                                  // the rest, by taste
const games = [...chosen.values()];

// How much he plays each: favorites a lot, a long middle, and an honest shelf of shame
const ranked = games.map((g) => ({ g, s: taste(g) + rnd() * 1.5 })).sort((a, b) => b.s - a.s);
const plan = ranked.map((x, i) => {
  const tier = i < 12 ? 'fav' : i < 60 ? 'liked' : i < 125 ? 'ok' : 'shame';
  const plays = tier === 'fav' ? 14 + Math.floor(rnd() * 26) : tier === 'liked' ? 4 + Math.floor(rnd() * 12) : tier === 'ok' ? Math.floor(rnd() * 5) : 0;
  return { ...x.g, tier, plays, order: i };
});

const group = ['Priya Patel', 'Marcus Lee', 'Elena Rossi', 'Sam Okafor', 'Jo Becker'];
const ME = 'Nathan Schmidt';
const start = Date.parse('2023-11-01'), end = Date.parse('2026-10-18');
const plays = [];
let pid = 900000000;
for (const g of plan) {
  for (let k = 0; k < g.plays; k++) {
    // Favorites stay in rotation; others cluster earlier (the honeymoon), with a few recent returns
    const t = g.tier === 'fav' ? rnd() : rnd() < 0.8 ? rnd() * 0.7 : 0.7 + rnd() * 0.3;
    const date = new Date(start + t * (end - start)).toISOString().slice(0, 10);
    const maxSeats = Math.min(g.mx || 4, 5);
    const n = g.mx === 1 ? 1 : Math.max(g.mn || 2, Math.min(maxSeats, 2 + Math.floor(rnd() * 3)));
    const others = [...group].sort(() => rnd() - 0.5).slice(0, Math.max(0, n - 1));
    const seats = [ME, ...others];
    const co = coop(g);
    const teamWin = rnd() < 0.55;
    const winner = co ? null : pick(seats.concat(rnd() < 0.15 ? [ME] : []));
    plays.push({ id: pid++, date, quantity: 1, minutes: g.tm || 60, incomplete: false, location: rnd() < 0.7 ? 'Home' : pick(['Priya\'s', 'Game café', 'Marcus\'s']),
      bggId: g.bgg, gameName: g.t, comments: '',
      players: seats.map((name, i) => ({ seat: i + 1, name, user: '', win: co ? teamWin : name === winner, score: '', isNew: k === 0 })) });
  }
}

// His own stars (BGC): played games he has an opinion on, following his taste
const half = (x) => Math.min(5, Math.max(0.5, Math.round(x * 2) / 2));
const rated = plan.filter((g) => g.plays > 0 && (g.tier !== 'ok' || rnd() < 0.5))
  .map((g) => ({ g, s: taste(g) + (g.tier === 'fav' ? 1.5 : 0) + (rnd() - 0.5) * 1.2 })).sort((a, b) => b.s - a.s);
// Stars on a curve: a few 5s, mostly 3.5-4.5, and some lukewarm ones
const curve = [[0.12, 5], [0.32, 4.5], [0.55, 4], [0.75, 3.5], [0.88, 3], [0.95, 2.5], [1, 2]];
const ratings = rated.map((x, i) => ({ bgg: x.g.bgg, stars: curve.find(([p]) => (i + 0.5) / rated.length <= p)[1] }));
const shelf = plan.slice().sort((a, b) => a.t.localeCompare(b.t)).map((g, i) => ({
  bgg: g.bgg, num: i + 1, favorite: g.tier === 'fav' && rnd() < 0.85,
  want: g.tier === 'shame' ? 3 + Math.floor(rnd() * 3) : g.tier === 'fav' ? 4 + Math.floor(rnd() * 2) : Math.floor(rnd() * 4),
  thinning: g.tier === 'ok' && g.plays <= 1 && rnd() < 0.25,
}));

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const EMAIL = 'nathan.schmidt@curator.invalid';
const sql = `-- Demo member: Nathan Schmidt (no Google account, cannot sign in). Generated by nathan-seed.js.
BEGIN;
DO $seed$
DECLARE mid bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM members WHERE google_email = ${q(EMAIL)}) THEN RAISE EXCEPTION 'Nathan Schmidt already exists'; END IF;
  INSERT INTO members (google_email, display_name, complexity, conflict, luck, table_talk, theme, likes, dislikes, about, age, import_status)
  VALUES (${q(EMAIL)}, 'Nathan Schmidt', 4, 2, 2, 4, 4,
    ${q('Engine builders, clever co-ops, anything with a great "aha" moment, trick-takers, beautiful nature and space themes, teaching a new game to friends')},
    ${q('Heavy take-that, player elimination, games that run an hour past their welcome')},
    ${q('Demo profile: a board game curator who plays a bit of everything and keeps an honest shelf of shame. Plays and ratings are sample data.')},
    41, jsonb_build_object('state', 'done', 'step', 'Done'))
  RETURNING id INTO mid;
  INSERT INTO shelves (member_id, game_id, num, legacy_id, favorite, want_to_play, thinning)
  SELECT mid, g.id, x.num, at.new_key(), x.favorite, x.want, x.thinning
  FROM jsonb_to_recordset(${q(JSON.stringify(shelf))}::jsonb) AS x(bgg int, num int, favorite boolean, want int, thinning boolean)
  JOIN games g ON g.bgg_id = x.bgg;
  PERFORM at.save_plays(${q(EMAIL)}, ${q(JSON.stringify(plays))}::jsonb);
  PERFORM bgc.refresh_member(${q(EMAIL)});
  INSERT INTO ratings (member_id, game_id, stars)
  SELECT mid, g.id, x.stars FROM jsonb_to_recordset(${q(JSON.stringify(ratings))}::jsonb) AS x(bgg int, stars numeric) JOIN games g ON g.bgg_id = x.bgg
  ON CONFLICT (member_id, game_id) DO UPDATE SET stars = EXCLUDED.stars;
  -- Friends with Dan
  INSERT INTO friendships (requester_id, addressee_id, status, accepted_at) VALUES (mid, at.admin_id(), 'accepted', now()) ON CONFLICT DO NOTHING;
END $seed$;
COMMIT;
`;
fs.writeFileSync(outFile, sql);
fs.writeFileSync(outFile.replace(/\.sql$/, '-ratings.sql'), [
  'BEGIN;',
  'DELETE FROM ratings WHERE member_id = (SELECT id FROM members WHERE google_email = ' + q(EMAIL) + ');',
  'INSERT INTO ratings (member_id, game_id, stars) SELECT m.id, g.id, x.stars FROM members m, jsonb_to_recordset(' + q(JSON.stringify(ratings)) + '::jsonb) AS x(bgg int, stars numeric) JOIN games g ON g.bgg_id = x.bgg WHERE m.google_email = ' + q(EMAIL) + ';',
  'COMMIT;', ''].join('\n'));
console.log(JSON.stringify({ games: games.length, plays: plays.length, rated: ratings.length, favorites: shelf.filter((s) => s.favorite).length,
  shame: plan.filter((g) => g.tier === 'shame').length, heavy: games.filter((g) => g.w >= 3).length, coop: games.filter(coop).length,
  top: plan.slice(0, 12).map((g) => g.t + ' (' + g.plays + ')') }, null, 1));
