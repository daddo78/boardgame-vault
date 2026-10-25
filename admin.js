// The admin portal: dashboard, members, Nathan, rulebooks, feedback and costs. api.js (loaded first) holds the server addresses and shared helpers.
const app = document.getElementById('app');
const nav = document.getElementById('nav');
const claims = (t) => { try { return decodeJwt(t); } catch (e) { return null; } }; // null rather than a throw: a missing token is normal here
const fresh = (t) => { const c = t && claims(t); return !!(c && c.exp * 1000 > Date.now() + 30000); };
const token = () => { try { return localStorage.getItem(LS_TOKEN); } catch (e) { return null; } };
const ago = (iso) => { if (!iso) return 'never'; const m = (Date.now() - Date.parse(iso)) / 60000; return m < 2 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const num = (n) => n == null ? '–' : Number(n).toLocaleString();
const KIND = { recommend: 'What to play', browse: 'Lists & top tens', person: 'About people', game: 'About a game', buy: 'Buy ideas', rules: 'Rules', 'off-topic': 'Off-topic', other: 'Other' };
const COLORS = ['#c9342a', '#0041c2', '#ffa726', '#a3d977', '#b384dc', '#8ac4f5', '#ffd166', '#7b8494'];
const TABS = ['dashboard', 'members', 'nathan', 'rulebooks', 'feedback', 'costs'];
let toastTimer = null;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ---- Signing in (only when the shelf's sign-in has expired)
function gate(msg, withButton) {
  nav.hidden = true;
  app.innerHTML = '<div class="gate"><h1><i class="fa-solid fa-shield-halved"></i> Admin</h1><p>' + msg + '</p>' + (withButton ? '<div class="gbtn" id="gbtn"></div>' : '') +
    '<p style="margin:1rem 0 0;"><a href="./">Back to the shelf</a></p></div>';
  if (!withButton) return;
  const draw = () => {
    if (!(window.google && google.accounts)) return setTimeout(draw, 300);
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (r) => { try { localStorage.setItem(LS_TOKEN, r.credential); } catch (e) {} start(); }, auto_select: true, use_fedcm_for_prompt: true });
    google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with' });
    google.accounts.id.prompt();
  };
  draw();
}
// Requests whose area is switched on for you (New API, on the Dashboard) go to api.ondorilabo.com, as on the shelf;
// n8n otherwise, and whenever the new service can't be reached
let apiRoutesP = null;
const apiRoutes = () => (apiRoutesP ??= fetch(API + '/routes', { headers: { Authorization: 'Bearer ' + token() }, signal: AbortSignal.timeout(4000) })
  .then((r) => (r.ok ? r.json() : {})).then((b) => new Set(b.routes || [])).catch(() => new Set()));
class Gate extends Error { constructor(msg, button) { super(msg); this.button = button; } }
async function call(path, opts = {}) {
  const t = token();
  if (!fresh(t)) throw new Gate('Sign in with your Google account to open Admin. It’s for admins only.', true);
  let res;
  try { res = await routedFetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } }); }
  catch (e) { throw new Gate('Couldn’t reach the server. Check your connection and refresh.', false); }
  if (res.status === 401) { try { localStorage.removeItem(LS_TOKEN); } catch (e) {} throw new Gate('Your sign-in expired. Sign in again to open Admin.', true); }
  if (res.status === 403) throw new Gate('Admin is for admins only.', false);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.message || 'Something went wrong (' + res.status + '). Try again in a moment.');
  return body;
}
const post = (path, payload) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

// ---- Data: the dashboard and the admin list, each loaded once and refreshed after a change
let D = null, A = null, C = null;
const loadD = async (force) => (D && !force) ? D : (D = await call('/dashboard'));
const loadA = async (force) => {
  if (A && !force) return A;
  A = await call('/admin');
  document.getElementById('nMembers').textContent = (A.members || []).length || '';
  document.getElementById('nRules').textContent = (A.rulebooks || []).length || '';
  document.getElementById('nFeedback').textContent = (A.feedback || {}).open || '';
  return A;
};

// ---- Sections, one per address: #dashboard, #members, #nathan, #rulebooks
let current = null;
async function show() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  current = tab;
  nav.querySelectorAll('[data-tab]').forEach((a) => { a.classList.toggle('on', a.dataset.tab === tab); a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'); });
  app.innerHTML = '<div class="spinner"></div>';
  try {
    if (tab === 'dashboard') renderDashboard(await loadD());
    else if (tab === 'members') renderMembers(await loadA());
    else if (tab === 'nathan') { const [a, d] = await Promise.all([loadA(), loadD()]); renderNathan(a, d); }
    else if (tab === 'costs') renderCosts(C = await call('/costs'));
    else if (tab === 'feedback') renderFeedback(await loadA());
    else renderRulebooks(await loadA());
  } catch (e) {
    if (e instanceof Gate) return gate(e.message, e.button);
    app.innerHTML = '<div class="card"><p>' + esc(e.message) + '</p></div>';
  }
}
async function start() {
  const t = token();
  if (!fresh(t)) return gate('Sign in with your Google account to open Admin. It’s for admins only.', true);
  const c = claims(t);
  document.getElementById('who').textContent = c.name || c.email || '';
  try { await loadA(); } catch (e) { if (e instanceof Gate) return gate(e.message, e.button); }
  nav.hidden = false;
  show();
}
window.addEventListener('hashchange', () => { if (!nav.hidden) { armed = null; show(); window.scrollTo(0, 0); } });

// ================= Dashboard =================
let days = 30, sortKey = 'score', sortDir = -1;
const charts = {};
function renderDashboard(d) {
  const k = d.kpis;
  const tile = (n, label, small) => '<div class="tile"><b>' + n + '</b><span>' + label + '</span>' + (small ? '<small>' + small + '</small>' : '') + '</div>';
  app.innerHTML =
    '<h1><i class="fa-solid fa-chart-line"></i> Dashboard</h1>' +
    '<div class="sub">How people use Board Game Curator · updated ' + esc(new Date(d.generatedAt).toLocaleString()) + ' · times are Eastern</div>' + selfTestHtml(d.selfTest) + apiCheckHtml() +
    '<div class="tiles">' +
      tile(num(k.members), 'Members') + tile(num(k.activeToday), 'Active today') + tile(num(k.active7), 'Active this week') + tile(num(k.active30), 'Active this month', 'avg ' + num(k.avgDaily30) + ' a day') +
      tile(num(k.questions7), 'Questions this week') + tile(num(k.questions30), 'Questions this month', num(k.questionsAll) + ' all time') +
      tile(k.answerSec7 != null ? k.answerSec7 + 's' : '–', 'Avg answer time', 'last 7 days') + tile(k.answerOk30 != null ? k.answerOk30 + '%' : '–', 'Answers that worked', 'last 30 days') +
      tile(num(k.uniqueGames), 'Different games', num(k.games) + ' copies on shelves') + tile(num(k.gamesAdded30), 'Games added', 'last 30 days') +
      tile(num(k.ratings30), 'Ratings given', 'last 30 days · ' + num(k.ratings) + ' total') + tile(num(k.wishlist), 'Wishlist items') +
      tile(num(k.friendships), 'Friendships') + tile(num(k.rulebooks), 'Rulebooks') + tile(num(k.plays), 'Plays logged') +
    '</div>' +
    '<h2><i class="fa-solid fa-users"></i> Activity <span class="seg" id="range"><button data-days="30" class="on">30 days</button><button data-days="90">90 days</button></span></h2>' +
    '<div class="grid2">' +
      '<div class="card"><h3>People and questions <small>members active each day, questions to Nathan</small></h3><div class="chart"><canvas id="cActivity"></canvas></div></div>' +
      '<div class="card"><h3>Shelf activity <small>games added, ratings, wishlist adds, new friends</small></h3><div class="chart"><canvas id="cShelf"></canvas></div></div>' +
    '</div>' +
    '<h2><i class="fa-solid fa-comments"></i> Nathan</h2>' +
    '<div class="grid3">' +
      '<div class="card"><h3>What people ask <small>last 30 days</small></h3><div class="chart sm"><canvas id="cKinds"></canvas></div><div class="note">Kinds of questions only, never the questions themselves.</div></div>' +
      '<div class="card"><h3>When people ask <small>by hour, last 30 days</small></h3><div class="chart sm"><canvas id="cHours"></canvas></div></div>' +
      '<div class="card"><h3>Which days <small>last 30 days</small></h3><div class="chart sm"><canvas id="cDays"></canvas></div></div>' +
      '<div class="card"><h3>Answer speed <small>average seconds per day</small></h3><div class="chart sm"><canvas id="cSpeed"></canvas></div></div>' +
      '<div class="card"><h3>Questions with friends <small>last 30 days</small></h3>' + socialHtml(d) + '</div>' +
      '<div class="card"><h3>Daily limit</h3><div style="font-size:2rem; font-weight:800; color:var(--brand);">' + d.askLimit + '</div><div class="note">questions per member per day · <a href="#nathan">change it</a></div></div>' +
    '</div>' +
    '<h2><i class="fa-solid fa-trophy"></i> Top users</h2>' +
    '<div class="table-wrap"><table id="users"></table></div>' +
    '<div class="note">Ranked by an overall activity score: days active ×3, questions ×2, games added and ratings in the last 30 days. Click a column to sort. Manage people under <a href="#members">Members</a>.</div>' +
    '<h2><i class="fa-solid fa-seedling"></i> Getting started</h2>' +
    '<div class="card adopt" id="adopt"></div>' +
    '<h2><i class="fa-solid fa-dice"></i> The games</h2>' +
    '<div class="grid3">' +
      gamesCard('Owned by the most members', d.mostOwned, (g) => g.n + ' members', (g) => g.who) +
      gamesCard('Played by the most members', d.mostPlayed, (g) => g.n + (g.n === 1 ? ' member' : ' members'), (g) => g.who) +
      gamesCard('Highest rated by members', d.topRated, (g) => Number(g.avg).toFixed(1) + '★', (g) => g.n + ' ratings') +
      gamesCard('Wished for by the most members', d.mostWished, (g) => g.n + (g.n === 1 ? ' member' : ' members')) +
      gamesCard('Recently added by members', d.recentlyAdded, (g) => '', (g) => g.who + ' · ' + ago(g.at)) +
    '</div>';
  document.getElementById('apiCheckGo').addEventListener('click', () => { document.getElementById('apiWrap').open = true; runApiCheck().then(apiFoldLabel); });
  document.getElementById('apiFold').addEventListener('click', apiFold);
  document.getElementById('apiWrap').addEventListener('toggle', apiFoldLabel, true); // toggle doesn't bubble: listen while it passes down
  apiFoldLabel();
  loadApiAreas();
  document.getElementById('range').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (b) { days = Number(b.dataset.days); document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b)); drawActivity(); } });
  drawActivity();
  drawNathan();
  renderUsers();
  renderAdoption();
}
// The nightly self-test: the site's rules and Nathan's question set
function selfTestHtml(t) {
  if (!t) return '';
  const bad = (t.failures || []).length;
  return '<div class="card status" style="margin-top:0.9rem; border-left:5px solid ' + (bad ? 'var(--brand)' : 'var(--ok)') + ';">' +
    '<i class="fa-solid ' + (bad ? 'fa-triangle-exclamation' : 'fa-circle-check') + '" style="color:' + (bad ? 'var(--brand)' : 'var(--ok)') + ';"></i>' +
    '<div><b>Nightly check ' + (bad ? 'found ' + bad + ' problem' + (bad === 1 ? '' : 's') : 'passed') + '</b><div class="note" style="margin:0;">' + esc(ago(t.at)) + ' · site rules ' + t.dbPassed + '/' + t.dbTotal + ' · Nathan questions ' + t.nathanPassed + '/' + t.nathanTotal + '</div>' +
    (bad ? '<div class="note" style="margin:0.3rem 0 0;">' + t.failures.map((f) => esc(f.what) + (f.problems && f.problems.length ? ': ' + esc(f.problems.join('; ')) : '')).join('<br>') + '</div>' : '') + '</div></div>';
}
// The new API (Roadmap 7, Phase 3): each area of the site moves from n8n to api.ondorilabo.com behind its own switch.
// The check asks both the same things with your sign-in and compares the answers; turn an area on once it's all ✅.
const AREA_NAMES = { account: 'Account (sign-in, profiles, Nathan’s memory)', shelves: 'Shelves (collection, your shelf, friends, people)', wishlist: 'Wishlists', rulebooks: 'Rulebooks', admin: 'Admin (this page)',
  accountChanges: 'Account changes (saving your profile, forgetting notes)', wishlistChanges: 'Wishlist changes (add, remove, “Got it!”)', rulebookChanges: 'Rulebook changes (admins editing or removing a document)',
  shelfChanges: 'Shelf changes (stars, favorites, want-to-play, thinning, removing a game)', friendChanges: 'Friend changes (adding by code, removing)',
  adminChanges: 'Admin changes (saving a player card, fixed costs)', addGames: 'Adding games (searching BGG, adding one to your own shelf)',
  feedback: 'Feedback (saved, and emailed to Dan)', memberActions: 'Member actions (invites with their welcome email, removing, admins, question limits)',
  photos: 'Photos (a box or a shelf, onto your own shelf)', imports: 'Imports (BGG plays and spreadsheets; the jobs worker finishes them)', rulebookUpload: 'Rulebook uploads (the PDF to the page service, then Nathan reads it)' };
