// Phase 1 migration: build SQL that loads Dan's shelf, players and full BGG play history into the new database.
//   node airtable-to-postgres.js > load.sql     (reads the live site's public endpoints and the BGG XML API)
//   docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < load.sql
// Env: BGG_TOKEN (BGG XML API bearer token). Safe to re-run: it replaces everything it loads, in one transaction.
const N8N = 'https://n8n.ondorilabo.com/webhook/vault';
const BGG_USER = 'daddo_78';
const OWNER = { email: 'dandehaan@gmail.com', name: 'Dan DeHaan' };
const INVITED = { 'aaron.wiesinger@gmail.com': 'Aaron Wiesinger', 'matthewrkruse@gmail.com': 'Matt Kruse' };

const q = (v) => v === null || v === undefined || v === '' && false ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
const lit = (v) => (v === null || v === undefined) ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v) : q(v);
const arr = (list, type) => 'ARRAY[' + (list || []).map((x) => type === 'text' ? q(x) : String(Number(x))).join(',') + ']::' + type + '[]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unxml = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
const attr = (tag, name) => { const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"')); return m ? unxml(m[1]) : ''; };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}
async function bggPlays() {
  const out = [];
  for (let page = 1; page < 100; page++) {
    let xml = '';
    for (let tries = 0; tries < 5; tries++) {
      const r = await fetch(`https://boardgamegeek.com/xmlapi2/plays?username=${BGG_USER}&page=${page}`, { headers: { Authorization: 'Bearer ' + process.env.BGG_TOKEN } });
      if (r.status === 200) { xml = await r.text(); break; }
      await sleep(3000 * (tries + 1));
    }
    if (!xml) throw new Error('BGG plays page ' + page + ' failed');
    const plays = xml.match(/<play [\s\S]*?<\/play>/g) || [];
    if (!plays.length) break;
    for (const p of plays) {
      const head = p.match(/<play [^>]*>/)[0];
      const item = (p.match(/<item [^>]*>/) || [''])[0];
      const players = (p.match(/<player [^>]*\/?>/g) || []).map((t, i) => ({
        seat: i + 1, name: attr(t, 'name') || attr(t, 'username') || 'Anonymous', user: attr(t, 'username'),
        win: attr(t, 'win') === '1', score: attr(t, 'score'), isNew: attr(t, 'new') === '1',
      }));
      const comments = (p.match(/<comments>([\s\S]*?)<\/comments>/) || ['', ''])[1];
      out.push({
        id: Number(attr(head, 'id')), date: attr(head, 'date') || null, quantity: Number(attr(head, 'quantity')) || 1,
        minutes: Number(attr(head, 'length')) || null, incomplete: attr(head, 'incomplete') === '1', location: attr(head, 'location'),
        bggId: Number(attr(item, 'objectid')), gameName: attr(item, 'name'), comments: unxml(comments).trim(), players,
      });
    }
    process.stderr.write(`plays page ${page}: ${plays.length}\n`);
    await sleep(2500); // be polite to BGG
  }
  return out;
}

(async () => {
  if (!process.env.BGG_TOKEN) throw new Error('Set BGG_TOKEN');
  const col = await getJson(N8N + '/collection');
  const games = Array.isArray(col) ? col : col.items;
  const people = (await getJson(N8N + '/people')).players;
  const plays = await bggPlays();
  const sql = [];
  const line = (s) => sql.push(s);

  line('BEGIN;');
  line('TRUNCATE play_players, plays, ratings, bgg_ratings, friend_takes, friendships, players, shelves, games, members RESTART IDENTITY CASCADE;');

  // Members: Dan (admin) and the invited testers
  line(`INSERT INTO members (google_email, display_name, bgg_username, is_admin) VALUES (${q(OWNER.email)}, ${q(OWNER.name)}, ${q(BGG_USER)}, true);`);
  for (const [email, name] of Object.entries(INVITED)) line(`INSERT INTO members (google_email, display_name) VALUES (${q(email)}, ${q(name)});`);
  const member = (email) => `(SELECT id FROM members WHERE google_email = ${q(email)})`;
  const DAN = member(OWNER.email);

  // Catalog: one row per game; games without BGG data have no bgg_id
  const seenBgg = new Set();
  for (const g of games) {
    if (g.bggId && seenBgg.has(g.bggId)) throw new Error('Two shelf games share BGG id ' + g.bggId + ' (' + g.title + ')');
    if (g.bggId) seenBgg.add(g.bggId);
    line(`INSERT INTO games (bgg_id, title, year, min_players, max_players, best_players, min_time, max_time, min_age, weight, bgg_rating, bgg_rank, designers, categories, mechanics, genre, type, description, icon, cover_card, cover_large, enriched_at) VALUES (` +
      [lit(g.bggId || null), q(g.title), lit(g.year), lit(g.minPlayers), lit(g.maxPlayers), arr(g.bestPlayers, 'smallint'), lit(g.minTime), lit(g.maxTime), lit(g.minAge),
        lit(g.weight), lit(g.bggRating), lit(g.rank), arr(g.designers, 'text'), arr(g.categories, 'text'), arr(g.mechanics, 'text'),
        q(g.genre || ''), q(g.type || ''), q(g.desc || ''), q(g.icon || 'meeple'), lit(g.coverCard), lit(g.coverLarge), g.bggId ? 'now()' : 'NULL'].join(', ') + ');');
    const gameRef = g.bggId ? `(SELECT id FROM games WHERE bgg_id = ${g.bggId})` : `(SELECT id FROM games WHERE bgg_id IS NULL AND title = ${q(g.title)} ORDER BY id DESC LIMIT 1)`;
    line(`INSERT INTO shelves (member_id, game_id, num, favorite, want_to_play, thinning, expansions, extra_bgg_ids, play_count, last_played, legacy_id, added_at) VALUES (` +
      [DAN, gameRef, lit(g.num), lit(!!g.favorite), lit(g.desireToPlay || 0), lit(!!g.thinningCandidate), arr(g.expansions, 'text'), arr(g.extraBggIds, 'integer'),
        lit(g.playCount || 0), lit(g.lastPlayed), q(g.id), g.addedAt ? q(g.addedAt) : 'now()'].join(', ') + ');');
  }

  // Games played but not owned: a bare catalog row (enriched later)
  for (const p of plays) {
    if (!p.bggId || seenBgg.has(p.bggId)) continue;
    seenBgg.add(p.bggId);
    line(`INSERT INTO games (bgg_id, title) VALUES (${p.bggId}, ${q(p.gameName || 'BGG #' + p.bggId)});`);
  }

  // Dan's players (BG Stats names), linked to members where the email matches
  const emailFor = { 'Dan DeHaan': OWNER.email, ...Object.fromEntries(Object.entries(INVITED).map(([e, n]) => [n, e])) };
  for (const p of people) {
    const link = emailFor[p.name] ? member(emailFor[p.name]) : 'NULL';
    line(`INSERT INTO players (owner_id, name, aliases, active, linked_member_id, bgg_username, legacy_id) VALUES (${DAN}, ${q(p.name)}, ${arr(p.aliases, 'text')}, ${lit(!!p.active)}, ${link}, ${lit(p.bggUsername || null)}, ${q(p.id)});`);
  }

  // Plays, with each seat matched to a player by name or alias
  const byName = {};
  for (const p of people) for (const n of [p.name, ...(p.aliases || [])]) byName[n.toLowerCase()] = p.name;
  for (const p of plays) {
    line(`INSERT INTO plays (owner_id, bgg_play_id, played_on, game_id, bgg_id, game_name, quantity, minutes, location, comments, incomplete) VALUES (` +
      [DAN, p.id, lit(p.date), `(SELECT id FROM games WHERE bgg_id = ${p.bggId})`, p.bggId, q(p.gameName), p.quantity, lit(p.minutes), q(p.location), q(p.comments), lit(p.incomplete)].join(', ') + ');');
    for (const s of p.players) {
      const known = byName[s.name.toLowerCase()];
      const pid = known ? `(SELECT id FROM players WHERE owner_id = ${DAN} AND name = ${q(known)})` : 'NULL';
      line(`INSERT INTO play_players (play_id, seat, player_id, name, bgg_user, win, score, is_new) VALUES ((SELECT id FROM plays WHERE owner_id = ${DAN} AND bgg_play_id = ${p.id}), ${s.seat}, ${pid}, ${q(s.name)}, ${q(s.user)}, ${lit(s.win)}, ${q(s.score)}, ${lit(s.isNew)});`);
    }
  }
  line('COMMIT;');
  process.stdout.write(sql.join('\n') + '\n');
  process.stderr.write(`games ${games.length}, players ${people.length}, plays ${plays.length}, seats ${plays.reduce((n, p) => n + p.players.length, 0)}\n`);
})().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