// Only admins use these, so "Admins only" and "Everyone" would be the same: a plain Off / On ("On" is admins)
const ADMIN_AREAS = ['admin', 'rulebookChanges', 'adminChanges', 'memberActions'];
const modeOf = (a, m) => (ADMIN_AREAS.includes(a) && m === 'everyone' ? 'admins' : m);
// What the check asks in each area; {friend} and {bgg} are filled from n8n's own answers
const AREA_CHECKS = {
  account: ['/whoami', '/me', '/profile', '/profile?friend={friend}', '/memory?chat=none'],
  shelves: ['/shelf', '/people', '/people?shelf=mine', '/people?shelf=friend:{friend}', '/friends', '/friends?shelf={friend}'],
  wishlist: ['/wishlist', '/wishlist?friend={friend}'],
  rulebooks: ['/rulebook?games=1', '/rulebook?bgg={bgg}'],
  admin: ['/admin', '/dashboard', '/costs', '/players-admin'],
  addGames: ['/bgg-search?q=catan', '/bgg-search?q=wingspan'],
};
// Parts of an answer that change between two asks a moment apart (each ask is itself a visit: bgc.sign_in counts it)
const VOLATILE = ['generatedAt', 'lastSeen', 'visits', 'visits30'];
function apiCheckHtml() {
  return '<div class="card" style="margin-top:0.9rem;"><h3>New API <small>which parts of the site api.ondorilabo.com serves instead of n8n</small></h3>' +
    '<div class="note" style="margin:0 0 0.6rem;">Run the check, then turn an area on (admins first) once all its answers match n8n. If the new service can’t be reached, the site asks n8n anyway. Nathan has his own switch under <a href="#nathan">Nathan</a>.</div>' +
    '<div style="display:flex; gap:0.5rem; flex-wrap:wrap;"><button type="button" class="btn small" id="apiCheckGo">Run check</button>' +
    '<button type="button" class="btn small" id="apiFold"></button></div>' +
    '<details class="api-wrap" id="apiWrap"' + (foldOpen() ? ' open' : '') + '><summary id="apiSummary">The switches</summary>' +
    '<div id="apiAreas" style="margin-top:0.4rem;"><div class="note">Checking the switches…</div></div></details></div>';
}
// The switches fold away to one line; the choice is remembered on this device
const LS_API_FOLD = 'admin_api_open';
function foldOpen() { try { return localStorage.getItem(LS_API_FOLD) === '1'; } catch (e) { return false; } }
function apiFoldLabel() {
  const any = [...document.querySelectorAll('#apiWrap, #apiWrap details')].some((d) => d.open);
  const b = document.getElementById('apiFold');
  if (b) b.innerHTML = any ? '<i class="fa-solid fa-angles-up"></i> Collapse all' : '<i class="fa-solid fa-angles-down"></i> Expand all';
}
function apiFold() {
  const all = [...document.querySelectorAll('#apiWrap, #apiWrap details')];
  const open = !all.some((d) => d.open);
  all.forEach((d) => { d.open = open; });
  try { localStorage.setItem(LS_API_FOLD, open ? '1' : '0'); } catch (e) {}
  apiFoldLabel();
}
// "6 for everyone · 2 admins only · 4 off", shown when the switches are folded away
function apiSummary(areas) {
  const n = { everyone: 0, admins: 0, off: 0 };
  for (const a of Object.keys(AREA_NAMES)) n[ADMIN_AREAS.includes(a) && areas[a] === 'everyone' ? 'admins' : areas[a] || 'off']++;
  const s = document.getElementById('apiSummary');
  if (s) s.textContent = Object.keys(AREA_NAMES).length + ' switches: ' + [n.everyone && n.everyone + ' for everyone', n.admins && n.admins + ' for admins', n.off && n.off + ' off'].filter(Boolean).join(' · ');
}
async function loadApiAreas() {
  const box = document.getElementById('apiAreas');
  let areas;
  try { areas = (await apiCall('/api-areas')).areas; }
  catch (e) { box.innerHTML = '<div class="note">Couldn’t reach the new service: ' + esc(e.message) + '</div>'; return; }
  apiSummary(areas);
  box.innerHTML = Object.keys(AREA_NAMES).map((a) => '<div style="padding:0.45rem 0; border-top:1px solid var(--soft);">' +
    '<div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center; justify-content:space-between;"><b>' + esc(AREA_NAMES[a]) + '</b>' +
    '<span class="seg" data-area="' + a + '">' + (ADMIN_AREAS.includes(a) ? ['off', 'admins'] : ['off', 'admins', 'everyone']).map((m) => '<button type="button" data-mode="' + m + '"' + (modeOf(a, areas[a]) === m ? ' class="on"' : '') + '>' +
      (ADMIN_AREAS.includes(a) ? { off: 'Off', admins: 'On' } : { off: 'Off', admins: 'Admins only', everyone: 'Everyone' })[m] + '</button>').join('') + '</span></div>' +
    '<div class="note" id="apiCheck-' + a + '" style="margin:0.25rem 0 0;">' + (AREA_CHECKS[a] ? '' : 'Changes aren’t made twice to compare: they’re covered by the API tests and a run on the real database before each goes live.') + '</div></div>').join('');
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mode]'), seg = b && b.closest('[data-area]');
    if (!seg) return;
    try {
      const r = await apiCall('/api-areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ area: seg.dataset.area, mode: b.dataset.mode }) });
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.mode === modeOf(seg.dataset.area, r.areas[seg.dataset.area])));
      apiSummary(r.areas);
      apiRoutesP = null; // this page follows the switches too
      toast('Saved. Pages pick it up the next time they load.');
    } catch (err) { toast(err.message, true); }
  });
}
async function runApiCheck() {
  const t = token();
  if (!fresh(t)) { toast('Your sign-in expired. Refresh the page to sign in again.', true); return; }
  const canon = (v) => JSON.stringify(v, (k, x) => (VOLATILE.includes(k) ? undefined : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
  // Where two answers part ways, e.g. "items[3].playCount", for the console
  const diff = (a, b, at = '') => {
    if (canon(a) === canon(b)) return [];
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !VOLATILE.includes(k));
      return keys.flatMap((k) => diff(a[k], b[k], at + (Array.isArray(a) ? '[' + k + ']' : (at ? '.' : '') + k)));
    }
    return [at || '(whole answer)'];
  };
  const ask = async (base, p) => {
    const t0 = performance.now();
    try { const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + t } }); return { status: r.status, body: await r.json().catch(() => null), ms: Math.round(performance.now() - t0) }; }
    catch (e) { return { status: 0, body: null, ms: Math.round(performance.now() - t0) }; }
  };
  const fill = {};
  const n8nFriends = await ask(N8N_BASE, '/friends'), n8nRules = await ask(N8N_BASE, '/rulebook?games=1');
  fill.friend = (((n8nFriends.body || {}).friends || [])[0] || {}).id;
  fill.bgg = ((n8nRules.body || {}).games || [])[0];
  for (const [area, paths] of Object.entries(AREA_CHECKS)) {
    const out = document.getElementById('apiCheck-' + area);
    if (!out) continue;
    out.textContent = 'Checking…';
    const rows = [];
    for (const raw of paths) {
      const missing = (raw.match(/\{(\w+)\}/g) || []).find((m) => fill[m.slice(1, -1)] == null);
      if (missing) { rows.push('➖ <b>' + esc(raw.slice(1)) + '</b> · skipped, no ' + missing.slice(1, -1) + ' to try it with'); continue; }
      const p = raw.replace(/\{(\w+)\}/g, (m, k) => encodeURIComponent(fill[k]));
      const [a, n] = await Promise.all([ask(API, p), ask(N8N_BASE, p)]);
      const same = a.status === n.status && canon(a.body) === canon(n.body);
      const why = a.status === 0 ? 'couldn’t reach the API' : same ? 'same answer as n8n' + (a.status !== 200 ? ' (' + a.status + ')' : '')
        : a.status !== n.status ? 'API said ' + a.status + ', n8n ' + n.status + ((a.body || {}).message ? ': ' + a.body.message : '')
        : 'differs at ' + diff(a.body, n.body).slice(0, 3).join(', ');
      rows.push((same ? '✅ ' : '❌ ') + '<b>' + esc(p.slice(1)) + '</b> · ' + esc(why) + ' · API ' + a.ms + ' ms, n8n ' + n.ms + ' ms');
      if (!same) console.log('API check ' + p, { api: a, n8n: n });
    }
    // Each area's results fold to one line; one that differs from n8n opens by itself
    const bad = rows.filter((x) => x.startsWith('❌')).length;
    out.innerHTML = '<details class="api-res"' + (bad ? ' open' : '') + '><summary>' + (bad ? '❌ ' + bad + ' of ' + rows.length + ' differ from n8n' : '✅ ' + rows.length + ' checked, the same as n8n') + '</summary>' + rows.join('<br>') + '</details>';
  }
}
function socialHtml(d) {
  const s = d.askSocial || {};
  const total = Object.values(d.askKinds || {}).reduce((a, b) => a + b, 0);
  const row = (label, n) => '<div class="adopt"><div class="row">' + label + ' <b>' + num(n) + '</b><div class="meter"><div style="width:' + (total ? Math.round(n / total * 100) : 0) + '%"></div></div></div></div>';
  return total ? row('Across friends’ shelves ("who has…")', s.friends || 0) + '<div style="height:0.5rem"></div>' + row('At a friend’s place', s.visit || 0) : '<p class="empty">No questions yet.</p>';
}
function gamesCard(title, list, right, sub) {
  return '<div class="card"><h3>' + title + '</h3>' + ((list || []).length ? '<div class="games">' + list.map((g, i) => '<div class="g"><span class="rank">' + (i + 1) + '</span>' +
    (g.cover ? '<img src="' + esc(g.cover) + '" alt="" loading="lazy">' : '<span class="ph"></span>') +
    '<span class="t">' + esc(g.title) + (sub ? '<small>' + esc(sub(g) || '') + '</small>' : '') + '</span><span class="n">' + esc(right(g)) + '</span></div>').join('') + '</div>'
    : '<p class="empty">Nothing yet.</p>') + '</div>';
}
const base = (extra) => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
  plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { family: 'Outfit' } } }, tooltip: { titleFont: { family: 'Outfit' }, bodyFont: { family: 'Outfit' } } },
  scales: { x: { grid: { display: false }, ticks: { font: { family: 'Outfit' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }, y: { beginAtZero: true, ticks: { precision: 0, font: { family: 'Outfit' } } } }, ...extra });
const make = (id, cfg) => { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); };
const label = (day) => new Date(day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function drawActivity() {
  const s = D.daily.slice(-days);
  const x = s.map((d) => label(d.day));
  make('cActivity', { type: 'bar', data: { labels: x, datasets: [
    { type: 'line', label: 'Members active', data: s.map((d) => d.active), borderColor: COLORS[1], backgroundColor: COLORS[1], tension: 0.3, pointRadius: 0, yAxisID: 'y' },
    { type: 'bar', label: 'Questions', data: s.map((d) => d.questions), backgroundColor: 'rgba(201,52,42,0.75)', borderRadius: 3, yAxisID: 'y' },
  ] }, options: base() });
  make('cShelf', { type: 'bar', data: { labels: x, datasets: [
    { label: 'Games added', data: s.map((d) => d.gamesAdded), backgroundColor: COLORS[0], stack: 'a', borderRadius: 2 },
    { label: 'Ratings', data: s.map((d) => d.ratings), backgroundColor: COLORS[2], stack: 'a', borderRadius: 2 },
    { label: 'Wishlist adds', data: s.map((d) => d.wishes), backgroundColor: COLORS[4], stack: 'a', borderRadius: 2 },
    { label: 'New friends', data: s.map((d) => d.friendships), backgroundColor: COLORS[3], stack: 'a', borderRadius: 2 },
  ] }, options: base({ scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }) });
}
function drawNathan() {
  const kinds = Object.entries(D.askKinds || {}).sort((a, b) => b[1] - a[1]);
  make('cKinds', { type: 'doughnut', data: { labels: kinds.length ? kinds.map(([k]) => KIND[k] || k) : ['No questions yet'], datasets: [{ data: kinds.length ? kinds.map(([, n]) => n) : [1],
    backgroundColor: kinds.length ? COLORS : ['#e6e0d4'], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { family: 'Outfit' } } } } } });
  const hours = Array.from({ length: 24 }, (_, h) => (h % 12 || 12) + (h < 12 ? 'a' : 'p'));
  make('cHours', { type: 'bar', data: { labels: hours, datasets: [{ label: 'Questions', data: D.askHours, backgroundColor: COLORS[1], borderRadius: 2 }] }, options: base({ plugins: { legend: { display: false } } }) });
  make('cDays', { type: 'bar', data: { labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], datasets: [{ label: 'Questions', data: D.askWeekdays, backgroundColor: COLORS[2], borderRadius: 3 }] }, options: base({ plugins: { legend: { display: false } } }) });
  const s = D.daily.slice(-30);
  make('cSpeed', { type: 'line', data: { labels: s.map((d) => label(d.day)), datasets: [{ label: 'Seconds', data: s.map((d) => d.answerSec), borderColor: COLORS[0], backgroundColor: 'rgba(201,52,42,0.12)', fill: true, tension: 0.3, spanGaps: true, pointRadius: 2 }] },
    options: base({ plugins: { legend: { display: false } } }) });
}
const COLS = [
  ['name', 'Member'], ['score', 'Activity'], ['lastSeen', 'Last seen'], ['activeDays30', 'Days active (30d)'], ['visits30', 'Visits (30d)'],
  ['questions30', 'Questions (30d)'], ['questionsAll', 'Questions (all)'], ['favoriteKind', 'Asks most about'], ['games', 'Games'], ['gamesAdded30', 'Added (30d)'],
  ['plays', 'Plays'], ['ratings', 'Ratings'], ['wishlist', 'Wishlist'], ['friends', 'Friends'], ['top10', 'Top 10'], ['profile', 'Profile'],
];
function renderUsers() {
  const list = [...D.users].sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (sortKey === 'lastSeen') return ((Date.parse(x || 0) || 0) - (Date.parse(y || 0) || 0)) * sortDir;
    if (typeof x === 'string' || typeof y === 'string') return String(x || '').localeCompare(String(y || '')) * sortDir;
    return ((x || 0) - (y || 0)) * sortDir;
  });
  const cell = (u, k) => {
    if (k === 'name') return '<span class="name">' + esc(u.name) + '</span>' + (u.isAdmin ? '<span class="badge">Admin</span>' : '') + (u.demo ? '<span class="badge">Demo</span>' : '') + (u.bgg ? '<span class="badge">BGG</span>' : '');
    if (k === 'lastSeen') return esc(ago(u.lastSeen));
    if (k === 'favoriteKind') return esc(u.favoriteKind ? (KIND[u.favoriteKind] || u.favoriteKind) : '–');
    if (k === 'profile') return u.profile + '/4';
    if (k === 'top10') return u.top10 + '/10';
    return num(u[k]);
  };
  document.getElementById('users').innerHTML = '<thead><tr>' + COLS.map(([k, l]) => '<th data-k="' + k + '" class="' + (k === sortKey ? 'on' : '') + '">' + l + (k === sortKey ? (sortDir < 0 ? ' ↓' : ' ↑') : '') + '</th>').join('') + '</tr></thead>' +
    '<tbody>' + list.map((u) => '<tr>' + COLS.map(([k]) => '<td>' + cell(u, k) + '</td>').join('') + '</tr>').join('') + '</tbody>';
}
function renderAdoption() {
  const a = D.adoption, n = a.members || 1;
  const row = (label, v) => '<div class="row">' + label + ' <b>' + v + ' of ' + a.members + '</b><div class="meter"><div style="width:' + Math.round(v / n * 100) + '%"></div></div></div>';
  document.getElementById('adopt').innerHTML = row('Have games on their shelf', a.withGames) + row('Brought in their BGG plays', a.withPlays) + row('Asked Nathan something', a.askedNathan) +
    row('Rated games', a.withRatings) + row('Filled in their profile', a.withProfile) + row('Picked a Top 10', a.withTop10) + row('Started a wishlist', a.withWishlist) + row('Connected with a friend', a.withFriends);
}

// ================= Members =================
let memberQuery = '', armed = null; // armed: the "Remove" waiting for a second tap
function renderMembers(a) {
  const me = (claims(token()) || {}).email || '';
  const list = (a.members || []).filter((m) => !memberQuery || (m.name + ' ' + m.email).toLowerCase().includes(memberQuery.toLowerCase()));
  app.innerHTML =
    '<h1><i class="fa-solid fa-users"></i> Members</h1><div class="sub">' + (a.members || []).length + ' members · the site is invite-only</div>' +
    '<div class="card" style="margin-top:1rem;"><h3>Invite someone</h3>' +
      '<form class="form" id="invite"><div class="row"><input id="invName" placeholder="Their name" maxlength="80" autocomplete="off" aria-label="Their name">' +
      '<input id="invEmail" type="email" placeholder="Their Google email" maxlength="200" autocomplete="off" aria-label="Their Google email">' +
      '<button class="btn primary" type="submit"><i class="fa-solid fa-paper-plane"></i> Invite</button></div></form>' +
      '<div class="note">They get a welcome email with the link and how to start. It has to be a Google account. If Google sign-in is still in testing mode, add them as a test user in Google Cloud too.</div></div>' +
    '<h2><i class="fa-solid fa-address-book"></i> Everyone <input class="search" id="memberSearch" type="search" placeholder="Search by name or email" value="' + esc(memberQuery) + '" aria-label="Search members"></h2>' +
    '<div class="members" id="memberList">' + (list.length ? list.map((m) => memberCard(m, me)).join('') : '<p class="empty">Nobody matches that.</p>') + '</div>';
}
function memberCard(m, me) {
  const self = me && m.email.toLowerCase() === me.toLowerCase();
  const pills = [m.isOwner ? '<span class="pill ok">Owner</span>' : m.isAdmin ? '<span class="pill ok">Admin</span>' : '', self ? '<span class="pill">You</span>' : '', m.demo ? '<span class="pill">Demo</span>' : '',
    m.lastSeen ? '' : '<span class="pill busy">Hasn’t signed in yet</span>'].join('');
  const stat = (n, l) => '<div><b>' + num(n) + '</b><span>' + l + '</span></div>';
  const removeArmed = armed === 'remove:' + m.id;
  return '<div class="card member"><div class="top"><b>' + esc(m.name) + '</b>' + pills + '</div>' +
    '<div class="mail">' + esc(m.email) + '</div>' +
    '<div class="note" style="margin-top:0.2rem;">Last seen ' + esc(ago(m.lastSeen)) + ' · active ' + m.activeDays30 + ' of the last 30 days' + (m.bgg ? ' · BGG ' + esc(m.bgg) : '') + (m.joined ? ' · joined ' + esc(new Date(m.joined).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })) : '') + '</div>' +
    '<div class="stats">' + stat(m.games, 'Games') + stat(m.plays, 'Plays') + stat(m.ratings, 'Ratings') + stat(m.friends, 'Friends') + stat(m.wishlist, 'Wishlist') + stat(m.questionsToday, 'Asked today') + '</div>' +
    '<div class="acts">' +
      (m.isOwner ? '' : '<button type="button" class="btn small" data-admin="' + m.id + '" data-on="' + (!m.isAdmin) + '"><i class="fa-solid fa-shield-halved"></i> ' + (m.isAdmin ? 'Remove admin' : 'Make admin') + '</button>') +
      (m.questionsToday ? '<button type="button" class="btn small" data-reset="' + m.id + '"><i class="fa-solid fa-rotate-left"></i> Reset today’s questions</button>' : '') +
      (m.isOwner || self ? '' : '<button type="button" class="btn small danger' + (removeArmed ? ' armed' : '') + '" data-remove="' + m.id + '">' +
        (removeArmed ? 'Tap again: delete ' + esc(m.name.split(' ')[0]) + '’s shelf, plays and friends' : '<i class="fa-solid fa-user-minus"></i> Remove') + '</button>') +
    '</div></div>';
}
async function adminAct(payload) {
  try {
    const r = await post('/admin', payload);
    toast(r.message || 'Done.');
    armed = null;
    await loadA(true);
    D = null; // the dashboard counts change too
    show();
  } catch (e) { if (e instanceof Gate) return gate(e.message, e.button); toast(e.message, true); }
}
app.addEventListener('input', (e) => {
  if (e.target.id !== 'memberSearch') return;
  memberQuery = e.target.value;
  const me = (claims(token()) || {}).email || '';
  const list = (A.members || []).filter((m) => !memberQuery || (m.name + ' ' + m.email).toLowerCase().includes(memberQuery.toLowerCase()));
  document.getElementById('memberList').innerHTML = list.length ? list.map((m) => memberCard(m, me)).join('') : '<p class="empty">Nobody matches that.</p>';
});

// ================= Nathan =================
function renderNathan(a, d) {
  const busy = (a.members || []).filter((m) => m.questionsToday).sort((x, y) => y.questionsToday - x.questionsToday);
  const kinds = Object.entries(d.askKinds || {}).sort((x, y) => y[1] - x[1]);
  const total = kinds.reduce((s, [, n]) => s + n, 0);
  app.innerHTML =
    '<h1><i class="fa-solid fa-comments"></i> Nathan</h1><div class="sub">The curator: how much he’s asked, his daily limit, and the nightly check</div>' +
    selfTestHtml(d.selfTest) +
    '<div class="card" style="margin-top:0.9rem;"><h3>Nathan’s new service <small>answers appear as he writes, with a Stop button</small></h3>' +
      '<span class="seg" id="nathanMode"><button data-mode="off">Off</button><button data-mode="admins">Admins only</button><button data-mode="everyone">Everyone</button></span>' +
      '<div class="note" id="nathanModeNote" style="margin:0.5rem 0 0;">Checking…</div></div>' +
    '<div class="tiles five">' +
      '<div class="tile"><b>' + num(a.totals.questionsToday) + '</b><span>Questions today</span></div>' +
      '<div class="tile"><b>' + num(a.totals.questions7) + '</b><span>This week</span></div>' +
      '<div class="tile"><b>' + num(a.totals.questions30) + '</b><span>This month</span></div>' +
      '<div class="tile"><b>' + (d.kpis.answerSec7 != null ? d.kpis.answerSec7 + 's' : '–') + '</b><span>Avg answer time</span><small>last 7 days</small></div>' +
      '<div class="tile"><b>' + (d.kpis.answerOk30 != null ? d.kpis.answerOk30 + '%' : '–') + '</b><span>Answers that worked</span><small>last 30 days</small></div>' +
    '</div>' +
    '<div class="grid2" style="margin-top:0.8rem;">' +
      '<div class="card"><h3>Questions per member per day</h3>' +
        '<form class="form" id="limit"><div class="row"><input id="limitValue" type="number" min="1" max="500" value="' + a.askLimit + '" aria-label="Questions per member per day" style="max-width:8rem;">' +
        '<button class="btn primary" type="submit">Save</button></div></form>' +
        '<div class="note">Resets at midnight Eastern. Each question costs a fraction of a cent on the AI service.</div></div>' +
      '<div class="card"><h3>What people ask <small>last 30 days</small></h3>' +
        (total ? '<div class="adopt">' + kinds.map(([k, n]) => '<div class="row">' + esc(KIND[k] || k) + ' <b>' + num(n) + '</b><div class="meter"><div style="width:' + Math.round(n / total * 100) + '%"></div></div></div>').join('') + '</div>'
          : '<p class="empty">No questions yet.</p>') + '<div class="note">Kinds of questions only, never the questions themselves.</div></div>' +
    '</div>' +
    votesHtml(d.votes) +
    '<h2><i class="fa-solid fa-clock"></i> Asked today</h2>' +
    (busy.length ? '<div class="members">' + busy.map((m) => '<div class="card member"><div class="top"><b>' + esc(m.name) + '</b><span class="pill' + (m.questionsToday >= a.askLimit ? ' warn' : '') + '">' + m.questionsToday + ' of ' + a.askLimit + '</span></div>' +
        '<div class="note">' + num(m.questions7) + ' this week · ' + num(m.questionsAll) + ' all time</div>' +
        '<div class="acts" style="margin-top:0.6rem;"><button type="button" class="btn small" data-reset="' + m.id + '"><i class="fa-solid fa-rotate-left"></i> Reset today’s questions</button></div></div>').join('') + '</div>'
      : '<p class="empty">Nobody has asked Nathan anything yet today.</p>');
  loadNathanMode();
}
// The thumbs under his replies: a thumb alone is counted by kind of question (never the words); with a note, the member
// sent the question and the answer along, so they show with the note
function votesHtml(v) {
  if (!v) return '';
  const n30 = (v.up30 || 0) + (v.down30 || 0), liked = n30 ? Math.round(100 * v.up30 / n30) : null;
  const kinds = Object.entries(v.byKind || {}).map(([k, c]) => [k, c.up || 0, c.down || 0]).sort((x, y) => (y[1] + y[2]) - (x[1] + x[2]));
  const thumb = (vote) => '<i class="fa-solid fa-thumbs-' + vote + ' vote-' + vote + '"></i>';
  const items = v.items || [];
  return '<h2><i class="fa-solid fa-thumbs-up"></i> Thumbs on his replies</h2>' +
    '<div class="tiles five">' +
      '<div class="tile"><b>' + thumb('up') + ' ' + num(v.up7) + '</b><span>Good replies</span><small>last 7 days</small></div>' +
      '<div class="tile"><b>' + thumb('down') + ' ' + num(v.down7) + '</b><span>Not helpful</span><small>last 7 days</small></div>' +
      '<div class="tile"><b>' + (liked != null ? liked + '%' : '–') + '</b><span>Liked</span><small>' + (n30 ? num(n30) + ' thumbs, last 30 days' : 'no thumbs yet this month') + '</small></div>' +
      '<div class="tile"><b>' + num((v.upAll || 0) + (v.downAll || 0)) + '</b><span>All time</span><small>' + num(v.upAll) + ' up · ' + num(v.downAll) + ' down</small></div>' +
      '<div class="tile"><b>' + num(v.notes) + '</b><span>With a note</span><small>sent to you</small></div>' +
    '</div>' +
    '<div class="grid2" style="margin-top:0.8rem;">' +
      '<div class="card"><h3>By kind of question <small>last 30 days</small></h3>' +
        (kinds.length ? '<div class="adopt">' + kinds.map(([k, up, down]) => '<div class="row">' + esc(KIND[k] || k) + ' <b>' + thumb('up') + ' ' + num(up) + ' &nbsp; ' + thumb('down') + ' ' + num(down) + '</b>' +
          '<div class="meter"><div style="width:' + Math.round(100 * up / (up + down)) + '%"></div></div></div>').join('') + '</div>' : '<p class="empty">No thumbs yet.</p>') +
        '<div class="note">The bar is the share of thumbs up. A thumb alone never carries the question.</div></div>' +
      '<div class="card"><h3>What people said <small>latest ' + Math.min(items.length, 100) + '</small></h3>' +
        (items.length ? '<div class="votes">' + items.map((x) => '<div class="vote' + (x.note ? ' noted' : '') + '"><div class="top">' + thumb(x.vote) + '<b>' + esc(x.name || 'A former member') + '</b>' +
            '<span class="pill">' + esc(KIND[x.kind] || x.kind || 'Other') + '</span><span class="when">' + esc(ago(x.at)) + '</span></div>' +
            (x.note ? '<div class="msg">' + esc(x.note) + '</div>' + (x.question ? '<div class="meta"><b>Asked:</b> ' + esc(x.question) + (x.answer ? '<br><b>Nathan:</b> ' + esc(x.answer) : '') + '</div>' : '') : '') + '</div>').join('') + '</div>'
          : '<p class="empty">No thumbs yet. They show under every reply.</p>') + '</div>' +
    '</div>';
}
// Who gets Nathan from api.ondorilabo.com instead of n8n. If the new service is down, everyone gets n8n anyway.
const MODE_NOTE = { off: 'Everyone gets Nathan from n8n, as before.', admins: 'Admins get the new service; everyone else gets n8n.', everyone: 'Everyone gets the new service (n8n if it can’t be reached).' };
async function apiCall(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token() } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || 'The new service didn’t answer (' + res.status + ')');
  return body;
}
function showNathanMode(mode) {
  document.querySelectorAll('#nathanMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.getElementById('nathanModeNote').textContent = MODE_NOTE[mode] || '';
}
async function loadNathanMode() {
  const seg = document.getElementById('nathanMode');
  try { showNathanMode((await apiCall('/nathan-mode')).mode); }
  catch (e) { document.getElementById('nathanModeNote').textContent = 'Couldn’t reach the new service: ' + e.message; }
  seg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    try { showNathanMode((await apiCall('/nathan-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: b.dataset.mode }) })).mode); toast('Saved'); }
    catch (err) { toast(err.message, true); }
  });
}

// ================= Costs =================
const FEATURE = { nathan: 'Nathan’s answers', photo: 'Photos', rulebook: 'Reading rulebooks', tests: 'Tests (nightly check)', other: 'Other (adding games by photo, icons)' };
const FCOLORS = { nathan: '#c9342a', photo: '#b384dc', rulebook: '#0041c2', tests: '#7b8494', other: '#ffa726' };
const usd = (n, small) => n == null ? '–' : '$' + (small && Math.abs(n) < 1 ? Number(n).toFixed(n && Math.abs(n) < 0.01 ? 4 : 3) : Number(n).toFixed(2));
let fixedDraft = null;
function renderCosts(c) {
  if (!fixedDraft) fixedDraft = (c.fixed || []).map((x) => ({ ...x }));
  const tile = (n, label, small) => '<div class="tile"><b class="money">' + n + '</b><span>' + label + '</span>' + (small ? '<small>' + small + '</small>' : '') + '</div>';
  const feats = Object.entries(c.byFeature || {});
  const tracked30 = feats.reduce((t, [, v]) => t + Number(v.cost30 || 0), 0);
  const other30 = Math.max(0, Number(c.last30 || 0) - tracked30);
  const rows = [...feats.map(([k, v]) => [k, Number(v.cost30 || 0), v.calls30, Number(v.costAll || 0), v.callsAll]), ...(other30 > 0.0005 ? [['other', other30, null, null, null]] : [])].sort((a, b) => b[1] - a[1]);
  const limitLeft = c.keyLimit != null && c.keyAllTime != null ? c.keyLimit - c.keyAllTime : null;
  const lowKey = limitLeft != null && limitLeft < 2, lowBalance = c.balance != null && c.balance < 5;
  app.innerHTML =
    '<h1><i class="fa-solid fa-coins"></i> Costs</h1><div class="sub">What Board Game Curator costs to run · AI spending is exact, from OpenRouter' + (c.tracking.lastCheck ? ' · checked ' + esc(ago(c.tracking.lastCheck)) : '') + '</div>' +
    (lowKey || lowBalance ? '<div class="card status warnbox" style="margin-top:0.9rem;"><i class="fa-solid fa-triangle-exclamation" style="color:var(--brand);"></i><div><b>' +
      (lowKey ? 'The site’s OpenRouter key is close to its $' + Number(c.keyLimit).toFixed(0) + ' limit' : 'Your OpenRouter balance is low') + '</b><div class="note" style="margin:0;">' +
      (lowKey ? usd(limitLeft) + ' left before Nathan stops answering. Raise the key’s limit on openrouter.ai → Keys.' : usd(c.balance) + ' left. Add credits on openrouter.ai → Credits.') + '</div></div></div>' : '') +
    '<div class="tiles">' +
      tile(usd(c.projectedMonth), 'This month, projected', 'AI ' + usd(c.projectedAi, true) + ' + fixed ' + usd(c.fixedMonthly)) +
      tile(usd(c.monthToDate, true), 'AI so far this month') + tile(usd(c.today, true), 'AI today') + tile(usd(c.last30, true), 'AI last 30 days') +
      tile(usd(c.keyAllTime), 'AI all time', 'this site’s key' + (c.keyLimit != null ? ' · limit ' + usd(c.keyLimit) : '')) +
      tile(usd(c.balance), 'OpenRouter balance', 'shared by all your keys') +
    '</div>' +
    '<h2><i class="fa-solid fa-chart-column"></i> AI spending by day</h2>' +
    '<div class="card"><div class="chart"><canvas id="cCost"></canvas></div><div class="note">Exact daily totals start ' + (c.tracking.since ? esc(new Date(c.tracking.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : 'today') + ', when the site began checking OpenRouter every hour. The split by feature starts the same day.</div></div>' +
    '<div class="grid2" style="margin-top:0.8rem;">' +
      '<div class="card"><h3>What the AI money goes to <small>last 30 days</small></h3>' +
        (rows.length ? '<div class="adopt">' + rows.map(([k, c30, n30]) => '<div class="row">' + esc(FEATURE[k] || k) + (n30 ? ' <span class="note">· ' + num(n30) + ' calls</span>' : '') + ' <b class="money">' + usd(c30, true) + '</b><div class="meter"><div style="width:' + (c.last30 > 0 ? Math.min(100, Math.round(c30 / Math.max(Number(c.last30), tracked30) * 100)) : 0) + '%; background:' + (FCOLORS[k] || '#7b8494') + '"></div></div></div>').join('') + '</div>'
          : '<p class="empty">Nothing yet. Costs show up as soon as Nathan answers or reads a rulebook.</p>') + '</div>' +
      '<div class="card"><h3>Averages</h3><div class="adopt">' +
        '<div class="row">Per question to Nathan <b class="money">' + usd(c.perQuestion, true) + '</b></div>' +
        '<div class="row">Per rulebook page read <b class="money">' + usd(c.perRulebookPage, true) + '</b></div>' +
        '<div class="row">Per active member, last 30 days <b class="money">' + usd(c.perActiveMember, true) + '</b></div>' +
      '</div><div class="note">A 28-page rulebook costs about 28 × the page price, once. Questions are what grow with more members.</div></div>' +
    '</div>' +
    '<h2><i class="fa-solid fa-server"></i> Fixed costs</h2>' +
    '<div class="card"><form class="form" id="fixedForm">' +
      (fixedDraft.length ? '' : '<p class="empty" style="margin-bottom:0.4rem;">Add what you pay for hosting and domains, so the monthly total is the real total.</p>') +
      fixedDraft.map((x, i) => '<div class="fixed-row"><input data-fx="' + i + '" data-k="name" value="' + esc(x.name) + '" placeholder="e.g. Hostinger VPS" maxlength="60" aria-label="What it is">' +
        '<input data-fx="' + i + '" data-k="amount" value="' + esc(x.amount ?? '') + '" placeholder="Amount" inputmode="decimal" aria-label="Amount in dollars">' +
        '<select data-fx="' + i + '" data-k="per" aria-label="How often"><option value="month"' + (x.per !== 'year' ? ' selected' : '') + '>a month</option><option value="year"' + (x.per === 'year' ? ' selected' : '') + '>a year</option></select>' +
        '<button type="button" class="btn small danger" data-fx-remove="' + i + '" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button></div>').join('') +
      '<div class="row"><button type="button" class="btn small" id="fxAdd"><i class="fa-solid fa-plus"></i> Add a cost</button>' +
      '<button type="submit" class="btn primary small">Save</button></div>' +
      '<div class="note">Yearly costs count as a twelfth each month. Free services (Cloudflare, GitHub Pages, the email service) don’t need adding.</div></form></div>';
  drawCosts(c);
}
function drawCosts(c) {
  // From the day before tracking began (at least the last two weeks), so the chart isn't mostly empty
  const since = c.tracking.since ? new Date(c.tracking.since).toISOString().slice(0, 10) : null;
  const all = c.daily || [];
  const from = since ? Math.max(0, Math.min(all.findIndex((d) => d.day >= since) - 1, all.length - 14)) : Math.max(0, all.length - 14);
  const days = all.slice(from < 0 ? 0 : from);
  const feats = [...new Set(days.flatMap((d) => Object.keys(d.features || {})))];
  const ds = feats.map((k) => ({ type: 'bar', label: FEATURE[k] || k, data: days.map((d) => Number((d.features || {})[k] || 0)), backgroundColor: FCOLORS[k] || '#7b8494', stack: 'a', borderRadius: 2 }));
  ds.push({ type: 'bar', label: FEATURE.other, data: days.map((d) => Math.max(0, Number(d.exact || 0) - Number(d.tracked || 0))), backgroundColor: FCOLORS.other, stack: 'a', borderRadius: 2 });
  make('cCost', { type: 'bar', data: { labels: days.map((d) => label(d.day)), datasets: ds },
    options: base({ scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => '$' + Number(v).toFixed(v === 0 ? 0 : v < 0.01 ? 4 : v < 1 ? 3 : 2) } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { family: 'Outfit' } } }, tooltip: { callbacks: { label: (x) => x.dataset.label + ': $' + Number(x.raw).toFixed(4) } } } }) });
}
app.addEventListener('input', (e) => {
  if (e.target.id !== 'rbQ' || !rbNew) return;
  clearTimeout(rbSearchTimer);
  const q = e.target.value.trim();
  rbSearchTimer = setTimeout(() => rbSearch(q), 350);
});
app.addEventListener('change', (e) => {
  if (!e.target.matches('#rbForm input[type=file]')) return;
  const f = e.target.files[0];
  document.getElementById('rbFileName').textContent = f ? f.name : 'Choose the PDF';
});
app.addEventListener('input', (e) => { const el = e.target.closest('[data-fx]'); if (el && fixedDraft) fixedDraft[Number(el.dataset.fx)][el.dataset.k] = el.value; });
// A document's type, changed right in the Rulebooks list
app.addEventListener('change', (e) => { const k = e.target.closest('select[data-doc-kind]'); if (k) docChange({ id: Number(k.dataset.docKind), kind: k.value }); });
// ...and its name, saved when you leave the box or press Enter (only if it changed)
app.addEventListener('change', (e) => {
  const t = e.target.closest('input[data-doc-title]');
  if (!t) return;
  const doc = (A.rulebooks || []).find((d) => d.id === Number(t.dataset.docTitle));
  if (doc && (doc.title || '') !== t.value.trim()) docChange({ id: doc.id, title: t.value.trim() });
});
app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('input[data-doc-title]')) e.target.blur(); });
app.addEventListener('change', (e) => { const el = e.target.closest('select[data-fx]'); if (el && fixedDraft) fixedDraft[Number(el.dataset.fx)].per = el.value; });

// ================= Rulebooks =================
// Adding one: search BGG for the game, then the same details as on a game (what it is, a name, the official link, the PDF)
const RB_KINDS = [['rulebook', 'Rulebook'], ['learn', 'Learn to play'], ['expansion', 'Expansion rulebook'], ['reference', 'Reference guide'], ['aid', 'Player aid'], ['appendix', 'Appendix'], ['faq', 'FAQ'], ['solo', 'Solo rules'], ['other', 'Other']];
let rbNew = null;   // { q, hits, game: { bggId, title, year, thumbnail }, busy }
let rbPoll = null, rbSearchTimer = null;
function rbNewHtml() {
  if (!rbNew) return '<div class="rb-new"><button type="button" class="btn primary" id="rbOpen"><i class="fa-solid fa-plus"></i> Add a rulebook</button></div>';
  const g = rbNew.game;
  const pic = (x) => x.thumbnail ? '<img src="' + esc(x.thumbnail) + '" alt="">' : '<span class="ph"></span>';
  return '<div class="card rb-new"><h3>Add a rulebook <button type="button" class="btn small" id="rbClose">Cancel</button></h3>' +
    (!g
      ? '<div class="form"><input type="search" id="rbQ" placeholder="Which game? Type its name" autocomplete="off" value="' + esc(rbNew.q || '') + '" aria-label="Search for the game">' +
        '<div class="rb-hits" id="rbHits">' + rbHitsHtml() + '</div></div>'
      : '<form class="form" id="rbForm">' +
          '<div class="rb-game">' + pic(g) + '<div><b>' + esc(g.title) + '</b><small>' + esc([g.year, 'BGG #' + g.bggId].filter(Boolean).join(' · ')) + '</small></div>' +
            '<button type="button" class="btn small" id="rbOther">Change game</button></div>' +
          '<div class="row"><select name="kind" aria-label="What it is">' + RB_KINDS.map(([v, l]) => '<option value="' + v + '"' + (v === (g.kind === 'expansion' ? 'expansion' : 'rulebook') ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
            '<input type="text" name="title" maxlength="120" placeholder="Name (optional), e.g. Quick start"></div>' +
          '<div class="row"><input type="url" name="source" placeholder="Link to the official copy (publisher page or PDF), https://…"></div>' +
          '<div class="row"><label class="btn" style="cursor:pointer;"><i class="fa-solid fa-file-pdf"></i> <span id="rbFileName">Choose the PDF</span><input type="file" name="file" accept="application/pdf,.pdf" hidden></label>' +
            '<button type="submit" class="btn primary"' + (rbNew.busy ? ' disabled' : '') + '><i class="fa-solid fa-upload"></i> ' + (rbNew.busy ? 'Uploading…' : 'Add it') + '</button>' +
            '<a class="btn" href="https://boardgamegeek.com/boardgame/' + Number(g.bggId) + '/files" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> Find it on BGG</a></div>' +
          '<div class="note">Nathan reads it (about 10 seconds a page, up to 60 pages), then the PDF is deleted. It shows on this game, and every edition of it, on everyone’s shelf. Admins have no daily limit.</div>' +
        '</form>') +
    '</div>';
}
function rbHitsHtml() {
  if (!rbNew || !rbNew.q || rbNew.q.length < 2) return '';
  if (!rbNew.hits) return '<p class="empty">Searching BoardGameGeek…</p>';
  if (rbNew.hits.error) return '<p class="empty">' + esc(rbNew.hits.error) + '</p>';
  if (!rbNew.hits.length) return '<p class="empty">No BoardGameGeek matches for "' + esc(rbNew.q) + '".</p>';
  const have = new Set((A.rulebooks || []).map((d) => d.game));
  return rbNew.hits.slice(0, 12).map((h, k) => '<button type="button" data-rb-pick="' + k + '">' + (h.thumbnail ? '<img src="' + esc(h.thumbnail) + '" alt="" loading="lazy">' : '<span class="ph"></span>') +
    '<span><b>' + esc(h.title) + '</b><small>' + esc([h.year, h.kind === 'expansion' ? 'Expansion' : '', have.has(h.title) ? 'Has a rulebook already' : ''].filter(Boolean).join(' · ')) + '</small></span></button>').join('');
}
async function rbSearch(q) {
  rbNew.q = q; rbNew.hits = null;
  const box = document.getElementById('rbHits');
  if (box) box.innerHTML = rbHitsHtml();
  if (q.length < 2) return;
  try {
    const { results } = await call('/bgg-search?q=' + encodeURIComponent(q));
    if (!rbNew || rbNew.q !== q) return; // a newer search is in flight
    rbNew.hits = results || [];
  } catch (e) {
    if (e instanceof Gate) return gate(e.message, e.button);
    if (rbNew) rbNew.hits = { error: e.message };
  }
  const b = document.getElementById('rbHits');
  if (b) b.innerHTML = rbHitsHtml();
}
async function rbUpload(form) {
  const file = form.querySelector('input[type=file]').files[0];
  if (!file) return toast('Choose the PDF first.', true);
  if (file.size > 60 * 1024 * 1024) return toast('That PDF is over 60 MB. Try the publisher’s smaller version.', true);
  const source = form.querySelector('[name=source]').value.trim();
  if (source && !/^https:\/\/\S{4,}$/.test(source)) return toast('The link should start with https://', true);
  const t = token();
  if (!fresh(t)) return gate('Your sign-in expired. Sign in again to open Admin.', true);
  const g = rbNew.game;
  const fd = new FormData();
  fd.append('file', file, file.name); fd.append('bggId', String(g.bggId)); fd.append('gameTitle', g.title);
  fd.append('kind', form.querySelector('[name=kind]').value); fd.append('title', form.querySelector('[name=title]').value.trim()); fd.append('source', source);
  const btn = form.querySelector('[type=submit]');
  rbNew.busy = true; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-upload"></i> Uploading…';
  try {
    const res = await routedFetch('/rulebook', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd });
    const r = await res.json().catch(() => ({}));
    if (!res.ok || !r.ok) throw new Error(r.message || 'Upload failed (' + res.status + ')');
    rbNew = null;
    toast('Got it. Nathan is reading ' + g.title + ' now; it takes about 10 seconds a page.');
    await loadA(true);
    show();
  } catch (e) {
    if (rbNew) rbNew.busy = false;
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-upload"></i> Add it';
    toast(e.message, true);
  }
}
function renderRulebooks(a) {
  const docs = a.rulebooks || [];
  // While Nathan reads, the page counts tick up on their own (the add form, and anything typed in it, stays put)
  clearTimeout(rbPoll);
  if (docs.some((d) => d.status === 'queued' || d.status === 'reading')) rbPoll = setTimeout(rbTick, 6000);
  const st = (d) => d.status === 'ready' ? '<span class="pill ok">Ready</span>' : d.status === 'error' ? '<span class="pill warn">Couldn’t read</span>'
    : '<span class="pill busy">' + (d.status === 'queued' ? 'Waiting' : 'Reading ' + d.pagesDone + '/' + d.pages) + '</span>';
  app.innerHTML =
    '<h1><i class="fa-solid fa-book-open"></i> Rulebooks</h1><div class="sub">Every rulebook and guide Nathan has read. Add one for any game here, or members add them from a game’s details; we keep his text and a link to the official copy, never the PDF.</div>' +
    '<div id="rbNewBox">' + rbNewHtml() + '</div><div id="rbTable">' +
    (docs.length ? '<div class="table-wrap" style="margin-top:1rem;"><table style="min-width:760px;"><thead><tr><th>Game</th><th style="text-align:left;">Document</th><th>Pages</th><th>Sections</th><th style="text-align:left;">Status</th><th style="text-align:left;">Added</th><th style="text-align:left;">Official copy</th><th></th></tr></thead><tbody>' +
      docs.map((d) => '<tr><td><span class="name">' + esc(d.game) + '</span></td><td style="text-align:left;"><select class="rb-kind" data-doc-kind="' + d.id + '" aria-label="Document type">' +
          RB_KINDS.map(([v, l]) => '<option value="' + v + '"' + (v === d.kind ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
          '<input type="text" class="rb-title" data-doc-title="' + d.id + '" maxlength="120" value="' + esc(d.title || '') + '" placeholder="Name (optional)" aria-label="Document name"></td>' +
        '<td>' + num(d.pages) + '</td><td>' + num(d.sections) + '</td><td style="text-align:left;">' + st(d) + (d.error ? '<div class="note" style="white-space:normal;">' + esc(d.error) + '</div>' : '') + '</td>' +
        '<td style="text-align:left;">' + esc(d.uploadedBy || '–') + ' · ' + esc(ago(d.added)) + '</td>' +
        '<td style="text-align:left;">' + (d.source ? '<a href="' + esc(d.source) + '" target="_blank" rel="noopener">Open</a> · ' : '') + '<button type="button" class="btn small" data-link="' + d.id + '">' + (d.source ? 'Change' : 'Add link') + '</button></td>' +
        '<td><button type="button" class="btn small danger' + (armed === 'doc:' + d.id ? ' armed' : '') + '" data-doc-remove="' + d.id + '">' + (armed === 'doc:' + d.id ? 'Tap again to remove' : 'Remove') + '</button></td></tr>').join('') +
      '</tbody></table></div>'
      : '<div class="card" style="margin-top:1rem;"><p class="empty">No rulebooks yet. Add one above, or members add them from a game’s details → Rulebooks &amp; guides.</p></div>') + '</div>';
}
async function rbTick() {
  if (current !== 'rulebooks') return;
  try { await loadA(true); } catch (e) { return; }
  const keep = document.getElementById('rbNewBox');
  if (current !== 'rulebooks' || !keep) return;
  renderRulebooks(A);
  document.getElementById('rbNewBox').replaceWith(keep);
}
function rbNewRedraw(focus) {
  const box = document.getElementById('rbNewBox');
  if (box) box.innerHTML = rbNewHtml();
  const el = focus && document.getElementById(focus);
  if (el) el.focus();
}
async function docChange(payload) {
  try { await post('/rulebook-change', payload); toast(payload.action === 'remove' ? 'Removed.' : payload.kind ? 'Type saved.' : 'title' in payload ? 'Name saved.' : 'Link saved.'); armed = null; await loadA(true); show(); }
  catch (e) { if (e instanceof Gate) return gate(e.message, e.button); toast(e.message, true); }
}

// ================= Feedback =================
const FB_KIND = { idea: ['An idea', 'fa-lightbulb'], problem: ['Something’s wrong', 'fa-bug'], praise: ['Something they like', 'fa-heart'], question: ['A question', 'fa-circle-question'] };
const FB_FACE = ['', '😣', '😕', '🙂', '😀', '🤩'];
let fbShow = 'open';
function renderFeedback(a) {
  const fb = a.feedback || { items: [] };
  const items = fb.items.filter((x) => fbShow === 'all' || (fbShow === 'open' ? x.status !== 'done' : x.kind === fbShow));
  const seg = (k, label) => '<button type="button" class="btn small' + (fbShow === k ? ' primary' : '') + '" data-fb-show="' + k + '">' + label + '</button>';
  app.innerHTML =
    '<h1><i class="fa-solid fa-envelope-open-text"></i> Feedback</h1><div class="sub">What members send from the cog → Send feedback. Each one is also emailed to you; reply to that email to answer them.</div>' +
    '<div class="tiles" style="grid-template-columns: repeat(3, minmax(0, 1fr));">' + '<div class="tile"><b>' + num(fb.open) + '</b><span>New</span></div>' + '<div class="tile"><b>' + num(fb.items.length) + '</b><span>All feedback</span></div>' +
      '<div class="tile"><b>' + (fb.mood != null ? Number(fb.mood).toFixed(1) + ' ' + FB_FACE[Math.round(fb.mood)] : '–') + '</b><span>How it’s going</span><small>' + (fb.moods ? 'average of ' + fb.moods + ', last 90 days' : 'no faces picked yet') + '</small></div></div>' +
    '<div class="filters">' + seg('open', 'Open') + seg('all', 'All') + Object.entries(FB_KIND).map(([k, [l]]) => seg(k, l)).join('') + '</div>' +
    (items.length ? '<div class="fb-list">' + items.map((x) => {
      const [label, icon] = FB_KIND[x.kind] || FB_KIND.idea;
      return '<div class="card fb' + (x.status === 'done' ? ' done' : '') + '"><div class="top">' + (x.mood ? '<span class="mood" title="' + x.mood + ' of 5">' + FB_FACE[x.mood] + '</span>' : '') +
        '<b>' + esc(x.name || 'A former member') + '</b><span class="pill' + (x.kind === 'problem' ? ' warn' : x.kind === 'praise' ? ' ok' : '') + '"><i class="fa-solid ' + icon + '"></i> ' + label + '</span>' +
        (x.status === 'new' ? '<span class="pill busy">New</span>' : x.status === 'done' ? '<span class="pill ok">Done</span>' : '') + '<span class="when">' + esc(ago(x.at)) + '</span></div>' +
        (x.message ? '<div class="msg">' + esc(x.message) + '</div>' : '<div class="msg empty">No message, just a face.</div>') +
        ((x.page || x.device) ? '<div class="meta">' + esc([x.page, x.device].filter(Boolean).join(' · ')) + '</div>' : '') +
        '<div class="acts">' + (x.email ? '<a class="btn small" href="mailto:' + esc(x.email) + '?subject=' + encodeURIComponent('Re: your Board Game Curator feedback') + '"><i class="fa-solid fa-reply"></i> Reply</a>' : '') +
          (x.status !== 'seen' && x.status !== 'done' ? '<button type="button" class="btn small" data-fb-status="seen" data-fb="' + x.id + '">Mark seen</button>' : '') +
          (x.status !== 'done' ? '<button type="button" class="btn small" data-fb-status="done" data-fb="' + x.id + '"><i class="fa-solid fa-check"></i> Done</button>'
            : '<button type="button" class="btn small" data-fb-status="new" data-fb="' + x.id + '">Reopen</button>') + '</div></div>';
    }).join('') + '</div>'
    : '<div class="card" style="margin-top:1rem;"><p class="empty">' + (fb.items.length ? 'Nothing here. Try All.' : 'No feedback yet. Members send it from the cog → Send feedback.') + '</p></div>');
}
async function fbStatus(id, status) {
  try { await post('/feedback', { action: 'status', id, status }); await loadA(true); renderFeedback(A); }
  catch (e) { if (e instanceof Gate) return gate(e.message, e.button); toast(e.message, true); }
}

async function saveFixed() {
  const items = fixedDraft.filter((x) => String(x.name || '').trim()).map((x) => ({ name: String(x.name).trim(), amount: String(x.amount || '').replace(/[$,\s]/g, ''), per: x.per === 'year' ? 'year' : 'month' }));
  const bad = items.find((x) => !/^\d+(\.\d+)?$/.test(x.amount));
  if (bad) return toast('Give "' + bad.name + '" an amount, like 12.99', true);
  try { C = await post('/costs', { fixed: items }); fixedDraft = null; renderCosts(C); toast('Saved.'); }
  catch (e) { if (e instanceof Gate) return gate(e.message, e.button); toast(e.message, true); }
}

// ---- Buttons and forms
app.addEventListener('click', (e) => {
  const th = e.target.closest('#users th[data-k]');
  if (th) { const k = th.dataset.k; sortDir = k === sortKey ? -sortDir : (k === 'name' || k === 'favoriteKind' ? 1 : -1); sortKey = k; renderUsers(); return; }
  const ad = e.target.closest('[data-admin]');
  if (ad) return adminAct({ action: 'admin', target: Number(ad.dataset.admin), on: ad.dataset.on === 'true' });
  const rs = e.target.closest('[data-reset]');
  if (rs) return adminAct({ action: 'resetAsks', target: Number(rs.dataset.reset) });
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    if (armed !== 'remove:' + rm.dataset.remove) { armed = 'remove:' + rm.dataset.remove; return show(); }
    return adminAct({ action: 'remove', target: Number(rm.dataset.remove) });
  }
  const dl = e.target.closest('[data-link]');
  if (dl) {
    const url = (prompt('Link to the official copy (publisher page or PDF), starting with https://') || '').trim();
    if (!url) return;
    if (!/^https:\/\/\S{4,}$/.test(url)) return toast('The link should start with https://', true);
    return docChange({ id: Number(dl.dataset.link), action: 'edit', source: url });
  }
  if (e.target.closest('#fxAdd')) { fixedDraft.push({ name: '', amount: '', per: 'month' }); return renderCosts(C); }
  const fx = e.target.closest('[data-fx-remove]');
  if (fx) { fixedDraft.splice(Number(fx.dataset.fxRemove), 1); return renderCosts(C); }
  if (e.target.closest('#rbOpen')) { rbNew = { q: '', hits: null }; return rbNewRedraw('rbQ'); }
  if (e.target.closest('#rbClose')) { rbNew = null; return rbNewRedraw(); }
  if (e.target.closest('#rbOther')) { rbNew.game = null; return rbNewRedraw('rbQ'); }
  const pk = e.target.closest('[data-rb-pick]');
  if (pk) { rbNew.game = rbNew.hits[Number(pk.dataset.rbPick)]; return rbNewRedraw(); }
  const fs = e.target.closest('[data-fb-show]');
  if (fs) { fbShow = fs.dataset.fbShow; return renderFeedback(A); }
  const fst = e.target.closest('[data-fb-status]');
  if (fst) return fbStatus(Number(fst.dataset.fb), fst.dataset.fbStatus);
  const dr = e.target.closest('[data-doc-remove]');
  if (dr) {
    if (armed !== 'doc:' + dr.dataset.docRemove) { armed = 'doc:' + dr.dataset.docRemove; return show(); }
    return docChange({ id: Number(dr.dataset.docRemove), action: 'remove' });
  }
});
app.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'invite') adminAct({ action: 'invite', name: document.getElementById('invName').value, email: document.getElementById('invEmail').value });
  if (e.target.id === 'limit') adminAct({ action: 'askLimit', value: Number(document.getElementById('limitValue').value) });
  if (e.target.id === 'fixedForm') saveFixed();
  if (e.target.id === 'rbForm') rbUpload(e.target);
});

start();
