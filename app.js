// The shelf: the welcome page, the collection, Nathan and people. api.js (loaded first) holds the server addresses and the helpers shared with Admin.
const LS_CACHE = 'vault_collection_cache_v1';
const DEFAULT_ICON = 'meeple';

let collection = [];
let thinOnly = false;
let favOnly = false;

// The cached copy of the collection, written at most once a second (every heart or culling tap used to serialize it all)
let cacheTimer = null;
function saveCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => { if (viewingMine()) try { localStorage.setItem(LS_CACHE, JSON.stringify(collection)); } catch (e) {} }, 1000);
}

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------- Google sign-in ----------
// The ID token (a signed JWT, valid ~1 hour) is sent with every change; n8n verifies it with Google and
// only accepts the owner's account. Reading the collection needs no sign-in.
const LS_ROLE = 'vault_role'; // { sub, role: 'owner' | 'friend', admin, playerId, playerName } as confirmed by n8n
let idToken = null, profile = null;
const credentialWaiters = [];
const tokenFresh = () => !!(profile && profile.exp * 1000 > Date.now() + 60 * 1000);
const signedIn = () => !!profile; // an expired token is renewed on the next change
const savedRole = () => { try { return JSON.parse(localStorage.getItem(LS_ROLE) || 'null'); } catch (e) { return null; } };
const myRole = () => { const r = savedRole(); return signedIn() && r && r.sub === profile.sub ? r : null; };
// Owner: everything. Friend (Google email on a player card): can rate games for themselves. Others: view-only.
const isOwner = () => (myRole() || {}).role === 'owner';
const isMember = () => !!myRole();
const isAdmin = () => isOwner() || !!(myRole() || {}).admin;
const myPlayerId = () => (myRole() || {}).playerId || null;
// Opened from the home screen (the web manifest's standalone mode). Google's pop-up sign-in can't hand the token back
// to a home-screen app on iPhone (the pop-up is a separate Safari), so there every sign-in goes through Google's own
// page and comes back in the address (googleRedirectSignIn), which iOS does return to the app.
const standalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
function setToken(t) {
  apiRoutesP = null; // ask the switches again for whoever is signed in now
  try { profile = t ? decodeJwt(t) : null; idToken = t || null; } catch (e) { profile = null; idToken = null; }
  try { idToken ? localStorage.setItem(LS_TOKEN, idToken) : localStorage.removeItem(LS_TOKEN); } catch (e) {}
  updateAuthUi();
}
function updateAuthUi() {
  document.body.classList.toggle('owner', isOwner());
  document.body.classList.toggle('member', isMember());
  document.body.classList.toggle('admin', isAdmin());
  document.body.classList.toggle('guest', !isMember());
  if (typeof renderLandingSignIn === 'function') renderLandingSignIn();
  if (typeof updateShelfUi === 'function') updateShelfUi();
  if (typeof updateTipJar === 'function') updateTipJar();
  const btn = document.getElementById('authBtn');
  btn.innerHTML = signedIn()
    ? (profile.picture ? '<img src="' + esc(profile.picture) + '" alt="" referrerpolicy="no-referrer">' : '<i class="ti ti-user-circle"></i>') +
      '<span class="who">' + esc(((myRole() || {}).playerName || profile.given_name || profile.name || profile.email || '').split(' ')[0]) + '</span><i class="ti ti-chevron-down" style="opacity:0.55; font-size:0.7rem;"></i>'
    : '<i class="ti ti-login-2"></i> <span>Sign in</span>';
  btn.title = signedIn() ? 'Signed in as ' + (profile.name || profile.email) : 'Sign in to make changes';
  if (collection.length) render();
}
function onCredential(resp) {
  const wasMember = isMember();
  setToken(resp.credential);
  document.getElementById('signInModal').classList.remove('open');
  verifyMember(wasMember).then(() => credentialWaiters.splice(0).forEach(w => w(isMember() ? idToken : null)));
}
// Ask n8n who this Google account is here: the owner, a friend with a player card, or nobody (view-only).
// The owner's email never appears in this page.
async function verifyMember(wasMember) {
  const who = profile && (profile.email || profile.name);
  let res;
  try {
    res = await routedFetch('/whoami', { headers: { Authorization: 'Bearer ' + idToken } });
  } catch (e) {
    toast('Couldn’t confirm your sign-in. Check your connection and try again.', true);
    setToken(null);
    return;
  }
  if (res.ok) {
    const w = await res.json().catch(() => ({}));
    try {
      localStorage.setItem(LS_ROLE, JSON.stringify({ sub: profile.sub, role: w.role === 'owner' ? 'owner' : 'friend', admin: !!w.admin, playerId: w.playerId || null, playerName: w.playerName || null }));
    } catch (e) {}
    updateAuthUi();
    landingNotice('');
    // Reload after signing in: always for a new sign-in, and when the last load failed because the sign-in had expired ("Offline")
    const failed = document.getElementById('totalBadge').classList.contains('err');
    if (!wasMember || failed) {
      if (!wasMember) toast(w.role === 'owner' ? 'Signed in. Welcome back!' : 'Welcome, ' + (w.playerName || who).split(' ')[0] + '!');
      loadCollection();
      loadPeople();
      loadFriends();
    }
  } else {
    try { localStorage.removeItem(LS_ROLE); } catch (e) {}
    if (gisReady) google.accounts.id.disableAutoSelect();
    setToken(null);
    landingNotice((who || 'That account') + ' isn’t on the invite list yet. Ask Dan to add you, then sign in again.');
  }
}
let gisReady = false;
// The welcome page's Google buttons (drawn once Google's script has loaded)
function renderLandingSignIn() {
  if (isMember()) return;
  if (!gisReady) initGoogle();
  for (const id of ['landingSignIn', 'landingSignIn2']) {
    const box = document.getElementById(id);
    if (!box || box.dataset.drawn === String(gisReady)) continue;
    box.dataset.drawn = String(gisReady);
    box.innerHTML = '';
    if (gisReady && !standalone()) google.accounts.id.renderButton(box, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left' });
    else box.innerHTML = '<button class="btn primary" type="button" data-quick-sign-in><i class="ti ti-brand-google"></i> Sign in with Google</button>';
  }
}
document.getElementById('landing').addEventListener('click', (e) => { if (e.target.closest('[data-quick-sign-in]')) quickSignIn(); });
function landingNotice(msg) {
  const n = document.getElementById('landingNote');
  n.textContent = msg || '';
  n.hidden = !msg;
}
function initGoogle() {
  if (gisReady || !window.google || !google.accounts) return;
  gisReady = true;
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true, cancel_on_tap_outside: true, use_fedcm_for_prompt: true, itp_support: true });
  // Returning owner with an expired token: renew quietly (One Tap auto sign-in)
  if (profile && !tokenFresh()) google.accounts.id.prompt();
}
function openSignIn(note) {
  document.getElementById('signInNote').textContent = note || '';
  document.getElementById('signInModal').classList.add('open');
  initGoogle();
  const box = document.getElementById('googleSignIn');
  if (standalone()) {
    box.innerHTML = '<button class="btn primary" type="button" data-google-redirect><i class="ti ti-brand-google"></i> Sign in with Google</button>';
  } else if (gisReady) {
    box.innerHTML = '';
    google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left' });
  } else {
    // Google's script hasn't loaded (slow, or blocked): our own button tries again, then falls back to Google's sign-in page
    box.innerHTML = '<button class="btn primary" type="button" data-google-fallback><i class="ti ti-brand-google"></i> Sign in with Google</button>';
  }
}
// Signed out, the top bar's button goes straight to Google's own account chooser ("Continue as Dan": one click, or
// none when the browser remembers you). Our sign-in box with Google's button is only for when Google can't show
// it (blocked, recently dismissed, or Google's script not loaded): that box was an extra click every time
function quickSignIn() {
  if (standalone()) return googleRedirectSignIn();
  initGoogle();
  if (!gisReady) return openSignIn();
  try { google.accounts.id.prompt((n) => { if (n.isSkippedMoment() || (n.isNotDisplayed && n.isNotDisplayed())) openSignIn(); }); }
  catch (e) { openSignIn(); }
}
document.getElementById('googleSignIn').addEventListener('click', async (e) => {
  if (e.target.closest('[data-google-redirect]')) { googleRedirectSignIn(); return; }
  const b = e.target.closest('[data-google-fallback]');
  if (!b) return;
  b.disabled = true;
  b.textContent = 'Opening Google…';
  if (await loadGoogleScript()) { openSignIn(document.getElementById('signInNote').textContent); return; }
  googleRedirectSignIn();
});
// Load (or reload) Google's sign-in script; resolves true once it's usable
function loadGoogleScript() {
  if (window.google && google.accounts) { initGoogle(); return Promise.resolve(true); }
  return new Promise((resolve) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true;
    const done = (ok) => { clearTimeout(t); if (ok) initGoogle(); resolve(ok && gisReady); };
    const t = setTimeout(() => done(!!(window.google && google.accounts)), 6000);
    sc.onload = () => done(true);
    sc.onerror = () => done(false);
    document.head.appendChild(sc);
  });
}
// Last resort: Google's own sign-in page, which sends the ID token back in the address (#id_token=…)
function googleRedirectSignIn() {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { sessionStorage.setItem('vault_oauth_nonce', nonce); } catch (e) {}
  const p = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, response_type: 'id_token', scope: 'openid email profile',
    redirect_uri: location.origin + '/', nonce, prompt: 'select_account' });
  if (profile && profile.email) p.set('login_hint', profile.email); // renewing: Google's chooser is one tap
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}
function finishRedirectSignIn() {
  if (!/[#&]id_token=/.test(location.hash)) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const token = h.get('id_token');
  history.replaceState(null, '', location.pathname + location.search);
  let nonce = null;
  try { nonce = sessionStorage.getItem('vault_oauth_nonce'); sessionStorage.removeItem('vault_oauth_nonce'); } catch (e) {}
  try {
    const claims = decodeJwt(token);
    if (!nonce || claims.nonce !== nonce) return; // only a sign-in this browser started
  } catch (e) { return; }
  onCredential({ credential: token });
}
// A fresh token, renewed silently when possible; otherwise asks the owner to sign in
async function ensureToken() {
  if (tokenFresh()) return idToken;
  initGoogle();
  if (gisReady && !standalone()) {
    const renewed = await new Promise((resolve) => {
      credentialWaiters.push(resolve);
      google.accounts.id.prompt();
      setTimeout(() => resolve(null), 6000);
    });
    if (renewed && tokenFresh()) return idToken;
  }
  openSignIn('Your sign-in expired. Sign in again, then repeat that change.');
  throw new Error('Sign in to make changes.');
}
function handleUnauthorized() {
  try { localStorage.removeItem(LS_ROLE); } catch (e) {}
  setToken(null);
  openSignIn('That account can’t change this collection, or the sign-in expired.');
  return new Error('Sign in as the collection owner to make changes.');
}

// auth: send the owner's Google token (true for everything except reading the collection).
// Gives up after 20 s unless the caller brings its own signal (Nathan, BGG lookups and play syncs take longer);
// uploads and photo identification use fetch directly and have no limit
async function n8nFetch(path, opts, auth = true) {
  const o = { ...(opts || {}) };
  if (auth) o.headers = { ...(o.headers || {}), Authorization: 'Bearer ' + await ensureToken() };
  if (!o.signal) o.signal = AbortSignal.timeout(20000);
  let res;
  try { res = await routedFetch(path, o, auth); }
  catch (e) { throw e.name === 'TimeoutError' ? new Error('The server took too long to answer. Try again in a moment.') : e; }
  if (res.status === 401) throw handleUnauthorized();
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (e) {}
    throw new Error('n8n request failed (' + res.status + ') ' + detail);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// Which requests go to the new service (api.ondorilabo.com) instead of n8n, e.g. 'GET /shelf' or 'POST /ask' (Nathan).
// Admin turns each area on (Roadmap 7, Phase 3). Asked once per sign-in; meanwhile the list this browser last saw is
// used, so loading never waits for it. Anything the new service can't answer goes to n8n.
const LS_API_ROUTES = 'vault_api_routes';
var apiRoutesP = null; // null: not asked yet for this sign-in
function apiRoutes() {
  if (apiRoutesP) return apiRoutesP;
  const sub = profile && profile.sub, t = idToken;
  if (!t) return Promise.resolve(new Set());
  const asked = (async () => {
    try {
      const r = await fetch(API + '/routes', { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(4000) });
      const routes = r.ok ? (await r.json()).routes || [] : [];
      try { localStorage.setItem(LS_API_ROUTES, JSON.stringify({ sub, routes })); } catch (e) {}
      return new Set(routes);
    } catch (e) { return new Set(); }
  })();
  let saved = null;
  try { const s = JSON.parse(localStorage.getItem(LS_API_ROUTES) || 'null'); if (s && s.sub === sub) saved = new Set(s.routes || []); } catch (e) {}
  const p = apiRoutesP = saved ? Promise.resolve(saved) : asked;
  if (saved) asked.then((fresh) => { if (apiRoutesP === p) apiRoutesP = Promise.resolve(fresh); });
  return p;
}
const useNathanApi = async () => (await apiRoutes()).has('POST /ask');

// Loading and errors show in the total badge in the top bar, not in the hero
function setSyncStatus(msg, isErr) {
  const badge = document.getElementById('totalBadge'), status = document.getElementById('badgeStatus');
  badge.classList.toggle('err', !!isErr);
  badge.title = isErr ? msg : 'Games in the collection';
  status.hidden = !msg;
  status.innerHTML = isErr ? (/sign in/i.test(String(msg)) ? '<i class="ti ti-login-2"></i> Signed out' : '<i class="ti ti-alert-triangle"></i> Offline') : '<span class="badge-spin"></span> ' + esc(msg);
  document.getElementById('badgeTotal').hidden = !!msg;
}

// Which shelf is showing: 'main' (the public collection) or 'mine' (a signed-in friend's own shelf)
const LS_SHELF = 'vault_shelf_view';
let shelfView = (() => { try { const v = localStorage.getItem(LS_SHELF) || ''; return v === 'mine' || /^friend:\d+$/.test(v) ? v : 'main'; } catch (e) { return 'main'; } })();
let friendsData = { code: '', friends: [] };
let friendsFailed = false;
let friendShelfName = '';
let myShelf = null; // { items, status, bggUsername } for the 'mine' view
let importPoll = null;
// Everyone's home is their own shelf, Dan's included (his is the one Nathan calls 'main'); a friend's opens from Friends
const viewingFriend = () => isMember() && /^friend:\d+$/.test(shelfView) ? Number(shelfView.slice(7)) : null;
const viewingMine = () => isMember() && !viewingFriend();
const homeShelf = () => isOwner() ? 'main' : 'mine';
// What Nathan, the @ list and "See all" are about
const currentShelf = () => viewingFriend() ? shelfView : isOwner() ? 'main' : 'mine';
// Edit controls follow the shelf being viewed: your own shelf, not a friend's
function canEdit() { return viewingMine(); }
function updateShelfUi() {
  document.body.classList.toggle('can-edit', canEdit());
  renderShelfSwitch();
}
async function setShelfView(view) {
  shelfView = view;
  try { localStorage.setItem(LS_SHELF, view); } catch (e) {}
  askIds = null;
  updateShelfUi();
  askSelected.clear();
  askLast = null;
  await Promise.all([loadCollection(), loadPeople()]);
}
document.getElementById('shelfSwitch').addEventListener('click', (e) => { if (e.target.closest('[data-close-visit]')) setShelfView(homeShelf()); });
// Only while visiting a friend: "Matt's shelf · view only  × Close" (back to your own); empty and hidden otherwise
function renderShelfSwitch() {
  const box = document.getElementById('shelfSwitch');
  if (!isMember()) { box.hidden = true; return; }
  const visiting = viewingFriend() ? (friendsData.friends || []).find(f => f.id === viewingFriend()) : null;
  const html = visiting
    ? '<span class="visiting-label"><i class="ti ti-user"></i> ' + esc(visiting.firstName) + '’s shelf <small>· view only</small></span>' +
      '<button type="button" class="close-visit" data-close-visit title="Back to your shelf"><i class="ti ti-x"></i> Close</button>'
    : '';
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  box.classList.toggle('visiting', !!visiting);
  box.hidden = !visiting;
}
async function loadFriends() {
  if (!isMember()) return;
  try { friendsData = await n8nFetch('/friends', { method: 'GET' }); friendsFailed = false; }
  catch (e) { friendsFailed = true; renderFriendsPanel(); return; }
  // A saved friend view whose friendship is gone falls back to the main shelf
  if (viewingFriend() && !(friendsData.friends || []).some(f => f.id === viewingFriend())) { setShelfView(homeShelf()); return; }
  renderShelfSwitch();
  renderFriendsPanel();
}
// Each load checks the shelf is still the one asked for once the answer arrives (switching shelves twice quickly
// used to leave the first shelf's games on the second), like lastSearch does for BGG searches
async function loadFriendShelf(id) {
  setSyncStatus('Loading…');
  const panel = document.getElementById('importPanel');
  const view = shelfView;
  try {
    const r = await n8nFetch('/friends?shelf=' + id, { method: 'GET' });
    if (shelfView !== view) return;
    collection = r.items || [];
    friendShelfName = r.name || 'a friend';
    setSyncStatus('');
    rebuildGenreFilter();
    render();
    panel.hidden = true; // the Close pill says whose shelf it is
    if (!rbGames.size) loadRbGames();
  } catch (e) {
    if (shelfView !== view) return;
    setSyncStatus('');
    toast(e.message, true);
    setShelfView(homeShelf());
  }
}

async function loadMyShelf() {
  setSyncStatus('Loading…');
  const view = shelfView;
  try {
    const r = await n8nFetch('/shelf', { method: 'GET' });
    if (shelfView !== view) return;
    myShelf = r;
    collection = myShelf.items || [];
    saveCache(); // your own shelf is kept for an offline look
    setSyncStatus('');
    rebuildGenreFilter();
    render();
    renderImportPanel();
    if (!rbGames.size) loadRbGames(); // the 📖 on games with a rulebook
  } catch (e) {
    if (shelfView !== view) return;
    setSyncStatus(e.message, true);
    const cached = localStorage.getItem(LS_CACHE);
    if (cached) { collection = JSON.parse(cached); rebuildGenreFilter(); render(); }
  }
}
// Your shelf's panel: ways to add games when it's empty, progress while a spreadsheet or BGG plays come in,
// what a spreadsheet couldn't match, and a quiet line for your BGG plays
const LS_CSV_SEEN = 'vault_csv_seen';
const bggPlaysForm = () => '<form class="row" id="importForm"><input id="importUser" type="text" autocomplete="username" placeholder="BGG username" value="' + esc(myShelf.bggUsername || '') + '">' +
  '<button class="btn" type="submit"><i class="ti ti-cloud-download"></i> ' + (myShelf.bggUsername ? 'Update plays' : 'Bring in my plays') + '</button></form>';
function renderImportPanel() {
  const panel = document.getElementById('importPanel');
  clearTimeout(importPoll);
  if (!viewingMine() || !myShelf) { panel.hidden = true; return; }
  const st = myShelf.status || {};
  const running = st.state === 'running' && (Date.now() - Date.parse(st.at || 0)) < 30 * 60 * 1000;
  const empty = !(myShelf.items || []).length;
  if (running) {
    panel.hidden = false;
    panel.innerHTML = '<div class="import-card"><h2>' + (st.kind === 'csv' ? 'Adding your games…' : 'Bringing your plays over from BGG…') + '</h2>' +
      '<p class="hint" style="margin:0;">' + (st.kind === 'csv' ? 'You can leave this page open; games appear when it’s done. A long list takes a few minutes (BGG lets us look up about one game a second).' : 'You can leave this page open. Plays show up on each game once it’s on your shelf.') + '</p>' +
      '<div class="import-progress"><div class="spinner"></div><span>' + esc(st.step || 'Working') + '</span></div></div>';
    importPoll = setTimeout(async () => {
      try {
        const next = await n8nFetch('/shelf', { method: 'GET' });
        const done = next.status && next.status.state === 'done' && (!st.state || st.state === 'running');
        myShelf = next;
        if (viewingMine()) { collection = next.items || []; rebuildGenreFilter(); render(); }
        renderImportPanel();
        if (done) toast(next.status.kind === 'csv' ? 'Added ' + (next.status.added || 0) + ' games' + (next.status.expansions ? ' and ' + next.status.expansions + ' expansions' : '') + '.'
          : 'Your plays are in: ' + (next.status.plays || 0) + ' plays.');
      } catch (e) { importPoll = setTimeout(renderImportPanel, 8000); }
    }, 4000);
    return;
  }
  const failed = st.state === 'error' ? '<p class="hint" style="color:var(--brand-dark); font-weight:700;">' + esc(st.message || 'The last import didn’t finish.') + '</p>' : '';
  // A spreadsheet that's done: what it added, and what it couldn't find (tap one to add it by name)
  let seen = '';
  try { seen = localStorage.getItem(LS_CSV_SEEN) || ''; } catch (e) {}
  const missing = st.kind === 'csv' && st.state === 'done' && (st.notFound || []).length && seen !== st.finished ? st.notFound : null;
  const missingCard = missing ? '<div class="import-card" style="margin-bottom:1rem;"><h2>' + (st.added || 0) + ' games added</h2>' +
    '<p class="hint" style="margin:0;">Couldn’t find ' + missing.length + ' on BoardGameGeek. Tap one to search for it by name:</p>' +
    '<div class="not-found">' + missing.map(t => '<button type="button" data-find="' + esc(t) + '">' + esc(t) + '</button>').join('') + '</div>' +
    '<div class="add-ways"><button class="btn ghost" type="button" data-csv-done>Done</button></div></div>' : '';
  if (empty) {
    panel.hidden = false;
    panel.innerHTML = missingCard + '<div class="import-card"><h2>Fill your shelf</h2>' +
      '<p class="hint" style="margin:0;">Add the games you own. A big collection is fastest from a spreadsheet.</p>' + failed +
      '<div class="add-ways"><button class="btn primary" type="button" data-add-way="name"><i class="ti ti-search"></i> Name</button>' +
      '<button class="btn" type="button" data-add-way="photo"><i class="ti ti-camera"></i> By photo</button>' +
      '<button class="btn" type="button" data-add-way="csv"><i class="ti ti-table"></i> Spreadsheet</button></div>' +
      '<div class="sub"><h3>Your plays from BoardGameGeek <span style="font-weight:600; color:var(--text-muted);">(optional)</span></h3>' +
      '<p class="hint" style="margin:0;">Brings in the plays you’ve logged (BG Stats too, if it posts to BGG). It doesn’t add games: plays show up on a game once it’s on your shelf.</p>' +
      (myShelf.bggUsername && st.plays ? '<p class="hint" style="margin:0.4rem 0 0;"><b>' + st.plays + '</b> plays from <b>' + esc(myShelf.bggUsername) + '</b> are ready.</p>' : '') +
      bggPlaysForm() + '</div></div>';
    return;
  }
  // Shelf has games: nothing to say unless a spreadsheet left games unfound or the last import failed (syncing plays lives
  // in the Settings cog, "My plays", for everyone)
  panel.innerHTML = missingCard + failed;
  panel.hidden = !(missingCard || failed);
}
async function startImport(username) {
  try {
    await n8nFetch('/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bggUsername: username }) });
    myShelf = { ...(myShelf || {}), bggUsername: username, status: { state: 'running', kind: 'bgg', step: 'Reading your plays from BGG', at: new Date().toISOString() } };
    renderImportPanel();
    return true;
  } catch (err) { toast(err.message, true); return false; }
}
document.getElementById('importPanel').addEventListener('submit', (e) => {
  if (e.target.id !== 'importForm') return;
  e.preventDefault();
  const u = document.getElementById('importUser').value.trim();
  if (u) startImport(u);
});
document.getElementById('importPanel').addEventListener('click', (e) => {
  const way = e.target.closest('[data-add-way]');
  if (way) openAddModal(way.dataset.addWay);
  const find = e.target.closest('[data-find]');
  if (find) openAddModal('name', find.dataset.find);
  if (e.target.closest('[data-csv-done]')) { try { localStorage.setItem(LS_CSV_SEEN, (myShelf.status || {}).finished || ''); } catch (err) {} renderImportPanel(); }
});

// Which shelf to show: your own (Dan's included), a friend's, or nothing until you sign in (the site is members only)
async function loadCollection() {
  updateShelfUi();
  if (viewingMine()) return loadMyShelf();
  if (viewingFriend()) return loadFriendShelf(viewingFriend());
  document.getElementById('importPanel').hidden = true;
  clearTimeout(importPoll);
  setSyncStatus('');
  collection = [];
  rebuildGenreFilter();
  render();
}

function rebuildGenreFilter() {
  const genreSelect = document.getElementById('genreFilter');
  const current = genreSelect.value;
  genreSelect.innerHTML = '<option value="ALL">All Genres</option>';
  const uniqueGenres = [...new Set(collection.map(g => (g.genre || '').split('/')[0].trim()).filter(Boolean))].sort();
  uniqueGenres.forEach(genre => {
    const opt = document.createElement('option');
    opt.value = genre; opt.textContent = genre;
    genreSelect.appendChild(opt);
  });
  if (uniqueGenres.includes(current)) genreSelect.value = current;
}

async function updateGame(id, patch) {
  const idx = collection.findIndex(g => g.id === id);
  if (idx === -1) return;
  const prev = { ...collection[idx] };
  collection[idx] = { ...collection[idx], ...patch };
  render();
  try {
    await n8nFetch('/shelf-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, fields: patch })
    });
    saveCache();
  } catch (e) {
    collection[idx] = prev;
    render();
    toast('Could not save: ' + e.message, true);
  }
}

// The stars on a card: the shelf owner's own rating (yours on your shelf, a friend's on theirs)
function ownerStars(g) {
  const key = (people && (people.owner || people.me)) || null;
  return key ? ((((people.ratings || {})[g.id] || {})[key] || {}).stars || 0) : 0;
}
function toggleThinning(id) {
  const g = collection.find(x => x.id === id);
  updateGame(id, { thinningCandidate: !g.thinningCandidate });
}

function toggleFavorite(id) {
  const g = collection.find(x => x.id === id);
  updateGame(id, { favorite: !g.favorite });
}

// ---------- formatting helpers ----------
const range = (a, b) => (a && b && a !== b) ? a + '–' + b : String(a || b || '');
function playersText(g) {
  if (!g.minPlayers && !g.maxPlayers) return '';
  return range(g.minPlayers, g.maxPlayers);
}
function bestText(g) {
  const b = (g.bestPlayers || []).slice().sort((x, y) => x - y);
  if (!b.length) return '';
  const consecutive = b.every((n, i) => i === 0 || n === b[i - 1] + 1);
  return consecutive ? range(b[0], b[b.length - 1]) : b.join(', ');
}
function timeText(g) {
  const a = g.minTime || g.maxTime, b = g.maxTime || g.minTime;
  if (!a) return '';
  if (b < 120) return range(a, b) + ' min';
  const h = (m) => +(m / 60).toFixed(1);
  return range(h(a), h(b)) + ' h';
}
function weightClass(w) { return !w ? '' : w < 2 ? 'w-light' : w < 3 ? 'w-medium' : 'w-heavy'; }
function weightLabel(w) { return !w ? '' : w < 1.8 ? 'Light' : w < 2.6 ? 'Medium-light' : w < 3.4 ? 'Medium' : w < 4.2 ? 'Medium-heavy' : 'Heavy'; }
function daysSince(d) { return d ? Math.floor((Date.now() - new Date(d + 'T12:00:00').getTime()) / 86400000) : null; }
function agoText(d) {
  const n = daysSince(d);
  if (n === null) return '';
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 14) return n + 'd ago';
  if (n < 60) return Math.round(n / 7) + 'w ago';
  if (n < 365) return Math.round(n / 30) + 'mo ago';
  return (n / 365).toFixed(n < 730 ? 1 : 0).replace(/\.0$/, '') + 'y ago';
}
function playsText(g) {
  const c = g.playCount || 0;
  if (!c) return '';
  return c + (c === 1 ? ' play' : ' plays') + (g.lastPlayed ? ' · ' + agoText(g.lastPlayed) : '');
}
function starsHtml(g) {
  let s = '';
  for (let i = 1; i <= 5; i++) {
    s += '<button class="star-btn ' + (i <= Math.round(ownerStars(g)) ? 'active' : '') + '" data-id="' + esc(g.id) + '" data-rank="' + i + '" title="' + (canEdit() ? 'Rate it ' + i : 'Rated ' + ownerStars(g)) + '"><i class="ti ti-filled ti-star-filled"></i></button>';
  }
  return '<div class="stars">' + s + '</div>';
}
function factsHtml(g) {
  const out = [];
  const p = playersText(g), best = bestText(g), t = timeText(g);
  if (p) out.push('<span class="fact" title="Players' + (best ? ' (best with ' + best + ')' : '') + '"><i class="ti ti-users"></i>' + p + (best && best !== p ? ' <em>best ' + best + '</em>' : '') + '</span>');
  if (t) out.push('<span class="fact" title="Play time"><i class="ti ti-clock"></i>' + t + '</span>');
  if (g.weight) out.push('<span class="fact ' + weightClass(g.weight) + '" title="Weight: ' + weightLabel(g.weight) + ' (BGG, 1–5)"><i class="ti ti-weight"></i>' + Number(g.weight).toFixed(1) + '</span>');
  return out.length ? '<div class="facts">' + out.join('') + '</div>' : '';
}
// Box art from BGG when we have it; the AI-picked icon tile otherwise (and if the image fails to load)
function coverHtml(g, url, overlay) {
  const icon = '<i class="ti ti-' + esc(g.icon || DEFAULT_ICON) + '"></i>';
  return url
    ? '<div class="cover" data-icon="' + esc(g.icon || DEFAULT_ICON) + '"><img src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' + (overlay || '') + '</div>'
    : '<div class="cover fallback">' + icon + (overlay || '') + '</div>';
}
// img error events don't bubble, so listen in the capture phase
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const cover = img.closest('.cover[data-icon]');
  if (!cover) return;
  cover.classList.add('fallback');
  img.replaceWith(Object.assign(document.createElement('i'), { className: 'ti ti-' + cover.dataset.icon }));
}, true);

function favButton(g, cls) {
  const label = g.favorite ? 'Remove from favorites' : 'Add to favorites';
  return '<button class="' + cls + ' fav' + (g.favorite ? ' on' : '') + '" data-fav="' + esc(g.id) + '" title="' + label + '" aria-label="' + label + '" aria-pressed="' + !!g.favorite + '">' +
    '<i class="ti ' + (g.favorite ? 'ti-filled ti-heart-filled' : 'ti-heart') + '"></i>' + (cls.split(' ')[0] === 'btn' ? (g.favorite ? ' Favorited' : ' Favorite') : '') + '</button>';
}
function bylineText(g) {
  return [g.year, (g.designers || []).slice(0, 2).join(' & ')].filter(Boolean).join(' · ');
}

let pendingDeleteId = null;
const deleteModal = document.getElementById('deleteModal');
function openDeleteModal(id) {
  const g = collection.find(x => x.id === id);
  if (!g) return;
  pendingDeleteId = id;
  document.getElementById('deleteGameTitle').textContent = g.title;
  deleteModal.classList.add('open');
}
document.getElementById('deleteCancel').addEventListener('click', () => {
  deleteModal.classList.remove('open');
  pendingDeleteId = null;
});
document.getElementById('deleteConfirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  pendingDeleteId = null;
  deleteModal.classList.remove('open');
  const idx = collection.findIndex(g => g.id === id);
  const prev = idx !== -1 ? collection[idx] : null;
  collection = collection.filter(g => g.id !== id);
  render();
  try {
    await n8nFetch('/shelf-remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    saveCache();
    toast('Removed "' + (prev ? prev.title : 'game') + '" from your shelf.');
  } catch (e) {
    if (prev && idx !== -1) collection.splice(idx, 0, prev);
    render();
    toast('Could not delete: ' + e.message, true);
  }
});

function render() {
  const grid = document.getElementById('gamesGrid');
  const empty = document.getElementById('emptyState');
  const genre = document.getElementById('genreFilter').value;
  const ratingFilter = document.getElementById('ratingFilter').value;
  const sortBy = document.getElementById('sortSelect').value;

  const players = document.getElementById('playersFilter').value;
  const time = document.getElementById('timeFilter').value;
  const weight = document.getElementById('weightFilter').value;

  let filtered = askIds ? askIds.map(id => collection.find(g => g.id === id)).filter(Boolean) : collection.filter(g => {
    if (genre !== 'ALL' && !(g.genre || '').includes(genre)) return false;
    if (ratingFilter !== 'ALL' && Math.round(ownerStars(g)) !== Number(ratingFilter)) return false;
    if (thinOnly && !g.thinningCandidate) return false;
    if (favOnly && !g.favorite) return false;
    if (players !== 'ALL') {
      const n = Number(players);
      if (!g.minPlayers || !g.maxPlayers) return false;
      if (n === 7 ? g.maxPlayers < 7 : (n < g.minPlayers || n > g.maxPlayers)) return false;
    }
    if (time !== 'ALL') {
      const t = g.maxTime || g.minTime;
      if (!t) return false;
      if (time === 'long' ? t <= 120 : t > Number(time)) return false;
    }
    if (weight !== 'ALL') {
      if (!g.weight) return false;
      if ((weight === 'light' && g.weight >= 2) || (weight === 'medium' && (g.weight < 2 || g.weight >= 3)) || (weight === 'heavy' && g.weight < 3)) return false;
    }
    return true;
  });

  const lastTs = (g) => g.lastPlayed ? new Date(g.lastPlayed).getTime() : 0;
  if (!askIds) filtered.sort((a, b) => {
    const rA = ownerStars(a), rB = ownerStars(b);
    const nA = a.num || 0, nB = b.num || 0;
    const pA = a.playCount || 0, pB = b.playCount || 0;
    switch (sortBy) {
      case 'title-asc': return (a.title || '').localeCompare(b.title || '');
      case 'rank-desc': return rB - rA || nA - nB;
      case 'rank-asc': return rA - rB || nA - nB;
      case 'fav-first': return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || rB - rA || nA - nB;
      case 'plays-desc': return pB - pA || nA - nB;
      case 'plays-asc': return pA - pB || nA - nB;
      case 'recent-desc': return lastTs(b) - lastTs(a) || nA - nB;
      // Never-played games first, then the ones gathering the most dust
      case 'stale-desc': return (lastTs(a) || -Infinity) - (lastTs(b) || -Infinity) || nA - nB;
      case 'bgg-desc': return (b.bggRating || 0) - (a.bggRating || 0) || nA - nB;
      // #1 first; unranked games (expansions, very new or obscure titles) go last
      case 'bggrank-asc': return (a.rank || Infinity) - (b.rank || Infinity) || nA - nB;
      case 'weight-desc': return (b.weight || 0) - (a.weight || 0) || nA - nB;
      case 'weight-asc': return (a.weight || 9) - (b.weight || 9) || nA - nB;
      default: return nA - nB;
    }
  });

  // Count and the clear controls reflect anything that narrows the list
  const nFilters = [genre, ratingFilter, players, time, weight].filter(v => v !== 'ALL').length + (favOnly ? 1 : 0) + (thinOnly ? 1 : 0);
  // The badge is the collection total only; it never changes while you search or filter
  document.getElementById('totalCount').textContent = collection.length;
  const clearBtn = document.getElementById('clearAll');
  clearBtn.hidden = !(nFilters > 0 || askIds);
  clearBtn.querySelector('span').textContent = nFilters + (askIds ? 1 : 0) > 1 ? 'Remove filters' : 'Remove filter';
  document.getElementById('searchClear').hidden = !document.getElementById('searchInput').value;
  document.getElementById('filtersToggle').innerHTML = '<i class="ti ti-adjustments-horizontal"></i> Filters' + (nFilters ? ' <span class="count">' + nFilters + '</span>' : '');
  grid.innerHTML = '';
  // A friend's empty shelf shows the BGG import card instead
  const mineEmpty = typeof viewingMine === 'function' && viewingMine() && collection.length === 0;
  empty.style.display = !mineEmpty && (collection.length === 0 || filtered.length === 0) ? 'block' : 'none';
  if (collection.length === 0) {
    empty.textContent = viewingFriend() ? 'No games on ' + firstName(friendShelfName || 'their') + '’s shelf yet.' : 'No games yet — tap the + button to add one.';
  } else if (filtered.length === 0) {
    empty.innerHTML = 'No games match that search and these filters.<br><button type="button" class="btn primary" style="flex:0 0 auto; margin-top:0.9rem;" data-clear-all>Clear search and filters</button>';
  }

  filtered.forEach(g => {
    const card = document.createElement('article');
    card.className = 'card' + (g.thinningCandidate ? ' thinning' : '');
    card.dataset.open = g.id;
    card.tabIndex = 0;
    const exp = (g.expansions || []).length;
    const plays = playsText(g);
    const byline = bylineText(g);
    card.innerHTML =
      coverHtml(g, g.coverCard,
        (g.bggRating ? '<div class="score" title="BGG average rating">' + Number(g.bggRating).toFixed(1) + '<small>BGG</small></div>' : '') +
        (g.rank ? '<div class="score rank" title="BGG overall rank">#' + g.rank + '<small>BGG</small></div>' : '') +
        (rbGames.has(Number(g.bggId)) ? '<span class="rb-flag" title="Rulebook here: ask Nathan about the rules"><i class="ti ti-book"></i></span>' : '') +
        (g.thinningCandidate ? '<span class="thin-flag"' + (rbGames.has(Number(g.bggId)) ? ' style="bottom:2.5rem;"' : '') + '>Culling</span>' : '') +
        (exp ? '<span class="exp-flag" title="' + esc(g.expansions.join(' · ')) + '"><i class="ti ti-puzzle-2"></i>+' + exp + ' expansion' + (exp > 1 ? 's' : '') + '</span>' : '')) +
      '<div class="card-body">' +
      '<div class="card-heading"><h2 class="game-title">' + esc(g.title) + '</h2>' +
        (byline ? '<div class="byline">' + esc(byline) + '</div>' : '') + '</div>' +
      factsHtml(g) +
      '<div class="card-foot">' +
        starsHtml(g) +
        '<div class="plays' + (plays ? '' : ' never') + '" title="Plays logged on BGG">' +
          (plays ? '<i class="ti ti-player-play"></i>' + esc(plays) : 'Not played yet') + '</div>' +
        favButton(g, 'mini-btn edit-only') +
        '<button class="mini-btn edit-only' + (g.thinningCandidate ? ' on' : '') + '" data-thin="' + esc(g.id) + '" title="' + (g.thinningCandidate ? 'Keep it after all' : 'Mark for culling') + '"><i class="ti ti-scale"></i></button>' +
        '<button class="mini-btn danger edit-only" data-delete="' + esc(g.id) + '" title="Remove from collection"><i class="ti ti-trash"></i></button>' +
      '</div>' +
      '</div>';
    grid.appendChild(card);
  });
  if (detailId) renderDetail();
}

// ---------- detail modal ----------
const detailModal = document.getElementById('detailModal');
let detailId = null;
function openDetail(id) {
  detailId = id;
  renderDetail();
  detailModal.classList.add('open');
}
function closeDetail() { detailModal.classList.remove('open'); detailId = null; }
// Any popup: freeze the page behind it where it is, and put you back in the same spot when it closes
let lockedY = null;
function syncScrollLock() {
  const open = !!document.querySelector('.modal-overlay.open, .nathan-panel.full');
  if (open && lockedY === null) {
    lockedY = window.scrollY;
    document.body.style.top = -lockedY + 'px';
    document.body.classList.add('modal-locked');
  } else if (!open && lockedY !== null) {
    document.body.classList.remove('modal-locked');
    document.body.style.top = '';
    window.scrollTo({ top: lockedY, behavior: 'instant' });
    lockedY = null;
  }
}
// Watches just the popups and Nathan's panel (watching every class change on the page ran this on each render)
const lockWatcher = new MutationObserver(syncScrollLock);
document.querySelectorAll('.modal-overlay, #nathanPanel').forEach((el) => lockWatcher.observe(el, { attributes: true, attributeFilter: ['class'] }));
// Rulebooks: a game's documents (rulebook, reference guide, appendix, FAQ, solo rules), shared by every member.
// We keep only the text Nathan read; people open the official copy from its link.
const rbCache = {};
let rbGames = new Set(); // games with a document ready (the 📖 on every shelf)
let rbPoll = null;
const RB_KINDS = [['rulebook', 'Rulebook'], ['learn', 'Learn to play / quick start'], ['expansion', 'Expansion rulebook'], ['reference', 'Rules reference / cheat sheet'], ['aid', 'Player aid'], ['appendix', 'Appendix / glossary'], ['faq', 'FAQ / errata'], ['solo', 'Solo rules'], ['other', 'Other']];
async function loadRbGames() {
  if (!isMember()) return;
  try { const r = await n8nFetch('/rulebook?games=1', { method: 'GET' }); rbGames = new Set((r.games || []).map(Number)); render(); } catch (e) {}
}
function rbDocHtml(d) {
  const name = esc(d.label) + (d.title ? ' · ' + esc(d.title) : '');
  const reading = d.status === 'queued' || d.status === 'reading';
  const what = reading ? (d.status === 'queued' ? 'Waiting to be read…' : 'Nathan is reading it… page ' + Math.min(d.pagesDone + 1, d.pages) + ' of ' + d.pages)
    : d.status === 'error' ? esc(d.error || 'Nathan couldn’t read this one.')
    : d.pages + ' pages' + (d.uploadedBy ? ' · added by ' + esc(d.uploadedBy) : '') + (d.error ? ' · ' + esc(d.error) : '');
  const acts = (d.source ? '<a href="' + esc(d.source) + '" target="_blank" rel="noopener">Official copy</a>' : '') +
    (d.mine && !d.source ? '<button type="button" data-rb-link="' + d.id + '">Add link</button>' : '') +
    (d.mine ? '<button type="button" class="danger" data-rb-remove="' + d.id + '">' + (rbConfirm === d.id ? 'Tap again to remove' : 'Remove') + '</button>' : '');
  return '<div class="rb-doc"><i class="ti ' + (reading ? 'ti-loader-2 spin' : 'ti-book') + '"></i><div><b>' + name + '</b><span>' + what + '</span></div><div class="rb-actions">' + acts + '</div></div>';
}
let rbConfirm = null;
function rbHtml(info, g) {
  const docs = info.docs || [];
  const lim = info.limits || { pages: 60, perDay: 5, mb: 60 };
  const files = 'https://boardgamegeek.com/boardgame/' + Number(g.bggId) + '/files';
  // One Rulebook per game: once it has one, members add the other kinds (admins can add a second, to replace it)
  const hasBook = docs.some(d => d.kind === 'rulebook' && d.status !== 'error');
  const kinds = hasBook && !isAdmin() ? RB_KINDS.filter(([v]) => v !== 'rulebook') : RB_KINDS;
  return '<div class="section-label" style="margin:0;"><i class="ti ti-book"></i> Rulebooks &amp; guides</div>' +
    (docs.length ? '<div class="rb-docs">' + docs.map(rbDocHtml).join('') + '</div>' +
        (docs.some(d => d.status === 'ready') ? '<div class="hint" style="margin:0.3rem 0 0;">Ask Nathan anything about the rules; he’ll tell you the page.</div>' : '')
      : '<div class="hint" style="margin:0.2rem 0 0;">No rulebook yet. Most publishers post theirs free as a PDF. Add it once and Nathan can answer rules questions for every member, with page numbers.</div>') +
    '<form class="rb-add" data-rb-form="' + Number(g.bggId) + '" data-title="' + esc(g.title) + '">' +
      '<div class="pl-two"><select name="kind" aria-label="What it is">' + kinds.map(([v, l]) => '<option value="' + v + '"' + (v === (hasBook ? 'learn' : 'rulebook') ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
      '<input type="text" name="title" maxlength="120" placeholder="Name (optional), e.g. Quick start"></div>' +
      '<input type="url" name="source" placeholder="Link to the official PDF (publisher or BGG), https://…">' +
      '<div class="row"><label class="btn ghost" style="cursor:pointer;"><i class="ti ti-upload"></i> Choose the PDF<input type="file" name="file" accept="application/pdf,.pdf" hidden></label>' +
        '<a class="btn ghost" href="' + files + '" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Find it on BGG</a></div>' +
      '<p class="hint">Only add rulebooks you’re allowed to share (most publishers post theirs free). Nathan reads the PDF, then it’s deleted: members open the official copy from your link. Up to ' + lim.pages + ' pages, ' + lim.perDay + ' a day.</p>' +
    '</form>';
}
async function loadRulebook(g, fresh) {
  const box = document.getElementById('rbBlock');
  if (!box || !g.bggId) return;
  clearTimeout(rbPoll);
  try {
    const info = (!fresh && rbCache[g.bggId]) || (rbCache[g.bggId] = await n8nFetch('/rulebook?bgg=' + Number(g.bggId), { method: 'GET' }));
    if (document.getElementById('rbBlock') !== box) return;
    box.innerHTML = rbHtml(info, g);
    // While Nathan reads, the page count ticks up; when he's done, the 📖 appears on every shelf
    if ((info.docs || []).some(d => d.status === 'queued' || d.status === 'reading')) rbPoll = setTimeout(() => loadRulebook(g, true), 6000);
    else if ((info.docs || []).some(d => d.status === 'ready') && !rbGames.has(Number(g.bggId))) { rbGames.add(Number(g.bggId)); render(); }
  } catch (e) { box.innerHTML = '<div class="hint" style="margin:0;">' + esc(e.message) + '</div>'; }
}
async function uploadRulebook(form) {
  const input = form.querySelector('input[type=file]');
  const file = input.files[0];
  if (!file) return;
  const bggId = Number(form.dataset.rbForm);
  const lim = (rbCache[bggId] || {}).limits || { mb: 60 };
  if (file.size > lim.mb * 1024 * 1024) { toast('That PDF is over ' + lim.mb + ' MB. Try the publisher’s smaller version.', true); input.value = ''; return; }
  const source = form.querySelector('[name=source]').value.trim();
  if (source && !/^https:\/\/\S{4,}$/.test(source)) { toast('The link should start with https://', true); return; }
  const fd = new FormData();
  fd.append('file', file, file.name); fd.append('bggId', String(bggId)); fd.append('gameTitle', form.dataset.title || '');
  fd.append('kind', form.querySelector('[name=kind]').value); fd.append('title', form.querySelector('[name=title]').value.trim()); fd.append('source', source);
  form.querySelector('.hint').textContent = 'Uploading "' + file.name + '"…';
  try {
    const res = await routedFetch('/rulebook', { method: 'POST', headers: { Authorization: 'Bearer ' + await ensureToken() }, body: fd });
    const r = await res.json().catch(() => ({}));
    if (!res.ok || !r.ok) throw new Error(r.message || 'Upload failed (' + res.status + ')');
    rbCache[bggId] = r;
    toast('Got it. Nathan is reading it now; it takes about 10 seconds a page.');
    const g = collection.find(x => Number(x.bggId) === bggId) || { bggId, title: form.dataset.title };
    loadRulebook(g);
  } catch (e) { toast(e.message, true); form.querySelector('.hint').textContent = e.message; input.value = ''; }
}
async function changeRulebook(body, bggId) {
  try {
    rbCache[bggId] = await n8nFetch('/rulebook-change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    rbConfirm = null;
    if (!(rbCache[bggId].docs || []).some(d => d.status === 'ready')) { rbGames.delete(Number(bggId)); render(); }
    const g = collection.find(x => Number(x.bggId) === bggId) || { bggId };
    loadRulebook(g);
  } catch (e) { toast(e.message, true); }
}
document.addEventListener('change', (e) => { const form = e.target.closest('[data-rb-form]'); if (form && e.target.matches('input[type=file]')) uploadRulebook(form); });
document.addEventListener('submit', (e) => { if (e.target.closest('[data-rb-form]')) e.preventDefault(); });
document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rb-remove]');
  const ln = e.target.closest('[data-rb-link]');
  if (!rm && !ln) return;
  const box = e.target.closest('#rbBlock');
  if (!box) return;
  const bggId = Number(box.dataset.bgg);
  if (rm) {
    const id = Number(rm.dataset.rbRemove);
    if (rbConfirm !== id) { rbConfirm = id; const g = collection.find(x => Number(x.bggId) === bggId) || { bggId }; box.innerHTML = rbHtml(rbCache[bggId] || {}, g); return; }
    changeRulebook({ id, action: 'remove' }, bggId);
  } else {
    const url = (prompt('Link to the official PDF (publisher site or BGG), starting with https://') || '').trim();
    if (!url) return;
    if (!/^https:\/\/\S{4,}$/.test(url)) { toast('The link should start with https://', true); return; }
    changeRulebook({ id: Number(ln.dataset.rbLink), action: 'edit', source: url }, bggId);
  }
});
function renderDetail() {
  const g = collection.find(x => x.id === detailId);
  if (!g) { closeDetail(); return; }
  setTimeout(() => loadRulebook(g), 0);
  const stats = [];
  const stat = (value, label) => { if (value) stats.push('<div class="stat"><b>' + esc(value) + '</b><span>' + label + '</span></div>'); };
  stat(playersText(g), 'Players');
  stat(bestText(g), 'Best with');
  stat(timeText(g), 'Play time');
  stat(g.weight ? Number(g.weight).toFixed(2) + ' · ' + weightLabel(g.weight) : '', 'Weight');
  stat(g.minAge ? g.minAge + '+' : '', 'Age');
  stat(g.bggRating ? Number(g.bggRating).toFixed(1) : '', 'BGG rating');
  stat(g.rank ? '#' + g.rank : '', 'BGG rank');
  stat(g.year, 'Published');
  const chips = (list) => (list || []).map(x => '<span class="tag tag-plain">' + esc(x) + '</span>').join('');
  const c = g.playCount || 0;
  document.getElementById('detailContent').innerHTML =
    (g.coverLarge || g.coverCard ? '<div class="detail-hero"><img src="' + esc(g.coverLarge || g.coverCard) + '" alt="' + esc(g.title) + ' box art"></div>' : '') +
    '<div class="detail-head">' +
      (g.coverLarge || g.coverCard ? '' : '<div class="game-icon lg"><i class="ti ti-' + esc(g.icon || DEFAULT_ICON) + '"></i></div>') +
      '<div><h2 id="detailTitle">' + esc(g.title) + '</h2>' +
        ((g.designers || []).length ? '<div class="byline" style="white-space:normal;">by ' + esc(g.designers.join(', ')) + '</div>' : '') + '</div>' +
    '</div>' +
    '<div class="detail-body">' +
      '<div class="play-panel">' +
        '<div class="big">' + c + '</div>' +
        '<div style="flex:1; min-width:9rem;"><div class="section-label" style="margin:0;">' + (c === 1 ? 'Play' : 'Plays') + '</div>' +
          '<div class="sub">' + (g.lastPlayed ? 'Last played ' + esc(g.lastPlayed) + ' (' + agoText(g.lastPlayed) + ')' : viewingFriend() ? esc(firstName(friendShelfName) || 'They') + ' hasn’t logged a play yet' : 'No plays logged yet') + '</div></div>' +
        '<button class="btn primary edit-only" data-logplay="' + esc(g.id) + '"><i class="ti ti-player-play"></i> Log play</button>' +
      '</div>' +
      '<div class="detail-row edit-only">' +
        '<span style="display:flex; gap:0.5rem; margin-left:auto;">' + favButton(g, 'btn') +
        '<button class="btn' + (g.thinningCandidate ? ' on' : '') + '" data-thin="' + esc(g.id) + '" style="flex:0 0 auto;"><i class="ti ti-scale"></i> ' + (g.thinningCandidate ? 'Marked for culling' : 'Mark for culling') + '</button></span>' +
      '</div>' +
      (stats.length ? '<div class="stat-grid">' + stats.join('') + '</div>' : '') +
      ratingsHtml(g) +
      (isMember() && g.bggId ? '<div class="rb-block" id="rbBlock" data-bgg="' + Number(g.bggId) + '"><div class="section-label" style="margin:0;"><i class="ti ti-book"></i> Rulebooks &amp; guides</div><div class="hint" style="margin:0.2rem 0 0;">Checking…</div></div>' : '') +
      '<div class="tags">' +
        (g.genre ? '<span class="tag tag-genre">' + esc(g.genre) + '</span>' : '') +
        (g.type ? '<span class="tag tag-type">' + esc(g.type) + '</span>' : '') +
      '</div>' +
      (g.desc ? '<p class="detail-desc">' + esc(g.desc) + '</p>' : '') +
      ((g.expansions || []).length ? '<div><div class="section-label">Expansions owned</div><ul>' + g.expansions.map((e, i) => '<li class="exp-item"><span class="exp-dot"></span>' +
        '<a href="' + esc(expansionLink(g, e)) + '" target="_blank" rel="noopener" title="Look it up on BoardGameGeek">' + esc(e) + ' <i class="ti ti-external-link"></i></a>' +
        '<button type="button" class="exp-remove edit-only' + (expConfirm === g.id + ':' + i ? ' armed' : '') + '" data-exp-remove="' + i + '" data-exp-game="' + esc(g.id) + '" aria-label="Remove ' + esc(e) + '">' +
          (expConfirm === g.id + ':' + i ? 'Remove?' : '<i class="ti ti-x"></i>') + '</button></li>').join('') + '</ul></div>' : '') +
      ((g.mechanics || []).length ? '<div><div class="section-label">Mechanics</div><div class="tags">' + chips(g.mechanics) + '</div></div>' : '') +
      ((g.categories || []).length ? '<div><div class="section-label">Categories</div><div class="tags">' + chips(g.categories) + '</div></div>' : '') +
      '<div class="detail-actions">' +
        (g.bggId ? '<a class="btn" href="https://boardgamegeek.com/boardgame/' + Number(g.bggId) + '" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> BoardGameGeek</a>' : '') +
        (viewingFriend() && g.bggId ? '<button class="btn" data-wish-add="' + Number(g.bggId) + '" data-title="' + esc(g.title) + '" data-cover="' + esc(g.coverCard || '') + '"><i class="ti ti-gift"></i> Add to my wishlist</button>' : '') +
        '<button class="btn danger edit-only" data-delete="' + esc(g.id) + '"><i class="ti ti-trash"></i> Delete</button>' +
      '</div>' +
    '</div>';
}
document.getElementById('detailClose').addEventListener('click', closeDetail);
detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) { closeDetail(); return; }
  handleGameAction(e);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (logPlayModal.classList.contains('open')) logPlayModal.classList.remove('open');
  else if (detailModal.classList.contains('open')) closeDetail();
});

// Shared by cards and the detail modal; returns true if the click hit a control
function handleGameAction(e) {
  // Edit controls are hidden for visitors; ignore them anyway if one is reached
  if (!canEdit() && e.target.closest('.star-btn, [data-thin], [data-fav], [data-delete], [data-logplay]')) return false;
  const star = e.target.closest('.star-btn');
  if (star) { savePlayerRating(star.dataset.id, Number(star.dataset.rank)); return true; }
  const thin = e.target.closest('[data-thin]');
  if (thin) { toggleThinning(thin.dataset.thin); return true; }
  const fav = e.target.closest('[data-fav]');
  if (fav) { toggleFavorite(fav.dataset.fav); return true; }
  const del = e.target.closest('[data-delete]');
  if (del) { closeDetail(); openDeleteModal(del.dataset.delete); return true; }
  const log = e.target.closest('[data-logplay]');
  if (log) { openLogPlay(log.dataset.logplay); return true; }
  return false;
}

const grid = document.getElementById('gamesGrid');
grid.addEventListener('click', (e) => {
  if (handleGameAction(e)) return;
  const card = e.target.closest('[data-open]');
  if (card) openDetail(card.dataset.open);
});
grid.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) { e.preventDefault(); openDetail(e.target.dataset.open); }
});

// ---------- log a play via BG Stats ----------
const LS_PLAYERS = 'vault_players_v1';
const logPlayModal = document.getElementById('logPlayModal');
let logPlayId = null;
let playerState = {}; // name -> 'sel' | 'win'
function knownPlayers() { try { return JSON.parse(localStorage.getItem(LS_PLAYERS) || '[]'); } catch (e) { return []; } }
function renderPlayerChips() {
  const names = knownPlayers();
  document.getElementById('playerChips').innerHTML = names.length
    ? names.map(n => '<button class="player-chip ' + (playerState[n] || '') + '" data-player="' + esc(n) + '">' + (playerState[n] === 'win' ? '🏆 ' : '') + esc(n) + '</button>').join('')
    : '<span class="hint" style="margin:0;">No saved players yet — add names below.</span>';
}
function openLogPlay(id) {
  const g = collection.find(x => x.id === id);
  if (!g) return;
  logPlayId = id;
  playerState = {};
  document.getElementById('logPlayGame').textContent = g.title + (g.bggId ? '' : ' — not linked to BGG yet, so BG Stats will ask you to pick the game.');
  document.getElementById('playDate').value = new Date().toLocaleDateString('en-CA');
  document.getElementById('playDuration').value = '';
  document.getElementById('newPlayerInput').value = '';
  renderPlayerChips();
  logPlayModal.classList.add('open');
}
document.getElementById('playerChips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-player]');
  if (!chip) return;
  const n = chip.dataset.player;
  playerState[n] = !playerState[n] ? 'sel' : playerState[n] === 'sel' ? 'win' : undefined;
  if (!playerState[n]) delete playerState[n];
  renderPlayerChips();
});
document.getElementById('newPlayerInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const n = e.target.value.trim();
  if (!n) return;
  const names = knownPlayers();
  if (!names.includes(n)) { names.push(n); try { localStorage.setItem(LS_PLAYERS, JSON.stringify(names)); } catch (err) {} }
  playerState[n] = 'sel';
  e.target.value = '';
  renderPlayerChips();
});
document.getElementById('logPlayCancel').addEventListener('click', () => logPlayModal.classList.remove('open'));
document.getElementById('logPlaySend').addEventListener('click', () => {
  const g = collection.find(x => x.id === logPlayId);
  if (!g) return;
  const names = Object.keys(playerState);
  if (!names.length) { toast('Pick at least one player.', true); return; }
  const day = document.getElementById('playDate').value || new Date().toLocaleDateString('en-CA');
  // BG Stats wants the UTC end time as "yyyy-MM-dd HH:mm:ss"; use local noon (or now, for today) of the chosen day
  const local = day === new Date().toLocaleDateString('en-CA') ? new Date() : new Date(day + 'T12:00:00');
  const playDate = local.toISOString().slice(0, 19).replace('T', ' ');
  const duration = Number(document.getElementById('playDuration').value) || undefined;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const data = {
    sourceName: 'Board Game Curator',
    sourcePlayId: 'bgc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    playDate,
    ...(duration ? { durationMin: duration } : {}),
    game: { name: g.title, sourceGameId: g.id, ...(g.bggId ? { bggId: Number(g.bggId) } : {}), highestWins: true },
    players: names.map(n => ({ name: n, sourcePlayerId: 'p-' + slug(n), winner: playerState[n] === 'win' })),
  };
  window.location.href = 'https://app.bgstatsapp.com/createPlay.html?data=' + encodeURIComponent(JSON.stringify(data));
  logPlayModal.classList.remove('open');
  toast('Sent to BG Stats — your count updates after the next BGG sync.');
});

document.getElementById('searchInput').addEventListener('input', (e) => { document.getElementById('searchClear').hidden = !e.target.value; });
['genreFilter', 'ratingFilter', 'sortSelect', 'playersFilter', 'timeFilter', 'weightFilter'].forEach(id => document.getElementById(id).addEventListener('change', render));
document.getElementById('filtersToggle').addEventListener('click', (e) => {
  const open = document.getElementById('filtersPanel').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
document.getElementById('favFilterBtn').addEventListener('click', (e) => {
  favOnly = !favOnly;
  e.currentTarget.classList.toggle('active', favOnly);
  render();
});
document.getElementById('thinFilterBtn').addEventListener('click', (e) => {
  thinOnly = !thinOnly;
  e.currentTarget.classList.toggle('active', thinOnly);
  render();
});
document.getElementById('searchClear').addEventListener('click', () => {
  const input = document.getElementById('searchInput');
  input.value = '';
  render();
  input.focus();
});
document.getElementById('emptyState').addEventListener('click', (e) => { if (e.target.closest('[data-clear-all]')) document.getElementById('clearAll').click(); });
// Resets search and every filter; the sort order is a preference, so it stays
document.getElementById('clearAll').addEventListener('click', () => {
  askIds = null;
  document.getElementById('searchInput').value = '';
  ['genreFilter', 'ratingFilter', 'playersFilter', 'timeFilter', 'weightFilter'].forEach(id => { document.getElementById(id).value = 'ALL'; });
  favOnly = thinOnly = false;
  document.getElementById('favFilterBtn').classList.remove('active');
  document.getElementById('thinFilterBtn').classList.remove('active');
  render();
});

// Settings modal
const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', () => {
  settingsModal.classList.add('open');
});
document.getElementById('settingsCancel').addEventListener('click', () => settingsModal.classList.remove('open'));
document.getElementById('settingsClose').addEventListener('click', () => settingsModal.classList.remove('open'));
// Your own plays, for everyone (Dan included): the same import as "Connect BGG", run again with your username; without
// one yet, it asks for it first
document.getElementById('syncMyPlaysBtn').addEventListener('click', async () => {
  try { if (!myShelf || !myShelf.bggUsername) myShelf = await n8nFetch('/shelf', { method: 'GET' }); } catch (e) {}
  settingsModal.classList.remove('open');
  let username = (myShelf && myShelf.bggUsername) || '';
  if (!username) {
    username = (prompt('Your BoardGameGeek username (brings in your logged plays, not games):', '') || '').trim();
    if (!username) return;
  }
  if (await startImport(username)) toast('Syncing your plays from BGG. They’ll show up in a minute or two.');
});
// What's new: the release notes (CHANGELOG.md, published with the site), newest first
const newsModal = document.getElementById('newsModal');
let newsText = null;
async function loadNews() {
  if (newsText === null) {
    const r = await fetch('CHANGELOG.md', { cache: 'no-cache' });
    if (!r.ok) throw new Error('Couldn’t load the release notes. Try again in a moment.');
    newsText = await r.text();
  }
  return newsText.split(/^## /m).slice(1).map((p) => p.trim().split('\n'));
}
const newsInline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
function newsHtml(versions) {
  return versions.map((lines) => {
    const [ver, ...when] = lines[0].split(' · ');
    let html = '<section class="news-ver"><h3>' + esc(ver) + (when.length ? '<span>' + esc(when.join(' · ')) + '</span>' : '') + '</h3>';
    let list = false;
    for (const raw of lines.slice(1)) {
      const t = raw.trim();
      if (t.startsWith('- ')) { html += (list ? '' : '<ul>') + '<li>' + newsInline(t.slice(2)) + '</li>'; list = true; continue; }
      if (list) { html += '</ul>'; list = false; }
      if (!t) continue;
      html += /^\*\*[^*]+\*\*$/.test(t) || t.startsWith('### ') ? '<h4>' + esc(t.replace(/^### |\*\*/g, '')) + '</h4>' : '<p>' + newsInline(t) + '</p>';
    }
    return html + (list ? '</ul>' : '') + '</section>';
  }).join('');
}
// The cog shows which version you're on
document.getElementById('settingsBtn').addEventListener('click', async () => {
  try { const [latest] = await loadNews(); if (latest) document.getElementById('newsVersion').textContent = 'You’re on ' + latest[0].replace(' · ', ', updated ') + '.'; } catch (e) {}
});
document.getElementById('openNewsBtn').addEventListener('click', async () => {
  settingsModal.classList.remove('open');
  newsModal.classList.add('open');
  const body = document.getElementById('newsBody');
  try { body.innerHTML = newsHtml(await loadNews()); }
  catch (e) { body.innerHTML = '<p class="hint">' + esc(e.message) + '</p>'; }
  newsModal.querySelector('.modal').scrollTop = 0;
});
for (const id of ['newsClose', 'newsX']) document.getElementById(id).addEventListener('click', () => newsModal.classList.remove('open'));

// Send feedback: a face for how it's going (optional), what it's about, and their words; Dan gets an email he can reply to
const feedbackModal = document.getElementById('feedbackModal');
const fbForm = document.getElementById('feedbackForm');
let fbMood = null, fbKind = 'idea';
const fbPick = (box, attr, val) => box.querySelectorAll('[data-' + attr + ']').forEach((b) => { const on = b.dataset[attr] === String(val); b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); });
document.getElementById('openFeedbackBtn').addEventListener('click', () => {
  settingsModal.classList.remove('open');
  fbMood = null; fbKind = 'idea';
  fbPick(fbForm, 'mood', ''); fbPick(fbForm, 'kind', 'idea');
  document.getElementById('fbMessage').value = '';
  feedbackModal.classList.add('open');
});
fbForm.addEventListener('click', (e) => {
  const m = e.target.closest('[data-mood]');
  if (m) { fbMood = fbMood === Number(m.dataset.mood) ? null : Number(m.dataset.mood); fbPick(fbForm, 'mood', fbMood ?? ''); return; }
  const k = e.target.closest('[data-kind]');
  if (k) { fbKind = k.dataset.kind; fbPick(fbForm, 'kind', fbKind); }
});
const closeFeedback = () => feedbackModal.classList.remove('open');
document.getElementById('feedbackCancel').addEventListener('click', closeFeedback);
feedbackModal.addEventListener('click', (e) => { if (e.target === feedbackModal) closeFeedback(); });
fbForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = document.getElementById('fbMessage').value.trim();
  if (!message && !fbMood) { toast('Pick a face or write a few words first.', true); document.getElementById('fbMessage').focus(); return; }
  const send = document.getElementById('feedbackSend');
  send.disabled = true; send.textContent = 'Sending…';
  // Where they were and on what, so a problem can be found again
  const where = [location.pathname + location.hash, viewingFriend() ? 'viewing a friend’s shelf' : '', document.getElementById('nathanPanel').classList.contains('full') ? 'Nathan full screen' : ''].filter(Boolean).join(' · ');
  const device = navigator.userAgent.slice(0, 220) + ' · ' + window.innerWidth + '×' + window.innerHeight;
  try {
    const r = await n8nFetch('/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: fbKind, mood: fbMood, message, page: where, device }) });
    closeFeedback();
    toast(r.message || 'Thanks!');
  } catch (err) { toast(err.message, true); }
  finally { send.disabled = false; send.textContent = 'Send'; }
});
newsModal.addEventListener('click', (e) => { if (e.target === newsModal) newsModal.classList.remove('open'); });
// Add-by-photo modal
const addModal = document.getElementById('addModal');
const identifyArea = document.getElementById('identifyArea');
// ---------- add by name ----------
function setAddTab(tab) {
  document.querySelectorAll('.add-tab').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  document.getElementById('paneName').hidden = tab !== 'name';
  document.getElementById('panePhoto').hidden = tab !== 'photo';
  document.getElementById('paneCsv').hidden = tab !== 'csv';
  identifyArea.innerHTML = '';
  if (tab === 'name') setTimeout(() => document.getElementById('nameSearchInput').focus(), 0);
}
document.querySelectorAll('.add-tab').forEach(b => b.addEventListener('click', () => setAddTab(b.dataset.tab)));

// Mirrors the server's title normalization so "owned" badges agree with what /add will accept
const normTitle = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();
function ownedNote(r) {
  const g = collection.find(x => (x.bggId && Number(x.bggId) === r.bggId) || normTitle(x.title) === normTitle(r.title));
  if (g) return 'In your collection' + (g.title !== r.title ? ' as ' + g.title : '');
  const host = collection.find(x => (x.expansions || []).some(e => normTitle(e) === normTitle(r.title)));
  return host ? 'Listed as an expansion of ' + host.title : '';
}
let lastSearch = '';
document.getElementById('nameSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('nameSearchInput').value.trim();
  const box = document.getElementById('nameResults');
  identifyArea.innerHTML = '';
  if (q.length < 2) { box.innerHTML = '<p class="hint">Type at least 2 characters.</p>'; return; }
  lastSearch = q;
  picked.clear();
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const { results } = await n8nFetch('/bgg-search?q=' + encodeURIComponent(q), { method: 'GET', signal: AbortSignal.timeout(30000) });
    if (q !== lastSearch) return; // a newer search is in flight
    box.innerHTML = (results.length ? results.map(r => {
      const owned = ownedNote(r);
      const base = r.kind === 'expansion' && r.expands.length ? 'Expansion of ' + r.expands.map(b => b.title).join(', ') : (r.kind === 'expansion' ? 'Expansion' : '');
      const meta = [r.year, base, r.rating ? 'BGG ' + Number(r.rating).toFixed(1) : '', r.rank ? '#' + r.rank : ''].filter(Boolean).join(' · ');
      return '<div class="candidate' + (owned ? ' owned' : '') + '"' + (owned ? '' : ' role="checkbox" aria-checked="false" tabindex="0" data-pick="' + r.bggId + '" data-pick-title="' + esc(r.title) + '" data-pick-kind="' + (r.kind === 'expansion' ? 'expansion' : 'game') + '"') + '>' +
        (r.thumbnail ? '<img src="' + esc(r.thumbnail) + '" alt="" loading="lazy">' : '<div class="game-icon"><i class="ti ti-meeple"></i></div>') +
        '<div class="cmeta"><div class="ctitle">' + esc(r.title) + '</div><div class="cyear">' + esc(owned || meta) + '</div></div>' +
        (owned ? '' : '<span class="pick" aria-hidden="true"><i class="ti ti-check"></i></span>') +
      '</div>';
    }).join('') : '<p class="hint">No BGG matches for "' + esc(q) + '".</p>') +
      '<button class="add-asis" data-add-asis="' + esc(q) + '">Not on BGG? Add "' + esc(q) + '" as is</button>' +
      (results.length ? '<div class="pick-bar"><button class="btn primary" id="addPicked" disabled>Tick the ones you own</button></div>' : '');
  } catch (err) {
    box.innerHTML = '<p class="hint">Search failed: ' + esc(err.message) + '</p>';
  }
});
// Tick any number of results (a game and the expansions you own), then add them in one go
const picked = new Map(); // bggId -> { title, kind }
function renderPicked() {
  document.querySelectorAll('#nameResults [data-pick]').forEach(c => {
    const on = picked.has(c.dataset.pick);
    c.classList.toggle('picked', on);
    c.setAttribute('aria-checked', String(on));
  });
  const go = document.getElementById('addPicked');
  if (go) { go.disabled = !picked.size; go.textContent = picked.size ? 'Add ' + picked.size + ' to my shelf' : 'Tick the ones you own'; }
}
async function addGames(list) {
  // Base games first, so an expansion picked with its game lands under it
  list = [...list].sort((a, b) => (a.kind === 'expansion') - (b.kind === 'expansion'));
  document.querySelectorAll('#nameResults button').forEach(b => b.disabled = true);
  const all = { added: [], expansions: [], skipped: [] };
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    identifyArea.innerHTML = '<div class="spinner"></div><p class="hint" style="text-align:center;">Adding "' + esc(g.title) + '"' + (list.length > 1 ? ' (' + (i + 1) + ' of ' + list.length + ')' : '') + '…</p>';
    try {
      // Onto your own shelf (BGG details, box art, a blurb and an icon for a game new to the catalog: up to a minute)
      const r = await n8nFetch('/shelf-add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g.payload), signal: AbortSignal.timeout(60000) });
      all.added.push(...(r.added || [])); all.expansions.push(...(r.expansions || [])); all.skipped.push(...(r.skipped || []));
    } catch (err) { failed.push(g.title + ': ' + err.message); }
  }
  identifyArea.innerHTML = identifySummaryHtml(all) + (failed.length ? '<p class="hint" style="color:var(--brand-dark);">' + failed.map(esc).join('<br>') + '</p>' : '');
  document.getElementById('addCancel').textContent = 'Done';
  const n = all.added.length + all.expansions.length;
  if (n) toast(n === 1 ? 'Added "' + (all.added[0] || all.expansions[0]).title + '".' : 'Added ' + n + ' games and expansions.');
  else if (failed.length) toast(failed[0], true);
  picked.clear();
  await loadCollection();
  document.getElementById('nameResults').innerHTML = '';
  document.getElementById('nameSearchInput').value = '';
}
document.getElementById('nameResults').addEventListener('click', (e) => {
  const card = e.target.closest('[data-pick]');
  if (card) {
    const id = card.dataset.pick;
    if (picked.has(id)) picked.delete(id); else picked.set(id, { title: card.dataset.pickTitle, kind: card.dataset.pickKind });
    renderPicked();
    return;
  }
  if (e.target.closest('#addPicked') && picked.size) {
    addGames([...picked].map(([id, p]) => ({ title: p.title, kind: p.kind, payload: { bggId: Number(id) } })));
    return;
  }
  const asis = e.target.closest('[data-add-asis]');
  if (asis) addGames([{ title: asis.dataset.addAsis, kind: 'game', payload: { title: asis.dataset.addAsis } }]);
});
document.getElementById('nameResults').addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-pick]')) { e.preventDefault(); e.target.click(); }
});

document.getElementById('addFab').addEventListener('click', () => openAddModal('name'));
// Back to top, once you're more than two screens down
const toTop = document.getElementById('toTop');
let toTopTick = false;
window.addEventListener('scroll', () => {
  if (toTopTick) return;
  toTopTick = true;
  requestAnimationFrame(() => { toTop.classList.toggle('show', window.scrollY > window.innerHeight * 2); toTopTick = false; });
}, { passive: true });
toTop.addEventListener('click', () => {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
});
function openAddModal(tab, query) {
  document.getElementById('csvInput').value = '';
  document.getElementById('csvPreview').innerHTML = '';
  document.getElementById('photoInput').value = '';
  document.getElementById('nameResults').innerHTML = '';
  document.getElementById('nameSearchInput').value = '';
  document.getElementById('addCancel').textContent = 'Cancel';
  setAddTab(tab || 'name');
  identifyArea.innerHTML = '';
  addModal.classList.add('open');
  if (query) { document.getElementById('nameSearchInput').value = query; document.getElementById('nameSearchForm').requestSubmit(); }
}

// ---------- add from a spreadsheet ----------
// CSV rows (quotes, commas inside quotes, ; or tab separators all fine)
function parseCsv(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].map(c => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}
let csvPlan = null; // { rows, header, cols: { title, id, year, own } }
function csvColumns(rows) {
  const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (re) => head.findIndex(h => re.test(h));
  const cols = { title: find(/^(objectname|name|title|game|gamename|gametitle|boardgame|boardgamename)$/), id: find(/^(objectid|bggid|bgg|id|gameid)$/),
    year: find(/^(year|yearpublished|published)$/), own: find(/^own(ed)?$/) };
  const header = cols.title >= 0 || cols.id >= 0;
  if (!header) cols.title = 0; // no header row: the first column is the game names
  return { header, cols };
}
function csvRows(plan) {
  const { cols } = plan;
  return plan.rows.slice(plan.header ? 1 : 0)
    .filter(r => cols.own < 0 || /^(1|y|yes|true|x)$/i.test(r[cols.own] || '')) // a BGG export: only the games marked owned
    .map(r => ({ title: cols.title >= 0 ? r[cols.title] || '' : '', bggId: cols.id >= 0 && /^\d+$/.test(r[cols.id] || '') ? r[cols.id] : '', year: cols.year >= 0 ? r[cols.year] || '' : '' }))
    .filter(r => r.title || r.bggId);
}
function renderCsvPreview() {
  const box = document.getElementById('csvPreview');
  if (!csvPlan) { box.innerHTML = ''; return; }
  const rows = csvRows(csvPlan);
  const names = csvPlan.header ? csvPlan.rows[0] : csvPlan.rows[0].map((_, i) => 'Column ' + (i + 1));
  const opts = names.map((n, i) => '<option value="' + i + '"' + (i === csvPlan.cols.title ? ' selected' : '') + '>' + esc(n || 'Column ' + (i + 1)) + '</option>').join('');
  box.innerHTML = '<div class="csv-preview"><div><b>' + rows.length + '</b> game' + (rows.length === 1 ? '' : 's') + ' · names from <select id="csvTitleCol">' + opts + '</select></div>' +
    (csvPlan.cols.own >= 0 ? '<div class="sample">Only rows marked as owned are included.</div>' : '') +
    '<div class="sample">' + esc(rows.slice(0, 5).map(r => r.title || 'BGG #' + r.bggId).join(' · ')) + (rows.length > 5 ? ' …' : '') + '</div></div>' +
    '<button class="btn primary" id="csvGo" style="width:100%; margin-top:0.75rem;"' + (rows.length ? '' : ' disabled') + '><i class="ti ti-table-import"></i> Add ' + rows.length + ' game' + (rows.length === 1 ? '' : 's') + ' to my shelf</button>';
}
document.getElementById('csvInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  csvPlan = null;
  if (!f) { renderCsvPreview(); return; }
  if (f.size > 3 * 1024 * 1024) { toast('That file is too big. Save just the game list as CSV.', true); return; }
  const rows = parseCsv(await f.text());
  if (!rows.length) { toast('That file looks empty.', true); return; }
  csvPlan = { rows, ...csvColumns(rows) };
  renderCsvPreview();
});
document.getElementById('csvTemplate').addEventListener('click', (e) => {
  e.preventDefault();
  const csv = ['Name,Year,BGG ID', 'Wingspan,2019,266192', 'Catan,,', 'Catan: Seafarers,,', ''].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'my-games.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
document.getElementById('csvPreview').addEventListener('change', (e) => {
  if (e.target.id === 'csvTitleCol' && csvPlan) { csvPlan.cols.title = Number(e.target.value); renderCsvPreview(); }
});
document.getElementById('csvPreview').addEventListener('click', async (e) => {
  const go = e.target.closest('#csvGo');
  if (!go || !csvPlan) return;
  const rows = csvRows(csvPlan);
  if (rows.length > 2000) { toast('That’s more than 2,000 games. Split the file in two.', true); return; }
  go.disabled = true; go.textContent = 'Starting…';
  try {
    const r = await n8nFetch('/shelf-csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    addModal.classList.remove('open');
    csvPlan = null;
    if (viewingMine()) {
      myShelf = { ...(myShelf || {}), status: { state: 'running', kind: 'csv', step: r.lookingUp ? 'Looking up ' + r.lookingUp + ' games on BGG' : 'Getting game details and box art', at: new Date().toISOString() } };
      renderImportPanel();
    } else toast('Adding ' + rows.length + ' games in the background. Refresh in a few minutes.');
  } catch (err) { toast(err.message, true); go.disabled = false; go.textContent = 'Try again'; }
});
document.getElementById('addCancel').addEventListener('click', () => addModal.classList.remove('open'));

document.getElementById('identifyBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('photoInput');
  const file = fileInput.files[0];
  if (!file) { toast('Choose or take a photo first.', true); return; }
  const btn = document.getElementById('identifyBtn');
  btn.disabled = true;
  identifyArea.innerHTML = '<div class="spinner"></div><p style="text-align:center; color:var(--text-muted); font-size:0.85rem; margin-top:0.5rem;">Reading the boxes, checking your collection and looking them up on BGG… this can take up to a minute for a shelf photo.</p>';
  try {
    const form = new FormData();
    form.append('photo', await shrinkPhoto(file), 'boxes.jpg');
    // Onto your own shelf
    const res = await routedFetch('/shelf-identify', { method: 'POST', body: form, headers: { Authorization: 'Bearer ' + await ensureToken() } });
    if (res.status === 401) throw handleUnauthorized();
    let result = {};
    try { result = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(result.message || 'Identify request failed (' + res.status + ')');
    identifyArea.innerHTML = identifySummaryHtml(result);
    document.getElementById('addCancel').textContent = 'Done';
    const n = (result.added || []).length + (result.expansions || []).length;
    toast(n ? 'Collection updated.' : 'Nothing new in that photo.');
    await loadCollection();
  } catch (e) {
    identifyArea.innerHTML = '';
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

// Phone photos are often 4-8 MB; the vision model caps images at ~5 MB and smaller uploads are faster.
// 2000px on the long side still reads box spines fine.
async function shrinkPhoto(file, maxSide = 2000) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85));
  } catch (e) {
    return file; // e.g. a format the browser can't decode; let the server try the original
  }
}

function identifySummaryHtml(r) {
  const section = (label, rows) => rows.length
    ? '<div class="section-label" style="margin-top:1rem;">' + label + '</div><ul>' + rows.map(x => '<li class="exp-item"><span class="exp-dot"></span>' + x + '</li>').join('') + '</ul>'
    : '';
  return section('Added', (r.added || []).map(a => esc(a.title))) +
    section('Added as expansions', (r.expansions || []).map(x => esc(x.title) + ' <span class="hint" style="margin:0;">→ ' + esc(x.base) + '</span>')) +
    section('Already in your collection', (r.skipped || []).map(s => esc(s.title) + (s.existing && s.existing !== s.title ? ' <span class="hint" style="margin:0;">(as ' + esc(s.existing) + ')</span>' : ''))) +
    section('Not processed — take another photo of these', (r.deferred || []).map(esc));
}

// ---------- Ratings (per person, 1-5) ----------
function starsPicker(attr, gameId, current, extra) {
  let h = '';
  for (let i = 1; i <= 5; i++) h += '<button type="button" class="' + (current >= i - 0.25 ? 'on' : '') + '" ' + attr + '="' + esc(gameId) + '" data-stars="' + i + '"' + (extra || '') + ' title="' + i + ' star' + (i > 1 ? 's' : '') + '"><i class="ti ti-filled ti-star-filled"></i></button>';
  return '<div class="rate-stars">' + h + '</div>';
}
// Stars are each person's own BGC rating; BGG ratings are shown apart, out of 10
// An expansion's BGG page: a search for the base game plus its name ("Pantheon Expansion" → "A Feast for Odin Pantheon")
function expansionLink(g, e) {
  const name = String(e).replace(/\b(expansion|box|pack)\b/gi, '').replace(/\s+/g, ' ').trim();
  const base = String(g.title || '').toLowerCase();
  const q = name.toLowerCase().startsWith(base.split(':')[0]) ? name : g.title + ' ' + name;
  return 'https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=' + encodeURIComponent(q);
}
let expConfirm = null; // "gameId:index" waiting for a second tap
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-exp-remove]');
  if (!b) { if (expConfirm && !e.target.closest('.exp-remove')) { expConfirm = null; } return; }
  const id = b.dataset.expGame, i = Number(b.dataset.expRemove);
  const g = collection.find(x => String(x.id) === id);
  if (!g || !canEdit()) return;
  if (expConfirm !== id + ':' + i) { expConfirm = id + ':' + i; renderDetail(); return; }
  expConfirm = null;
  const gone = g.expansions[i];
  updateGame(g.id, { expansions: g.expansions.filter((_, k) => k !== i) }).then(() => { renderDetail(); toast('Removed ' + gone + '.'); });
  renderDetail();
});

function ratingsHtml(g) {
  const byPlayer = (people.ratings || {})[g.id] || {};
  const name = (id) => (people.players.find(p => p.id === id) || {}).name || 'Someone';
  const me = people.me || myPlayerId();
  const rows = [];
  if (isMember() && me) rows.push('<div class="rate-row"><span class="who">Your rating</span>' + starsPicker('data-rate-self', g.id, (byPlayer[me] || {}).stars || 0) + '</div>');
  const bgc = Object.entries(byPlayer).filter(([, r]) => r.stars).sort((x, y) => y[1].stars - x[1].stars);
  const bgg = Object.entries(byPlayer).filter(([, r]) => r.bgg).sort((x, y) => y[1].bgg - x[1].bgg);
  const others = bgc.filter(([pid]) => pid !== me);
  const avg = bgc.length ? bgc.reduce((n, [, r]) => n + r.stars, 0) / bgc.length : 0;
  return '<div class="ratings-block"><div class="section-label" style="margin:0;">Ratings' + (bgc.length > 1 ? ' · ' + avg.toFixed(1) + '★ average' : '') + '</div>' +
    rows.join('') +
    (others.length ? '<div class="rate-list">' + others.map(([pid, r]) => '<span class="rate-chip">' + esc(firstName(name(pid))) + ' ' + r.stars + ' <i class="ti ti-filled ti-star-filled"></i></span>').join('') + '</div>'
      : (!rows.length ? '<p class="hint" style="margin:0;">No ratings yet.</p>' : '')) +
    (bgg.length ? '<div class="section-label" style="margin:0.4rem 0 0;">On BGG</div><div class="rate-list">' + bgg.map(([pid, r]) => '<span class="rate-chip">' + esc(firstName(name(pid))) + ' ' + r.bgg + '<small>/10</small></span>').join('') + '</div>' : '') +
  '</div>';
}
async function savePlayerRating(gameId, stars) {
  const pid = people.me || myPlayerId();
  const byPlayer = ((people.ratings ||= {})[gameId] ||= {});
  const prev = byPlayer[pid] ? { ...byPlayer[pid] } : null;
  const clear = prev && Math.round(prev.stars || 0) === stars; // tapping your current rating clears it
  const next = clear ? 0 : stars;
  const keep = prev && prev.bgg ? { bgg: prev.bgg } : {};
  if (next) byPlayer[pid] = { ...keep, stars: next }; else if (keep.bgg) byPlayer[pid] = keep; else delete byPlayer[pid];
  if (detailId) renderDetail();
  render(); // the card's stars are the same rating
  try {
    await n8nFetch('/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId, stars: next }) });
  } catch (e) {
    if (prev) byPlayer[pid] = prev; else delete byPlayer[pid];
    if (detailId) renderDetail();
    render();
    toast('Couldn’t save that rating: ' + e.message, true);
  }
}
document.getElementById('detailModal').addEventListener('click', (e) => {
  const self = e.target.closest('[data-rate-self]');
  if (self) savePlayerRating(self.dataset.rateSelf, Number(self.dataset.stars));
});

// ---------- Players (owner) ----------
const DIALS = [
  { key: 'complexity', label: 'Complexity', lo: 'Light', hi: 'Heavy' },
  { key: 'conflict', label: 'Conflict', lo: 'Co-op only', hi: 'Cutthroat' },
  { key: 'luck', label: 'Luck', lo: 'Hates dice', hi: 'Loves chaos' },
  { key: 'tableTalk', label: 'Table talk', lo: 'Quiet thinker', hi: 'Party energy' },
  { key: 'theme', label: 'Theme vs. puzzle', lo: 'Puzzle first', hi: 'Story first' },
];
const playersModal = document.getElementById('playersModal');
let adminPlayers = [];
let editing = null; // the player object being edited (a copy)
async function openPlayers() {
  settingsModal.classList.remove('open');
  playersModal.classList.add('open');
  editing = null;
  document.getElementById('playersBody').innerHTML = '<div class="spinner"></div>';
  try {
    adminPlayers = (await n8nFetch('/players-admin', { method: 'GET' })).players || [];
    renderPlayers();
  } catch (e) {
    document.getElementById('playersBody').innerHTML = '<p class="hint">' + esc(e.message) + '</p>';
  }
}
// Everyone from your logged plays can be a lot of people: search by name, most plays first, 25 at a time
const PL_PAGE = 25;
let plQuery = '', plPage = 0;
function renderPlayers() {
  const body = document.getElementById('playersBody');
  if (editing) { body.innerHTML = playerFormHtml(editing); return; }
  body.innerHTML = '<p class="hint" style="margin-top:0;">Everyone you’ve logged a play with is added automatically each night. Friends you connect with by code are known to Nathan too. Active players show first when asking Nathan.</p>' +
    '<div class="top-search" style="margin:0 0 0.6rem;"><input type="search" id="plSearch" placeholder="Search ' + adminPlayers.length + ' people by name" autocomplete="off" value="' + esc(plQuery) + '"></div>' +
    '<div id="plList"></div>';
  renderPlayerList();
}
function renderPlayerList() {
  const box = document.getElementById('plList');
  if (!box) return;
  const q = plQuery.trim().toLowerCase();
  const list = adminPlayers.filter(p => !q || [p.name, ...(p.aliases || [])].some(n => String(n).toLowerCase().includes(q)))
    .sort((a, b) => (b.active - a.active) || ((b.plays || 0) - (a.plays || 0)) || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(list.length / PL_PAGE));
  plPage = Math.min(plPage, pages - 1);
  const shown = list.slice(plPage * PL_PAGE, (plPage + 1) * PL_PAGE);
  box.innerHTML = (shown.length ? '<div class="pl-list">' + shown.map(p => '<button type="button" class="pl-row" data-edit-player="' + esc(p.id) + '">' +
      '<span class="dot' + (p.active ? ' on' : '') + '" title="' + (p.active ? 'Active' : 'Inactive') + '"></span>' +
      '<span class="n">' + esc(p.name) + '</span>' +
      (p.googleEmail ? '<span class="pl-badge" title="Can sign in and rate">Google</span>' : '') +
      (p.bggUsername ? '<span class="pl-badge" title="BGG ratings sync">BGG</span>' : '') +
      '<span class="m">' + (p.plays ? p.plays + ' plays' : 'no plays') + '</span></button>').join('') + '</div>'
    : '<p class="hint" style="margin:0;">No one by that name.</p>') +
    (pages > 1 ? '<div class="modal-actions" style="justify-content:space-between; align-items:center; margin-top:0.6rem;">' +
      '<button type="button" class="btn ghost" data-pl-page="-1"' + (plPage ? '' : ' disabled') + '><i class="ti ti-chevron-left"></i> Previous</button>' +
      '<span class="hint" style="margin:0;">' + (plPage * PL_PAGE + 1) + '–' + Math.min(list.length, (plPage + 1) * PL_PAGE) + ' of ' + list.length + '</span>' +
      '<button type="button" class="btn ghost" data-pl-page="1"' + (plPage < pages - 1 ? '' : ' disabled') + '>Next <i class="ti ti-chevron-right"></i></button></div>' : '');
}
document.getElementById('playersBody').addEventListener('input', (e) => { if (e.target.id === 'plSearch') { plQuery = e.target.value; plPage = 0; renderPlayerList(); } });
document.getElementById('playersBody').addEventListener('click', (e) => { const b = e.target.closest('[data-pl-page]'); if (b) { plPage += Number(b.dataset.plPage); renderPlayerList(); } });
function playerFormHtml(p) {
  return '<form class="pl-form" id="playerForm">' +
    '<div class="pl-two"><div><label for="pfName">Name</label><input type="text" id="pfName" value="' + esc(p.name || '') + '" required></div>' +
    '<div><label for="pfAliases">Other names <span style="font-weight:600;">(as logged in BG Stats)</span></label><input type="text" id="pfAliases" value="' + esc((p.aliases || []).join(', ')) + '"></div></div>' +
    '<label class="pl-check"><input type="checkbox" id="pfActive"' + (p.active ? ' checked' : '') + '> Active (shows first when asking Nathan)</label>' +
    '<label for="pfBgg">BGG username <span style="font-weight:600;">(syncs their BGG ratings)</span></label><input type="text" id="pfBgg" value="' + esc(p.bggUsername || '') + '">' +
    '<p class="hint">Their taste profile (likes, dislikes, how they like to play) is theirs to fill in under My profile once they sign in.</p>' +
    '<label for="pfEmail">Google email <span style="font-weight:600;">(lets them sign in and rate games for themselves)</span></label><input type="email" id="pfEmail" value="' + esc(p.googleEmail || '') + '" placeholder="name@gmail.com">' +
    '<div class="modal-actions"><button type="button" class="btn ghost" id="playerBack">Back</button><button type="submit" class="btn primary" id="playerSave">Save</button></div>' +
  '</form>';
}
document.getElementById('openPlayersBtn').addEventListener('click', openPlayers);
document.getElementById('playersClose').addEventListener('click', () => playersModal.classList.remove('open'));
document.getElementById('playersBody').addEventListener('click', (e) => {
  const row = e.target.closest('[data-edit-player]');
  if (row) { editing = { ...adminPlayers.find(p => p.id === row.dataset.editPlayer) }; renderPlayers(); playersModal.querySelector('.modal').scrollTop = 0; return; }
  if (e.target.closest('#playerBack')) { editing = null; renderPlayers(); return; }
});
document.getElementById('playersBody').addEventListener('submit', async (e) => {
  if (e.target.id !== 'playerForm') return;
  e.preventDefault();
  const val = (id) => document.getElementById(id).value;
  const payload = { ...(editing.id ? { id: editing.id } : {}), name: val('pfName').trim(), aliases: val('pfAliases'),
    active: document.getElementById('pfActive').checked, googleEmail: val('pfEmail').trim(), bggUsername: val('pfBgg').trim() };
  const btn = document.getElementById('playerSave');
  btn.disabled = true;
  try {
    const r = await n8nFetch('/player-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const saved = r.player;
    const i = adminPlayers.findIndex(p => p.id === saved.id);
    const merged = { ...(i >= 0 ? adminPlayers[i] : { plays: 0, games: 0 }), ...saved };
    if (i >= 0) adminPlayers[i] = merged; else adminPlayers.unshift(merged);
    editing = null;
    renderPlayers();
    toast('Saved ' + saved.name + '.');
    loadPeople();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

// ---------- Ask ----------
let people = { players: [], ratings: {} };
async function loadPeople() {
  if (!isMember()) return;
  try { people = await n8nFetch('/people' + (currentShelf() !== 'main' ? '?shelf=' + encodeURIComponent(currentShelf()) : ''), { method: 'GET' }); } catch (e) { /* Ask still works without the roster */ }
  if (people && people.asks) { asks = people.asks; renderAskMeter(); }
  // Your own stars belong to your account: show them on any shelf, even where you're not in the people list
  if (people && people.ratings) {
    people.me = people.me || 'self';
    for (const [gid, stars] of Object.entries(people.mine || {})) {
      const byPlayer = (people.ratings[gid] ||= {});
      byPlayer[people.me] = { ...(byPlayer[people.me] || {}), stars: Number(stars) };
    }
  }
  renderAskPlayers();
  render(); // the cards' stars come with the people data
  if (detailId) renderDetail();
}
const askSelected = new Set(); // people at the table for this conversation
let askLast = null;   // { question, constraints, pickIds } for follow-ups
let askIds = null;    // when set, the grid shows only these games (in this order)
const firstName = (n) => String(n || '').split(' ')[0];
const panel = document.getElementById('nathanPanel');
const thread = document.getElementById('askThread');
const bar = document.getElementById('searchInput');
const npInput = document.getElementById('npInput');
let askBusy = false;
function renderAskPlayers() {
  const box = document.getElementById('askPlayers');
  const seated = people.players.filter(p => askSelected.has(p.id));
  box.parentElement.classList.toggle('empty', !seated.length);
  box.innerHTML = seated.length
    ? seated.map(p => '<button type="button" class="player-chip sel" data-ask-player="' + esc(p.id) + '" title="Remove ' + esc(p.name) + '">' + esc(p.name) + '<i class="ti ti-x x"></i></button>').join('')
    : '<span class="hint">Type @ to add the people you’re playing with.</span>';
}
document.getElementById('askPlayers').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-ask-player]');
  if (!chip) return;
  askSelected.delete(chip.dataset.askPlayer);
  renderAskPlayers();
});
// collapsed: the latest answer as an overview with "Chat more"; expanded: the whole conversation with a reply box
function setPanel(mode) {
  if (mode !== 'expanded' && panel.classList.contains('full')) {
    panel.classList.remove('full');
    const b = document.getElementById('npFull');
    b.innerHTML = '<i class="ti ti-arrows-maximize"></i>'; b.title = b.ariaLabel = 'Full screen';
  }
  panel.hidden = mode === 'hidden';
  if (mode === 'hidden') { document.body.classList.remove('chatting'); return; }
  panel.classList.toggle('collapsed', mode === 'collapsed');
  panel.classList.toggle('expanded', mode === 'expanded');
  document.body.classList.toggle('chatting', mode === 'expanded');
  const hide = document.getElementById('npHide');
  hide.innerHTML = mode === 'expanded' ? '<i class="ti ti-chevron-up"></i>' : '<i class="ti ti-x"></i>';
  hide.title = hide.ariaLabel = mode === 'expanded' ? 'Back to the overview' : 'Close';
  renderAskPlayers();
  refreshClamp();
}
function refreshClamp() {
  const collapsed = panel.classList.contains('collapsed');
  thread.classList.remove('clamped');
  const tall = collapsed && thread.scrollHeight > 25 * 16 + 40;
  thread.classList.toggle('clamped', tall);
  document.getElementById('npMore').hidden = !collapsed || !thread.children.length || askBusy;
}
document.getElementById('npMore').addEventListener('click', () => setPanel('expanded'));
// Full screen: the same conversation over the whole screen; the shelf behind stays where it was
const npFull = document.getElementById('npFull');
function setFull(on) {
  if (on) setPanel('expanded');
  panel.classList.toggle('full', on);
  npFull.innerHTML = '<i class="ti ti-arrows-' + (on ? 'minimize' : 'maximize') + '"></i>';
  npFull.title = npFull.ariaLabel = on ? 'Exit full screen' : 'Full screen';
  if (on) thread.scrollTop = thread.scrollHeight;
}
npFull.addEventListener('click', () => setFull(!panel.classList.contains('full')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('full') && !document.querySelector('.modal-overlay.open')) setFull(false); });
document.getElementById('npHide').addEventListener('click', () => {
  if (panel.classList.contains('expanded')) { setPanel('collapsed'); panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  else setPanel('hidden');
});
document.getElementById('npNew').addEventListener('click', () => {
  thread.innerHTML = '';
  askLast = null;
  newChat();
  askSelected.clear();
  nathanSets.length = 0;
  // In full screen a new chat stays full screen, ready for the first question
  if (panel.classList.contains('full')) { renderAskPlayers(); refreshClamp(); return; }
  setPanel('collapsed');
  bar.focus();
});

// @mentions on any input: "@" then part of a name opens a list of players; picking one writes their full name
function attachMentions(input, box, onSend) {
  let at = -1, opts = [], active = 0;
  const close = () => { box.hidden = true; at = -1; input.setAttribute('aria-expanded', 'false'); };
  const update = () => {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const i = before.lastIndexOf('@');
    if (i < 0 || (i > 0 && !/\s/.test(before[i - 1])) || !people.players.length) { close(); return; }
    const q = before.slice(i + 1).toLowerCase();
    if (q.length > 30 || /^\s/.test(q)) { close(); return; }
    const words = q.split(/\s+/).filter(Boolean);
    const matches = (p) => [p.name, ...(p.aliases || [])].map(n => String(n).toLowerCase())
      .some(n => n.startsWith(q) || words.every(w => n.split(/\s+/).some(part => part.startsWith(w))));
    opts = people.players.filter(p => !askSelected.has(p.id) && matches(p))
      .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 8);
    if (!opts.length) { close(); return; }
    at = i;
    active = Math.min(active, opts.length - 1);
    box.innerHTML = opts.map((p, k) => '<button type="button" class="mention-opt' + (k === active ? ' active' : '') + '" role="option" aria-selected="' + (k === active) + '" data-mention="' + k + '"><span class="at">@</span>' + esc(p.name) + '</button>').join('');
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const pick = (k) => {
    const p = opts[k];
    if (!p || at < 0) return;
    const caret = input.selectionStart ?? input.value.length;
    const tag = '@' + p.name + ' ';
    input.value = input.value.slice(0, at) + tag + input.value.slice(caret).replace(/^\s+/, '');
    const pos = at + tag.length;
    input.setSelectionRange(pos, pos);
    askSelected.add(p.id);
    close();
    renderAskPlayers();
    input.focus();
  };
  box.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  box.addEventListener('click', (e) => { const o = e.target.closest('[data-mention]'); if (o) pick(+o.dataset.mention); });
  input.addEventListener('input', () => { active = 0; update(); });
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!box.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        update();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(active); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    }
    if (e.key === 'Enter') { e.preventDefault(); onSend(); }
  });
  return close;
}
// The top bar starts a fresh question (like a new search); the reply box continues the conversation
const closeBarMentions = attachMentions(bar, document.getElementById('mentionList'), () => { if (!openShelfMatch()) askNathan(bar.value, false); });
const closeNpMentions = attachMentions(npInput, document.getElementById('npMentionList'), () => askNathan(npInput.value, true));
bar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && document.getElementById('mentionList').hidden) setPanel('hidden'); });
// An empty, focused bar offers a few ideas in a dropdown, like search suggestions: four drawn at random from
// this pool each time it opens, so the same seven don't greet every visit
const IDEA_POOL = [
  'What can four of us finish in under 30 minutes?',
  'What haven\u2019t we played in a really long time?',
  'Something cozy and cooperative for two of us tonight',
  'We have all evening. What big strategy game is worth pulling down?',
  'A party game for six that gets everyone laughing',
  'What are my top ten most played games?',
  'What sci-fi games do I have?',
  'Which games have I never played?',
  'What did we play most this year?',
  'A quick filler while we wait for the pizza',
  'Something I can teach to new players in five minutes',
  'What\u2019s good for three players?',
  'A heavy game for two that rewards planning',
  'Which games are best with exactly five?',
  'What are my highest-rated games I haven\u2019t played lately?',
  'Something with lots of dice rolling',
  'A game with trading or negotiation',
  'What fantasy games do I have?',
  'Something for a rainy afternoon with the kids',
  'A deck-building game I\u2019ve been neglecting',
  'What can seven or more of us play?',
  'A game that plays in under an hour but still feels meaty',
  'Which games have I rated five stars?',
  'What do my friends own that I don\u2019t?',
  'A cooperative game where we all win or lose together',
  'What tile-laying games are on the shelf?',
  'Something tense and competitive for two',
  'Which of my games are good for a date night?',
  'A game with a strong theme and a story to tell',
  'What should I play if I only have 15 minutes?',
  'What are my newest games I haven\u2019t tried yet?',
  'A word or trivia game for the family',
  'Something strategic but not too long for a weeknight',
  'What games do I own with a space or exploration theme?',
  'Which games would be good for a group of mixed ages?',
  'What haven\u2019t I rated yet?',
];
const ideas = document.getElementById('askExamples');
function drawIdeas() {
  const pool = IDEA_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  ideas.querySelectorAll('[data-example]').forEach(el => el.remove());
  pool.slice(0, 4).forEach(q => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mention-opt'; b.setAttribute('role', 'option'); b.dataset.example = q;
    b.innerHTML = '<span class="at"><i class="ti ti-sparkles"></i></span>' + esc(q);
    ideas.appendChild(b);
  });
}
const showIdeas = () => {
  const hide = !!bar.value.trim() || !document.getElementById('mentionList').hidden || document.activeElement !== bar;
  if (!hide && ideas.hidden) drawIdeas(); // a fresh four each time it opens
  ideas.hidden = hide;
};
bar.addEventListener('focus', showIdeas);
bar.addEventListener('input', showIdeas);
bar.addEventListener('blur', () => setTimeout(() => { ideas.hidden = true; }, 120));
bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') ideas.hidden = true; });
ideas.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus until the click lands
document.getElementById('askSend').addEventListener('click', () => askNathan(bar.value, false));
document.getElementById('npSend').addEventListener('click', () => askNathan(npInput.value, true));
document.getElementById('askExamples').addEventListener('click', (e) => {
  const ex = e.target.closest('[data-example]');
  if (ex) { ideas.hidden = true; askNathan(ex.dataset.example, false); }
});

// Typing a game's name finds it on the shelf right away, no question spent. The list shows the matches and
// "Ask Nathan" last; Enter takes the highlighted row: the game when the name is (nearly) all typed out, else Nathan.
const finds = document.getElementById('shelfMatches');
const plain = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
let found = [], foundActive = -1;
function showFinds() {
  const q = plain(bar.value);
  found = [];
  if (q.length >= 2 && !pendingPhoto && !bar.value.includes('@') && q.split(' ').length <= 6) {
    const words = q.split(' ');
    const score = (g) => {
      const t = plain(g.title);
      if (t === q) return 4;
      if (t.startsWith(q)) return 3;
      if (t.split(' ').some((w, i, all) => all.slice(i).join(' ').startsWith(q))) return 2;
      return words.every((w) => t.split(' ').some((p) => p.startsWith(w))) ? 1 : 0;
    };
    found = collection.map((g) => ({ g, s: score(g) })).filter((x) => x.s)
      .sort((a, b) => b.s - a.s || a.g.title.length - b.g.title.length).slice(0, 5).map((x) => x.g);
  }
  if (!found.length || document.activeElement !== bar || !document.getElementById('mentionList').hidden) { finds.hidden = true; foundActive = -1; return; }
  // The game is the default when it's the only match and most of its name is typed, or the name matches exactly
  const t0 = plain(found[0].title);
  foundActive = t0 === q || (found.length === 1 && q.length >= Math.min(4, t0.length) && q.length >= t0.length * 0.5) ? 0 : found.length;
  drawFinds();
}
function drawFinds() {
  finds.innerHTML = '<div class="suggest-head">' + (viewingFriend() ? 'On this shelf' : 'On your shelf') + '</div>' +
    found.map((g, k) => '<button type="button" class="mention-opt shelf-opt' + (k === foundActive ? ' active' : '') + '" role="option" aria-selected="' + (k === foundActive) + '" data-find="' + k + '">' +
      (g.coverCard ? '<img src="' + esc(g.coverCard) + '" alt="" loading="lazy">' : '<span class="at"><i class="ti ti-' + esc(g.icon || DEFAULT_ICON) + '"></i></span>') + esc(g.title) + '</button>').join('') +
    '<button type="button" class="mention-opt shelf-opt' + (foundActive === found.length ? ' active' : '') + '" role="option" data-find="ask"><span class="at"><i class="ti ti-message-circle"></i></span><span class="ask-row">Ask Nathan “' + esc(bar.value.trim()) + '”</span></button>';
  finds.hidden = false;
}
function openShelfMatch(k = foundActive) {
  if (finds.hidden || !found[k]) return false;
  const g = found[k];
  finds.hidden = true;
  bar.value = '';
  document.getElementById('searchClear').hidden = true;
  bar.blur();
  openDetail(g.id);
  return true;
}
bar.addEventListener('input', showFinds);
bar.addEventListener('focus', showFinds);
bar.addEventListener('blur', () => setTimeout(() => { finds.hidden = true; }, 120));
bar.addEventListener('keydown', (e) => {
  if (finds.hidden || !document.getElementById('mentionList').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    foundActive = (Math.max(foundActive, 0) + (e.key === 'ArrowDown' ? 1 : -1) + found.length + 1) % (found.length + 1);
    drawFinds();
  } else if (e.key === 'Escape') finds.hidden = true;
});
finds.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus until the click lands
finds.addEventListener('click', (e) => {
  const o = e.target.closest('[data-find]');
  if (!o) return;
  if (o.dataset.find === 'ask') { finds.hidden = true; askNathan(bar.value, false); }
  else openShelfMatch(+o.dataset.find);
});

// Titles Nathan already joked about this session (he quips on a game's first mention only)
const SS_JOKED = 'vault_nathan_joked';
const joked = new Set((() => { try { return JSON.parse(sessionStorage.getItem(SS_JOKED) || '[]'); } catch (e) { return []; } })());
const rememberJoked = (ids) => { ids.forEach(id => joked.add(id)); try { sessionStorage.setItem(SS_JOKED, JSON.stringify([...joked])); } catch (e) {} };
// The conversation: each one is saved on the server so Nathan can look back over it. A question from the top bar
// or "New chat" starts another; a refresh starts clean.
let chatKey = '';
const newChat = () => { chatKey = window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); };
// Games Nathan recommended in the last two weeks, so asking again brings something fresh
const LS_RECENT = 'vault_nathan_recent';
const recentPicks = () => { try { const cut = Date.now() - 14 * 86400000; return (JSON.parse(localStorage.getItem(LS_RECENT) || '[]') || []).filter((x) => x && x.t > cut); } catch (e) { return []; } };
const rememberPicks = (ids) => {
  const kept = recentPicks().filter((x) => !ids.includes(x.id));
  try { localStorage.setItem(LS_RECENT, JSON.stringify([...ids.map((id) => ({ id, t: Date.now() })), ...kept].slice(0, 40))); } catch (e) {}
};

// Spec chips come from our own (BGG-sourced) data, never from the model
function specChips(g) {
  const chips = [];
  const best = bestText(g);
  if (best) chips.push('<span class="fact" title="BGG community player-count poll"><i class="ti ti-users"></i>best at ' + best + '</span>');
  else if (playersText(g)) chips.push('<span class="fact"><i class="ti ti-users"></i>' + playersText(g) + '</span>');
  if (timeText(g)) chips.push('<span class="fact"><i class="ti ti-clock"></i>' + timeText(g) + '</span>');
  if (g.weight) chips.push('<span class="fact ' + weightClass(g.weight) + '" title="BGG weight (1 light to 5 heavy)"><i class="ti ti-weight"></i>' + Number(g.weight).toFixed(1) + '</span>');
  (g.mechanics || []).slice(0, 2).forEach(m => chips.push('<span class="tag tag-plain">' + esc(m) + '</span>'));
  return chips.length ? '<div class="n-specs">' + chips.join('') + '</div>' : '';
}
function nathanCard(x, kind) {
  if (!x) return '';
  if (x.off) {
    // A game that isn't on their shelf: its BGG page, and which friends have it
    const o = x.off;
    const who = (o.friends || []).length ? ' · ' + o.friends.join(' & ') + (o.friends.length === 1 ? ' has it' : ' have it') : '';
    return '<div class="n-card ' + kind + '">' +
      '<a class="n-top" href="https://boardgamegeek.com/boardgame/' + Number(o.bggId) + '" target="_blank" rel="noopener">' +
        (o.cover ? '<img src="' + esc(o.cover) + '" alt="" loading="lazy">' : '<div class="game-icon"><i class="ti ti-' + esc(DEFAULT_ICON) + '"></i></div>') +
        '<div><div class="n-kind">Not on your shelf' + esc(who) + '</div><div class="n-title">' + esc(x.title || o.title || '') + ' <i class="ti ti-external-link" style="font-size:0.8em;"></i></div>' +
        (x.quip ? '<div class="n-quip">' + esc(x.quip) + '</div>' : '') + '</div></a>' +
      (x.why ? '<div class="n-why">' + esc(x.why) + '</div>' : '') +
      '<button type="button" class="btn ghost n-wish" data-wish-add="' + Number(o.bggId) + '" data-title="' + esc(x.title || o.title || '') + '" data-cover="' + esc(o.cover || '') + '"><i class="ti ti-gift"></i> Add to my wishlist</button>' +
    '</div>';
  }
  const g = collection.find(y => y.id === x.id) || {};
  const img = g.coverCard ? '<img src="' + esc(g.coverCard) + '" alt="" loading="lazy">' : '<div class="game-icon"><i class="ti ti-' + esc(g.icon || DEFAULT_ICON) + '"></i></div>';
  const label = { headline: 'Tonight’s pick', alternative: 'Or, for something different', avoid: 'Maybe not tonight', highlight: 'On your shelf' }[kind];
  return '<div class="n-card ' + kind + '">' +
    '<div class="n-top" data-ask-open="' + esc(x.id) + '" role="button" tabindex="0">' + img +
      '<div><div class="n-kind">' + label + '</div><div class="n-title">' + esc(x.title || g.title || '') + '</div>' +
      (x.quip ? '<div class="n-quip">' + esc(x.quip) + '</div>' : '') + '</div></div>' +
    (kind !== 'avoid' && kind !== 'highlight' ? specChips(g) : '') +
    (x.why ? '<div class="n-why">' + esc(x.why) + '</div>' : '') +
    (x.tableFeel ? '<div class="n-feel"><b>At the table</b>' + esc(x.tableFeel) + '</div>' : '') +
    (x.swapJoke ? '<div class="n-swap">' + esc(x.swapJoke) + '</div>' : '') +
  '</div>';
}
function understoodHtml(u) {
  if (!u) return '';
  const bits = [];
  if (u.players && u.players.length) bits.push('<i class="ti ti-users"></i>' + esc(u.players.map(firstName).join(', ')));
  if (u.playerCount) bits.push(u.playerCount + (u.playerCount === 1 ? ' player' : ' players'));
  if (u.kids && !u.youngestAge) bits.push('with kids');
  if (u.maxMinutes) bits.push('≤ ' + u.maxMinutes + ' min');
  if (u.youngestAge) bits.push('ages ' + u.youngestAge + '+');
  if (u.coop === true) bits.push('co-op');
  if (u.coop === false) bits.push('competitive');
  if (u.freshness === 'stale') bits.push('not played lately');
  if (u.freshness === 'unplayed') bits.push('never played');
  if (u.mood) bits.push(esc(u.mood));
  return bits.length ? '<div class="ask-understood">' + bits.map(b => '<span class="fact">' + b + '</span>').join('') + '</div>' : '';
}
function rulesLinks(r) {
  if (r.mode !== 'rules') return '';
  const pdfAt = (src, page) => src && /\.pdf(\?|#|$)/i.test(src) ? src.replace(/#.*$/, '') + '#page=' + Number(page) : src;
  const used = (r.sources || []).map(x => x.source
    ? '<a href="' + esc(pdfAt(x.source, x.page)) + '" target="_blank" rel="noopener"><i class="ti ti-book"></i> ' + esc(x.label) + ', p. ' + Number(x.page) + '</a>'
    : '<span><i class="ti ti-book"></i> ' + esc(x.label) + ', p. ' + Number(x.page) + '</span>').join('');
  const none = (r.rulebooks || []).filter(b => !b.has).map(b => '<a href="https://boardgamegeek.com/boardgame/' + Number(b.bggId) + '/files" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Find the ' + esc(b.title) + ' rulebook on BGG</a>').join('');
  return used || none ? '<div class="n-sources">' + used + none + '</div>' : '';
}
function nathanAnswerHtml(r) {
  if (r.offTopic || (!r.pick && !(r.highlights || []).length && !r.summary)) return '<p class="ask-note" style="margin:0;">' + esc(r.note || (r.gap && r.gap.missing) || 'Nathan came up empty on that one.') + '</p>';
  const gap = r.gap ? '<div class="n-gap">' + esc(r.gap.missing) +
    (r.gap.consider ? ' Not on your shelf, but worth a look: <a href="https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=' + encodeURIComponent(r.gap.consider) + '" target="_blank" rel="noopener">' + esc(r.gap.consider) + '</a>.' : '') + '</div>' : '';
  const n = (r.matchIds || []).length;
  let seeAll = '';
  // An answer about your own shelf ("my top ten" asked from someone else's) opens your shelf
  const answerShelf = r.visitShelf || (r.fromOwn ? (isOwner() ? 'main' : 'mine') : currentShelf());
  const spansFriends = String((r.matchIds || [])[0] || '').startsWith('bgg:'); // games from several friends' shelves: no single shelf to filter
  if (n && !spansFriends && (r.fromOwn || r.visitShelf || n < collection.length) && (n > 1 || r.intent === 'browse')) {
    nathanSets.push({ ids: orderedIds(r), shelf: answerShelf });
    seeAll = '<button type="button" class="n-seeall" data-see-all="' + (nathanSets.length - 1) + '"><i class="ti ti-layout-grid"></i> ' + (n === 1 ? 'See it in the library' : 'See all ' + n + ' games') + '</button>';
  }
  // What Nathan understood and the "See all" button share the first row, so the filter is one click away without opening the chat
  const top = (r.intent === 'browse' ? '' : understoodHtml(r.understood)) + seeAll;
  const head = top ? '<div class="n-toprow">' + top + '</div>' : '';
  const body = r.intent === 'browse'
    ? head + '<p class="n-summary' + (r.mode === 'rules' ? ' rules' : '') + '">' + esc(r.summary || '') + '</p>' + rulesLinks(r) + gap + (r.mode === 'rules' ? '' : (r.highlights || []).map(h => nathanCard(h, 'highlight')).join(''))
    : head + gap + nathanCard(r.pick, 'headline') + nathanCard(r.alternative, 'alternative') + nathanCard(r.avoid, 'avoid');
  const memo = (r.remembered || []).length ? '<p class="n-memo"><span><i class="ti ti-notebook"></i> I’ll remember: ' + r.remembered.map(esc).join('; ') + '.</span>' +
    '<button type="button" class="linklike" data-open-memory>What I remember</button></p>' : '';
  // The one thing he'd like to know for a sharper pick next time ("How old are your kids?"); reply in the box below
  const ask = r.ask ? '<p class="n-ask"><i class="ti ti-message-question"></i> ' + esc(r.ask) + '</p>' : '';
  return body + (r.signoff ? '<div class="n-sign">' + (r.intent === 'browse' ? '' : 'And that’s what’s hitting the table!') + '<span>' + esc(r.signoff) + '</span></div>' : '') + ask + memo;
}
// The question as a bubble, with each @Full Name highlighted
function bubbleHtml(q) {
  let out = esc(q);
  const names = people.players.map(p => p.name).sort((a, b) => b.length - a.length);
  for (const n of names) out = out.split('@' + esc(n)).join('<span class="mention">@' + esc(n) + '</span>');
  return out;
}
// The full set behind each answer: a browse keeps Nathan's order (e.g. most played first), a recommendation puts his picks first
const nathanSets = [];
function orderedIds(r) {
  const ids = r.matchIds || [];
  if (r.intent === 'browse') return ids;
  const first = (r.pickIds || []).filter(id => ids.includes(id));
  return [...first, ...ids.filter(id => !first.includes(id))];
}
// ---------- Nathan's daily allowance ----------
let asks = null; // { limit, left } for the signed-in member, from the people data
function renderAskMeter() {
  const m = document.getElementById('askMeter');
  if (!asks || !isMember()) { m.hidden = true; return; }
  const left = Math.max(0, asks.left);
  m.hidden = false;
  m.className = 'ask-meter' + (left === 0 ? ' out' : left <= 5 ? ' low' : '');
  m.innerHTML = '<i class="ti ti-message-dots"></i>' + (left === 0
    ? 'No questions left today · Nathan’s back after midnight'
    : left + ' of ' + asks.limit + ' question' + (asks.limit === 1 ? '' : 's') + ' left today');
  const out = left === 0;
  for (const el of [bar, npInput]) {
    el.disabled = out;
    el.placeholder = out ? 'Nathan’s back tomorrow' : el === bar ? 'Ask Nathan about your shelf… (@ to add people)' : 'Reply to Nathan… (@ to add people)';
  }
  document.getElementById('askSend').disabled = out;
  document.getElementById('npSend').disabled = out;
}
// What Nathan is up to while he thinks: matched to the question, rotating every couple of seconds
function thinkingLines(q, names) {
  const t = String(q || '').toLowerCase();
  const forWho = names.length ? ' for ' + names.join(', ') : '';
  const pick = (...sets) => sets.find(([re]) => re.test(t)) || sets[sets.length - 1];
  const [, lines] = pick(
    [/\b(who (has|owns)|anyone|any of my friends|lend|at [a-z]+'s|at [a-z]+’s|friends?'? shelves?)\b/, [
      'Peeking at your friends’ shelves…', 'Checking who has it (no snooping, promise)…', 'Texting the group chat…', 'Counting meeples at your friends’ places…']],
    [/\b(rules?|how (do|does|to) (i |you |we )?(play|set ?up|score|win)|set ?up|setup|on (someone else'?s|someone else’s|my|your|their) turn|allowed to|is it legal|how many (cards|dice|actions|turns)|what happens (if|when))\b/, [
      'Flipping to the rulebook…', 'Squinting at the tiny print in the rulebook…', 'Checking the FAQ (there’s always an FAQ)…', 'Settling a rules argument before it starts…', 'Finding the page someone always loses…']],
    [/\b(buy|purchase|get next|add to my (collection|shelf)|wishlist|(don'?t|don’t|do not) (own|have)|new game)\b/, [
      'Browsing the game store aisles…', 'Sniffing new shrink wrap…', 'Checking what isn’t on your shelf yet…', 'Weighing it against your shelf space…', 'Asking my wallet if it’s okay…']],
    [/\b(what do you (like|love|play)|your favou?rite|about yourself|nathan)\b/, [
      'Thinking about my favorites…', 'Picking my all-time favorite (this is hard)…', 'Dusting off my own shelf…']],
    [/\b(what (do|does) .+ like|about me|know about|who wins|win rate|how (do|does) .+ do at|profile)\b/, [
      'Reading the play logs…', 'Tallying the wins and losses…', 'Checking who rage-quit last time…', 'Looking through the scoresheets…']],
    [/\b(shelf of shame|never played|haven'?t played|haven’t played|unplayed)\b/, [
      'Blowing the dust off the shelf of shame…', 'Finding the games still in shrink wrap…', 'Judging nobody (okay, a little)…', 'Peeking under the pile of unplayed games…']],
    [/\b(top ?\d+|top (ten|five|three)|most played|least played|highest rated|heaviest|lightest|longest|list|show me|which of (those|these)|shelf of shame|haven'?t played|how many)\b/, [
      'Counting plays and sharpening my pencil…', 'Lining up the boxes in order…', 'Doing some very serious math…', 'Alphabetizing the chaos…', 'Blowing the dust off the shelf of shame…']],
    [/\b(genre|weight|how long|is .+ good|would i like|what is|what's|tell me about|like .+\?)\b/, [
      'Looking it up on BoardGameGeek…', 'Reading the back of the box…', 'Checking the community poll…', 'Weighing the box (scientifically)…']],
    [/./, [
      'Checking the shelves' + forWho + '…', 'Pulling boxes off the shelf' + forWho + '…', 'Shuffling through the options…', 'Rolling for initiative…',
      'Consulting the meeples…', 'Sorting out who sits where…', 'Making sure nobody gets a game they hate…']]);
  return lines;
}
function startThinking(el, q, names) {
  const lines = thinkingLines(q, names);
  let i = Math.floor(Math.random() * lines.length);
  const show = () => { el.textContent = lines[i % lines.length]; i++; };
  show();
  const timer = setInterval(show, 2400);
  return () => clearInterval(timer);
}
let pendingPhoto = null; // a photo going with the next question (never stored)
// A photo for Nathan as a small JPEG data URL (shrinkPhoto, above, makes the Blob for "Add by photo"); turned the right
// way up from its EXIF tag, or as it comes when the browser can't do that
async function photoToDataUrl(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
function renderPhotoChips() {
  for (const id of ['barPhotoChip', 'npPhotoChip']) {
    const chip = document.getElementById(id);
    chip.hidden = !pendingPhoto;
    if (pendingPhoto) chip.querySelector('img').src = pendingPhoto;
  }
}
document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-photo-input]');
  if (!input) return;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try { pendingPhoto = await photoToDataUrl(file); }
  catch (err) { toast('That photo couldn’t be opened. Try a JPEG or PNG.', true); return; }
  renderPhotoChips();
  const box = input.dataset.photoInput === 'bar' ? bar : npInput;
  if (!box.value.trim()) box.placeholder = 'Ask about the photo, e.g. "what does this icon mean?"';
});
document.addEventListener('click', (e) => { if (e.target.closest('[data-photo-remove]')) { pendingPhoto = null; renderPhotoChips(); } });
// Nathan from the new service, streamed: his words appear as he writes them, with a Stop button.
// Returns null when the service can't be reached or is down before it starts, so the question goes to n8n instead.
let askStop = null, retryAsk = null;
const STOP_BTN = '<button type="button" class="n-stop" data-ask-stop><i class="ti ti-filled ti-player-stop-filled"></i> Stop</button>';
async function askViaApi(payload, turn) {
  const ctl = new AbortController();
  askStop = ctl;
  const body = turn.querySelector('.np-body');
  body.querySelector('.ask-thinking').insertAdjacentHTML('beforeend', STOP_BTN);
  let words = false, done = null;
  const cut = (stopped) => Object.assign(new Error(stopped ? 'Stopped' : 'Lost'), { stopped, partial: words });
  try {
    let res;
    try {
      res = await fetch(API + '/ask/stream', { method: 'POST', signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + await ensureToken(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) { if (ctl.signal.aborted) throw cut(true); return null; }
    if (res.status === 401) throw handleUnauthorized();
    if (res.status >= 500 || !res.body) return null;
    if (!res.ok) { let m = ''; try { m = (await res.json()).message || ''; } catch (e) {} throw new Error('n8n request failed (' + res.status + ') ' + m); }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: ?(.*)$/m) || [])[1], data = (block.match(/^data: ?(.*)$/m) || [])[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === 'partial') {
            const r = d.summary !== undefined ? { intent: 'browse', summary: d.summary, highlights: d.highlights } : { intent: 'recommend', pick: d.pick, alternative: d.alternative };
            if (!(r.summary || (r.highlights || []).length || r.pick)) continue;
            words = true;
            body.innerHTML = nathanAnswerHtml(r) + '<div class="ask-thinking n-writing"><div class="spinner"></div><span>Nathan is writing…</span>' + STOP_BTN + '</div>';
            refreshClamp();
          } else if (ev === 'done') done = d;
          else if (ev === 'error') throw new Error('n8n request failed (' + d.status + ') ' + d.message);
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) throw cut(true);
      if (/^n8n request failed/.test(e.message) && !words) throw e;
      throw cut(false);
    }
    if (!done) throw cut(ctl.signal.aborted);
    return done;
  } finally { askStop = null; }
}
// A reply scrolls up to the top of the chat (the page, or the thread in full screen) so the answer has room to arrive below it.
// Near the end there may be nothing below to scroll into, so Nathan's turn holds open the rest of the view until the next question.
function questionToTop(mine, turn) {
  thread.querySelectorAll('.np-turn.nathan').forEach((t) => { if (t !== turn) t.style.minHeight = ''; });
  const full = panel.classList.contains('full');
  const top = mine.getBoundingClientRect().top;
  const below = full ? thread.scrollHeight - (top - thread.getBoundingClientRect().top + thread.scrollTop) : document.documentElement.scrollHeight - (top + window.scrollY);
  const short = (full ? thread.clientHeight : window.innerHeight) - 16 - below;
  if (short > 0) turn.style.minHeight = (turn.offsetHeight + short) + 'px';
  mine.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function askNathan(text, followUp) {
  if (asks && asks.left <= 0) { renderAskMeter(); return; }
  const photo = pendingPhoto;
  const question = String(text || '').trim() || (photo ? 'What is this?' : '');
  const input = followUp ? npInput : bar;
  if (question.length < 3) { input.focus(); return; }
  if (askBusy) return;
  retryAsk = { text: question, followUp, photo };
  // Anyone written out in full as @Name counts, even if they weren't picked from the list
  for (const p of people.players) if (question.toLowerCase().includes('@' + p.name.toLowerCase())) askSelected.add(p.id);
  askBusy = true;
  closeBarMentions(); closeNpMentions();
  input.value = '';
  input.blur(); // put the phone keyboard away while Nathan answers
  if (!followUp) {
    // A new question from the top bar is a fresh overview, like a new search (and a new chat)
    thread.innerHTML = '';
    askLast = null;
    newChat();
  }
  setPanel(followUp ? 'expanded' : 'collapsed');
  thread.insertAdjacentHTML('beforeend', '<div class="np-turn me"><div class="np-bubble">' + (photo ? '<img class="np-photo" src="' + photo + '" alt="Your photo">' : '') + bubbleHtml(question) + '</div></div>');
  const mine = thread.lastElementChild;
  pendingPhoto = null; renderPhotoChips();
  bar.placeholder = 'Ask Nathan about your shelf… (@ to add people)'; npInput.placeholder = 'Reply to Nathan… (@ to add people)';
  const names = people.players.filter(p => askSelected.has(p.id)).map(p => firstName(p.name));
  const turn = document.createElement('div');
  turn.className = 'np-turn nathan';
  turn.innerHTML = '<div class="nathan-avatar sm" aria-hidden="true"></div><div class="np-body"><div class="ask-thinking" style="margin:0.4rem 0 0;"><div class="spinner"></div><span class="think-line"></span></div></div>';
  thread.appendChild(turn);
  const stopThinking = startThinking(turn.querySelector('.think-line'), question, names);
  refreshClamp();
  if (followUp) questionToTop(mine, turn);
  else panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const payload = { question, playerIds: [...askSelected], previous: askLast, mentioned: [...joked], recent: recentPicks().map((x) => x.id), chatKey, image: photo, shelf: currentShelf() };
    const r = (await useNathanApi() && await askViaApi(payload, turn))
      || await n8nFetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
    if (r.chatKey) chatKey = r.chatKey;
    if (r.pick || (r.highlights || []).length) {
      // The whole answer (all ten of a top ten), so "which of those…" narrows it instead of starting over
      askLast = { question, constraints: r.constraints, pickIds: r.pickIds, setIds: (r.matchIds && r.matchIds.length ? r.matchIds : r.pickIds || []).slice(0, 60), fromOwn: !!r.fromOwn };
      rememberJoked(r.pickIds || []);
      if (r.intent !== 'browse') rememberPicks(r.pickIds || []);
    }
    turn.querySelector('.np-body').innerHTML = nathanAnswerHtml(r);
    // Thumbs under the reply; the turn remembers which reply it is (the chat and the question) for the vote
    if (chatKey) { turn.dataset.voteChat = chatKey; turn.dataset.voteQ = question; turn.querySelector('.np-body').insertAdjacentHTML('beforeend', voteBarHtml()); }
    if (asks) { asks.left = Math.max(0, asks.left - 1); renderAskMeter(); }
  } catch (err) {
    if (err.stopped !== undefined) {
      // Stopped, or the connection dropped while he wrote: keep what he wrote so far, and offer to ask again
      const b = turn.querySelector('.np-body');
      if (!err.partial) b.innerHTML = '';
      b.querySelectorAll('.ask-thinking').forEach((x) => x.remove());
      b.insertAdjacentHTML('beforeend', '<p class="ask-note n-cut">' + (err.stopped ? 'You stopped Nathan' + (err.partial ? ' partway.' : '.') : 'Nathan lost his train of thought.') +
        ' <button type="button" class="linklike" data-ask-retry>Ask again</button></p>');
      return;
    }
    const raw = String(err.message || '');
    // The AI service busy or down: say so kindly instead of showing the raw error
    const busy = /too many requests|rate.?limit|overloaded|temporarily|\((5\d\d)\)/i.test(raw) && !/questions for today/i.test(raw);
    const msg = busy ? 'Nathan’s a little swamped at the shelves right now. Give him a moment and ask again!' : raw.replace(/^n8n request failed \(\d+\) /, '');
    if (/\(429\)/.test(String(err.message)) && asks) { asks.left = 0; renderAskMeter(); }
    turn.querySelector('.np-body').innerHTML = '<p class="ask-note" style="margin:0;">' + esc(msg || 'Nathan couldn’t answer that one. Try again in a moment.') + '</p>';
  } finally {
    stopThinking();
    askBusy = false;
    refreshClamp();
  }
}
// ---------- Thumbs on Nathan's replies ----------
// A thumb alone is only counted (Admin → Nathan sees kinds of questions, never the words); a note goes to Dan with the
// question and Nathan's answer. The other thumb changes the vote; the same thumb again clears it.
function voteBarHtml() {
  return '<div class="n-vote"><span class="n-vote-ask">Was this helpful?</span>' +
    '<button type="button" class="n-thumb" data-vote="up" title="Good reply" aria-label="Good reply" aria-pressed="false"><i class="ti ti-thumb-up"></i></button>' +
    '<button type="button" class="n-thumb" data-vote="down" title="Not helpful" aria-label="Not helpful" aria-pressed="false"><i class="ti ti-thumb-down"></i></button></div>';
}
function sendVote(box, vote, note) {
  const t = box.closest('.np-turn');
  return n8nFetch('/ask-vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatKey: t.dataset.voteChat, question: t.dataset.voteQ, vote, note: note || '' }) });
}
async function voteReply(btn) {
  const box = btn.closest('.n-vote');
  if (box.classList.contains('busy')) return;
  const vote = (box.dataset.vote || '') === btn.dataset.vote ? '' : btn.dataset.vote;
  box.classList.add('busy');
  try {
    await sendVote(box, vote);
    box.dataset.vote = vote;
    box.querySelectorAll('.n-thumb').forEach((b) => {
      const on = b.dataset.vote === vote;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    box.querySelector('.n-vote-ask').textContent = vote ? 'Thanks!' : 'Was this helpful?';
    const more = box.querySelector('.n-vote-more');
    if (!vote) { if (more) more.remove(); return; }
    if (!more) box.insertAdjacentHTML('beforeend', '<div class="n-vote-more"><input type="text" maxlength="1000" placeholder="Anything to add? (optional)" aria-label="A note for Dan">' +
      '<button type="button" class="btn small" data-vote-send>Send</button><p class="hint">A note goes to Dan with your question and Nathan’s answer. A thumb alone is only counted.</p></div>');
  } catch (err) { toast(err.message, true); }
  finally { box.classList.remove('busy'); }
}
async function sendVoteNote(box) {
  const input = box.querySelector('.n-vote-more input'), btn = box.querySelector('[data-vote-send]');
  const note = input.value.trim();
  if (!note) { input.focus(); return; }
  btn.disabled = true; input.disabled = true;
  try { await sendVote(box, box.dataset.vote, note); box.querySelector('.n-vote-more').innerHTML = '<p class="hint">Sent. Dan reads every one.</p>'; }
  catch (err) { toast(err.message, true); btn.disabled = false; input.disabled = false; }
}
thread.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.n-vote-more input')) { e.preventDefault(); sendVoteNote(e.target.closest('.n-vote')); }
});
thread.addEventListener('click', (e) => {
  if (e.target.closest('[data-ask-stop]')) { if (askStop) askStop.abort(); return; }
  if (e.target.closest('[data-ask-retry]') && retryAsk && !askBusy) { pendingPhoto = retryAsk.photo; askNathan(retryAsk.text, retryAsk.followUp); return; }
  const thumb = e.target.closest('[data-vote]');
  if (thumb) { voteReply(thumb); return; }
  if (e.target.closest('[data-vote-send]')) { sendVoteNote(e.target.closest('.n-vote')); return; }
  const open = e.target.closest('[data-ask-open]');
  if (open) { openDetail(open.dataset.askOpen); return; }
  const see = e.target.closest('[data-see-all]');
  if (see) {
    if (panel.classList.contains('full')) setFull(false); // the games are on the shelf behind
    const set = nathanSets[+see.dataset.seeAll] || null;
    const ids = set ? set.ids : null;
    if (set && set.shelf !== currentShelf()) { setShelfView(set.shelf).then(() => { askIds = ids; render(); }); return; }
    askIds = ids;
    render();
    document.querySelector('.filters-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
thread.addEventListener('keydown', (e) => {
  const b = e.target.closest('[data-ask-open]');
  if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); b.click(); }
});

// Signed in: your name opens a small menu (My profile, Sign out)
const accountMenu = document.getElementById('accountMenu');
const setMenu = (open) => { accountMenu.hidden = !open; document.getElementById('authBtn').setAttribute('aria-expanded', String(open)); };
document.getElementById('authBtn').addEventListener('click', (e) => {
  if (!signedIn()) { quickSignIn(); return; }
  e.stopPropagation();
  document.getElementById('menuProfile').hidden = !isMember();
  setMenu(accountMenu.hidden);
});
document.addEventListener('click', (e) => { if (!accountMenu.hidden && !e.target.closest('.account')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); ['profileModal', 'tipModal', 'friendsModal', 'wishModal', 'pageModal', 'newsModal', 'settingsModal'].forEach(id => document.getElementById(id).classList.remove('open')); } });
document.getElementById('menuSignOut').addEventListener('click', () => {
  setMenu(false);
  if (gisReady) google.accounts.id.disableAutoSelect();
  clearTimeout(cacheTimer);
  try { localStorage.removeItem(LS_ROLE); localStorage.removeItem(LS_CACHE); } catch (e) {}
  setToken(null);
  collection = []; people = { players: [], ratings: {} };
  render();
  window.scrollTo(0, 0);
});

// ---------- My profile ----------
const profileModal = document.getElementById('profileModal');
let myProfile = null;
document.getElementById('menuProfile').addEventListener('click', async () => {
  setMenu(false);
  profileModal.classList.add('open');
  const body = document.getElementById('profileBody');
  body.innerHTML = '<div class="spinner"></div>';
  try {
    myProfile = (await n8nFetch('/me', { method: 'GET' })).profile;
    renderProfile();
  } catch (e) {
    body.innerHTML = '<p class="hint">' + esc(e.message) + '</p><div class="modal-actions"><button type="button" class="btn ghost" data-profile-close>Close</button></div>';
  }
});
function renderProfile() {
  const body = document.getElementById('profileBody');
  const pic = profile && profile.picture ? '<img src="' + esc(profile.picture) + '" alt="" referrerpolicy="no-referrer">' : '<span class="ph"><i class="ti ti-user"></i></span>';
  if (!myProfile) {
    body.innerHTML = '<div class="me-head">' + pic + '<div><h2>My profile</h2></div></div>' +
      '<p class="hint">Your Google account isn’t linked to a player card yet. Ask Dan to add your email, then come back here.</p>' +
      '<div class="modal-actions"><button type="button" class="btn ghost" data-profile-close>Close</button></div>';
    return;
  }
  const p = myProfile;
  const dial = (d) => '<div class="dial"><div class="dl"><span>' + d.lo + '</span><b>' + d.label + '</b><span>' + d.hi + '</span></div><div class="db">' +
    [1, 2, 3, 4, 5].map(v => '<button type="button" class="' + (p[d.key] === v ? 'on' : '') + '" data-me-dial="' + d.key + '" data-v="' + v + '">' + v + '</button>').join('') + '</div></div>';
  body.innerHTML = '<form class="pl-form" id="profileForm">' +
    '<div class="me-head">' + pic + '<div><h2>' + esc(p.name || 'My profile') + '</h2><p class="hint">In your own words. Nathan reads this when you’re at the table, and your friends will see it.</p></div></div>' +
    '<div class="section-label" style="margin-top:0.8rem;">How I like to play</div>' +
    '<p class="hint" style="margin-top:0;">Tap a number; tap it again to leave it unset.</p>' +
    DIALS.map(dial).join('') +
    '<div class="pl-two"><div><label for="meLikes">I like</label><textarea id="meLikes" rows="2" maxlength="600" placeholder="engine builders, anything with animals, co-ops">' + esc(p.likes || '') + '</textarea></div>' +
    '<div><label for="meDislikes">Not for me</label><textarea id="meDislikes" rows="2" maxlength="600" placeholder="trivia, take-that, 3-hour rules explanations">' + esc(p.dislikes || '') + '</textarea></div></div>' +
    '<div class="section-label" style="margin-top:1rem;">My Top 10 games of all time</div>' +
    '<p class="hint" style="margin-top:0;">Best first. Any game counts, owned or not. Your friends see this on your profile, and Nathan uses it.</p>' +
    '<div class="wl-list" id="topList"></div>' +
    '<div class="top-search"><input type="text" id="topQuery" placeholder="Add a game, e.g. Brass: Birmingham" autocomplete="off"><button type="button" class="btn" id="topFind"><i class="ti ti-search"></i></button></div>' +
    '<div class="wl-list" id="topResults"></div>' +
    '<label for="meNotes">About me <span style="font-weight:600;">(favorite games, what I’d recommend, anything Nathan should know)</span></label><textarea id="meNotes" rows="3" maxlength="600">' + esc(p.notes || '') + '</textarea>' +
    '<div class="section-label" style="margin-top:1rem;" id="memLabel">What Nathan remembers about me</div>' +
    '<p class="hint" style="margin-top:0;">Nathan picks these up when you tell him about yourself, and uses them in every answer. Only you can see them. Remove anything that’s wrong.</p>' +
    '<div class="wl-list" id="memList"><div class="spinner"></div></div>' +
    '<div class="pl-two"><div><label for="meBgg">BGG username <span style="font-weight:600;">(optional)</span></label><input type="text" id="meBgg" maxlength="60" value="' + esc(p.bggUsername || '') + '"></div>' +
    '<div><label for="meAge">Age <span style="font-weight:600;">(optional)</span></label><input type="number" id="meAge" min="1" max="120" value="' + (p.age || '') + '"></div></div>' +
    '<div class="modal-actions"><button type="button" class="btn ghost" data-profile-close>Cancel</button><button type="submit" class="btn primary" id="profileSave">Save</button></div>' +
  '</form>';
  renderTop();
  loadMemory();
}
let memPage = null, memConfirm = false, memScroll = false;
async function loadMemory() {
  const box = document.getElementById('memList');
  if (!box) return;
  memConfirm = false;
  try { memPage = await n8nFetch('/memory?chat=none', { method: 'GET' }); renderMemory(); }
  catch (e) { box.innerHTML = '<p class="hint" style="margin:0;">' + esc(e.message) + '</p>'; }
}
function renderMemory() {
  const box = document.getElementById('memList');
  if (!box || !memPage) return;
  const notes = memPage.notes || [];
  box.innerHTML = (notes.length ? notes.map(n => '<div class="wl-row"><span class="ph"><i class="ti ti-notebook"></i></span>' +
      '<div class="t"><b>' + esc(n.note) + '</b><span>' + esc(new Date(n.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) + '</span></div>' +
      '<button type="button" class="mini-btn" data-mem-forget="' + Number(n.id) + '" title="Forget this" aria-label="Forget this"><i class="ti ti-x"></i></button></div>').join('')
    : '<p class="hint" style="margin:0;">Nothing yet. Tell Nathan about yourself ("on weeknights I only have an hour") and he’ll remember.</p>') +
    (notes.length || memPage.chats ? '<button type="button" class="btn ghost" data-mem-all style="margin-top:0.5rem;justify-self:start;">' +
      (memConfirm ? 'Tap again to forget everything' : 'Forget everything (notes and past chats)') + '</button>' : '');
  if (memScroll) { memScroll = false; document.getElementById('memLabel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
profileModal.addEventListener('click', async (e) => {
  const one = e.target.closest('[data-mem-forget]');
  const all = e.target.closest('[data-mem-all]');
  if (!one && !all) return;
  if (all && !memConfirm) { memConfirm = true; renderMemory(); return; }
  try {
    memPage = await n8nFetch('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(one ? { action: 'forget', id: Number(one.dataset.memForget) } : { action: 'forgetAll' }) });
    memConfirm = false;
    renderMemory();
    if (all) { thread.innerHTML = ''; askLast = null; newChat(); setPanel('hidden'); }
    toast(one ? 'Nathan forgot that.' : 'Nathan forgot everything about your chats.');
  } catch (err) { toast(err.message, true); }
});
// "What I remember" under an answer opens the profile at that section
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-memory]')) return;
  memScroll = true;
  document.getElementById('menuProfile').click();
});
function renderTop() {
  const list = document.getElementById('topList');
  if (!list || !myProfile) return;
  const top = myProfile.topGames || [];
  list.innerHTML = top.length ? top.map((g, i) => '<div class="wl-row"><span class="rank">' + (i + 1) + '</span>' +
    (g.cover ? '<img src="' + esc(g.cover) + '" alt="" loading="lazy">' : '<span class="ph"><i class="ti ti-' + esc(DEFAULT_ICON) + '"></i></span>') +
    '<div class="t"><b>' + esc(g.title) + '</b></div>' +
    '<button type="button" class="mini-btn" data-top-move="' + i + '" data-dir="-1" title="Move up" aria-label="Move up"' + (i ? '' : ' disabled') + '><i class="ti ti-arrow-up"></i></button>' +
    '<button type="button" class="mini-btn" data-top-move="' + i + '" data-dir="1" title="Move down" aria-label="Move down"' + (i < top.length - 1 ? '' : ' disabled') + '><i class="ti ti-arrow-down"></i></button>' +
    '<button type="button" class="mini-btn" data-top-remove="' + i + '" title="Remove" aria-label="Remove"><i class="ti ti-x"></i></button></div>').join('')
    : '<p class="hint" style="margin:0;">Nothing yet. Search below to add your all-time favorites.</p>';
  const q = document.getElementById('topQuery');
  if (q) { q.disabled = top.length >= 10; q.placeholder = top.length >= 10 ? 'Your Top 10 is full' : 'Add a game, e.g. Brass: Birmingham'; }
}
async function findTop() {
  const q = document.getElementById('topQuery').value.trim();
  const box = document.getElementById('topResults');
  if (q.length < 2) return;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const { results } = await n8nFetch('/bgg-search?q=' + encodeURIComponent(q), { method: 'GET', signal: AbortSignal.timeout(30000) });
    const have = new Set((myProfile.topGames || []).map(g => g.bggId));
    box.innerHTML = results.filter(x => x.kind !== 'expansion' && !have.has(x.bggId)).slice(0, 6).map(x => '<div class="wl-row">' +
      (x.thumbnail ? '<img src="' + esc(x.thumbnail) + '" alt="" loading="lazy">' : '<span class="ph"><i class="ti ti-' + esc(DEFAULT_ICON) + '"></i></span>') +
      '<div class="t"><b>' + esc(x.title) + '</b><span>' + esc([x.year, x.rating ? 'BGG ' + Number(x.rating).toFixed(1) : ''].filter(Boolean).join(' · ')) + '</span></div>' +
      '<button type="button" class="btn primary" data-top-add="' + x.bggId + '" data-title="' + esc(x.title) + '" data-cover="' + esc(x.thumbnail || '') + '">Add</button></div>').join('') || '<p class="hint" style="margin:0;">No matches.</p>';
  } catch (err) { box.innerHTML = '<p class="hint" style="margin:0;">' + esc(err.message) + '</p>'; }
}
profileModal.addEventListener('keydown', (e) => { if (e.target.id === 'topQuery' && e.key === 'Enter') { e.preventDefault(); findTop(); } });
profileModal.addEventListener('click', (e) => {
  if (!myProfile) return;
  const top = (myProfile.topGames ||= []);
  if (e.target.closest('#topFind')) { findTop(); return; }
  const add = e.target.closest('[data-top-add]');
  if (add && top.length < 10) { top.push({ bggId: Number(add.dataset.topAdd), title: add.dataset.title, cover: add.dataset.cover || null }); document.getElementById('topResults').innerHTML = ''; document.getElementById('topQuery').value = ''; renderTop(); return; }
  const mv = e.target.closest('[data-top-move]');
  if (mv) { const i = Number(mv.dataset.topMove), j = i + Number(mv.dataset.dir); if (top[j]) { [top[i], top[j]] = [top[j], top[i]]; renderTop(); } return; }
  const rm = e.target.closest('[data-top-remove]');
  if (rm) { top.splice(Number(rm.dataset.topRemove), 1); renderTop(); }
});
profileModal.addEventListener('click', (e) => {
  if (e.target === profileModal || e.target.closest('[data-profile-close]')) { profileModal.classList.remove('open'); return; }
  const d = e.target.closest('[data-me-dial]');
  if (d && myProfile) {
    const v = Number(d.dataset.v);
    myProfile[d.dataset.meDial] = myProfile[d.dataset.meDial] === v ? null : v;
    d.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === myProfile[d.dataset.meDial]));
  }
});
profileModal.addEventListener('submit', async (e) => {
  if (e.target.id !== 'profileForm') return;
  e.preventDefault();
  const val = (id) => document.getElementById(id).value;
  const payload = { likes: val('meLikes'), dislikes: val('meDislikes'), notes: val('meNotes'), bggUsername: val('meBgg').trim(), age: val('meAge'),
    ...Object.fromEntries(DIALS.map(d => [d.key, myProfile[d.key] ?? null])), topGames: myProfile.topGames || [] };
  const btn = document.getElementById('profileSave');
  btn.disabled = true;
  try {
    myProfile = (await n8nFetch('/me-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).profile;
    profileModal.classList.remove('open');
    toast('Profile saved. Nathan will take it from here.');
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

// ---------- Admin ----------
// Admin: its own page (dashboard, members, Nathan, rulebooks)
document.getElementById('openAdminBtn').addEventListener('click', () => { location.href = 'admin.html'; });

// ---------- Wishlist ----------
const wishModal = document.getElementById('wishModal');
let myWishes = [];
const wishRow = (g, own) => '<div class="wl-row">' +
  (g.cover ? '<img src="' + esc(g.cover) + '" alt="" loading="lazy">' : '<span class="ph"><i class="ti ti-' + esc(DEFAULT_ICON) + '"></i></span>') +
  '<div class="t"><b><a href="https://boardgamegeek.com/boardgame/' + Number(g.bggId) + '" target="_blank" rel="noopener" style="color:inherit;">' + esc(g.title) + '</a></b>' +
  '<span>' + esc([g.year, g.minPlayers ? g.minPlayers + (g.maxPlayers && g.maxPlayers !== g.minPlayers ? '–' + g.maxPlayers : '') + ' players' : '', g.rating ? 'BGG ' + Number(g.rating).toFixed(1) : ''].filter(Boolean).join(' · ')) + '</span></div>' +
  (own ? '<button type="button" class="btn primary" data-wish-got="' + Number(g.bggId) + '">Got it!</button>' +
    '<button type="button" class="mini-btn" data-wish-remove="' + Number(g.bggId) + '" title="Remove" aria-label="Remove ' + esc(g.title) + '"><i class="ti ti-x"></i></button>' : '') + '</div>';
function renderWishes() {
  document.getElementById('wishBody').innerHTML = myWishes.length ? '<div class="wl-list">' + myWishes.map(g => wishRow(g, true)).join('') + '</div>'
    : '<p class="hint">Nothing yet. Tap "Add to my wishlist" on one of Nathan\'s ideas, or on a game in a friend\'s library.</p>';
}
async function openWishlist() {
  setMenu(false);
  wishModal.classList.add('open');
  document.getElementById('wishBody').innerHTML = '<div class="spinner"></div>';
  try { myWishes = (await n8nFetch('/wishlist', { method: 'GET' })).items || []; renderWishes(); }
  catch (e) { document.getElementById('wishBody').innerHTML = '<p class="hint">' + esc(e.message) + '</p>'; }
}
document.getElementById('menuWishlist').addEventListener('click', openWishlist);
async function changeWish(action, bggId, title, cover) {
  const r = await n8nFetch('/wishlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, bggId, title, cover }) });
  myWishes = r.items || [];
  return r;
}
wishModal.addEventListener('click', async (e) => {
  if (e.target === wishModal || e.target.closest('[data-close-modal]')) { wishModal.classList.remove('open'); return; }
  const rm = e.target.closest('[data-wish-remove]');
  if (rm) { try { await changeWish('remove', Number(rm.dataset.wishRemove)); renderWishes(); } catch (err) { toast(err.message, true); } return; }
  const got = e.target.closest('[data-wish-got]');
  if (got) {
    const id = Number(got.dataset.wishGot);
    const g = myWishes.find(x => x.bggId === id) || {};
    got.disabled = true; got.textContent = 'Adding…';
    try {
      await n8nFetch('/shelf-add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bggId: id }) });
      await changeWish('remove', id);
      renderWishes();
      toast('"' + (g.title || 'That game') + '" is on your shelf now. Enjoy!');
      if (currentShelf() === homeShelf()) loadCollection();
    } catch (err) { toast(err.message, true); got.disabled = false; got.textContent = 'Got it!'; }
  }
});
// "Add to my wishlist" on Nathan's ideas and on games in a friend's library
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wish-add]');
  if (!b || b.disabled) return;
  e.preventDefault(); e.stopPropagation();
  b.disabled = true;
  try {
    await changeWish('add', Number(b.dataset.wishAdd), b.dataset.title, b.dataset.cover || '');
    b.innerHTML = '<i class="ti ti-check"></i> On your wishlist';
    toast('Added "' + b.dataset.title + '" to your wishlist.');
  } catch (err) { b.disabled = false; toast(err.message, true); }
}, true);

// ---------- Profile pages (a friend's, from Friends) ----------
const pageModal = document.getElementById('pageModal');
async function openPage(friendId) {
  pageModal.classList.add('open');
  const body = document.getElementById('pageBody');
  body.innerHTML = '<div class="spinner"></div>';
  try {
    const p = await n8nFetch('/profile' + (friendId ? '?friend=' + Number(friendId) : ''), { method: 'GET' });
    const first = firstName(p.name);
    const dials = DIALS.filter(d => p.dials && p.dials[d.key]).map(d => '<span class="tag">' + esc(d.label) + ' ' + p.dials[d.key] + '/5</span>').join('');
    const words = [p.likes ? '<p><b>Likes:</b> ' + esc(p.likes) + '</p>' : '', p.dislikes ? '<p><b>Not for ' + (p.self ? 'me' : first) + ':</b> ' + esc(p.dislikes) + '</p>' : '', p.about ? '<p>' + esc(p.about) + '</p>' : ''].join('');
    const top = (p.topGames || []);
    body.innerHTML = '<div class="pp-head"><span class="ph"><i class="ti ti-user"></i></span><div><h2 style="margin:0;">' + esc(p.name) + '</h2>' +
        (p.stats.friendsSince ? '<span class="hint">Friends since ' + esc(String(p.stats.friendsSince).slice(0, 10)) + '</span>' : '') + '</div></div>' +
      '<div class="pp-stats"><div><b>' + p.stats.games + '</b><span>Games</span></div><div><b>' + p.stats.plays + '</b><span>Plays</span></div><div><b>' + top.length + '</b><span>Top 10</span></div></div>' +
      (words ? '<div class="pp-words">' + words + '</div>' : '') + (dials ? '<div class="tags" style="justify-content:center; margin-top:0.4rem;">' + dials + '</div>' : '') +
      '<div class="section-label" style="margin-top:1rem;">' + (p.self ? 'My' : esc(first) + '’s') + ' Top 10 games of all time</div>' +
      (top.length ? '<div class="wl-list">' + top.map((g, i) => '<div class="wl-row"><span class="rank">' + (i + 1) + '</span>' +
        (g.cover ? '<img src="' + esc(g.cover) + '" alt="" loading="lazy">' : '<span class="ph"><i class="ti ti-' + esc(DEFAULT_ICON) + '"></i></span>') +
        '<div class="t"><b>' + esc(g.title) + '</b></div></div>').join('') + '</div>' : '<p class="hint" style="margin:0;">' + esc(first) + ' hasn’t picked a Top 10 yet.</p>') +
      ((p.stats.mostPlayed || []).length ? '<div class="section-label" style="margin-top:1rem;">Most played</div><div class="wl-list">' + p.stats.mostPlayed.map(g => '<div class="wl-row">' +
        (g.cover ? '<img src="' + esc(g.cover) + '" alt="" loading="lazy">' : '<span class="ph"><i class="ti ti-' + esc(DEFAULT_ICON) + '"></i></span>') +
        '<div class="t"><b>' + esc(g.title) + '</b><span>' + g.plays + ' plays</span></div></div>').join('') + '</div>' : '') +
      '<div class="section-label" style="margin-top:1rem;">' + (p.self ? 'My' : esc(first) + '’s') + ' wishlist</div>' +
      ((p.wishlist || []).length ? '<div class="wl-list">' + p.wishlist.map(g => wishRow(g, false)).join('') + '</div>' : '<p class="hint" style="margin:0;">Nothing on it yet.</p>');
  } catch (err) { body.innerHTML = '<p class="hint">' + esc(err.message) + '</p>'; }
}
pageModal.addEventListener('click', (e) => { if (e.target === pageModal || e.target.closest('[data-close-modal]')) pageModal.classList.remove('open'); });

// ---------- Friends: your code, add by code, your friends ----------
const friendsModal = document.getElementById('friendsModal');
function renderFriendsPanel() {
  const codeEl = document.getElementById('myFriendCode');
  codeEl.className = friendsData.code ? '' : friendsFailed ? 'failed' : 'loading';
  codeEl.innerHTML = friendsData.code ? esc(friendsData.code) : friendsFailed ? 'Couldn’t load your code · <button type="button" class="add-asis" data-retry-friends style="display:inline; margin:0;">Try again</button>' : 'Loading…';
  document.getElementById('copyFriendCode').hidden = !friendsData.code;
  const list = friendsData.friends || [];
  document.getElementById('friendsList').innerHTML = list.length ? list.map(f =>
    '<div class="fr-row"><div class="who"><b>' + esc(f.name) + '</b><span>' + f.games + (f.games === 1 ? ' game' : ' games') + '</span></div>' +
    '<button type="button" class="btn ghost" data-friend-page="' + f.id + '">Profile</button>' +
    '<button type="button" class="btn ghost" data-view-friend="' + f.id + '">View library</button>' +
    '<button type="button" class="mini-btn" data-remove-friend="' + f.id + '" data-name="' + esc(f.firstName) + '" title="Remove ' + esc(f.firstName) + '" aria-label="Remove ' + esc(f.firstName) + '"><i class="ti ti-x"></i></button></div>'
  ).join('') : '<p class="hint" style="margin:0;">No friends yet. Share your code!</p>';
}
document.getElementById('friendsBtn').addEventListener('click', () => { renderFriendsPanel(); friendsModal.classList.add('open'); loadFriends(); });
document.getElementById('myFriendCode').addEventListener('click', (e) => { if (e.target.closest('[data-retry-friends]')) { friendsFailed = false; renderFriendsPanel(); loadFriends(); } });
document.getElementById('copyFriendCode').addEventListener('click', async () => {
  const code = friendsData.code;
  if (!code) return;
  try { await navigator.clipboard.writeText(code); toast('Copied your code: ' + code); } catch (e) { toast('Your code is ' + code); }
});
document.getElementById('friendAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('friendCodeInput');
  const code = input.value.trim();
  if (!code) return;
  try {
    const r = await n8nFetch('/friends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', code }) });
    input.value = '';
    toast(r.already ? 'You and ' + r.friend.name.split(' ')[0] + ' are already friends.' : 'You and ' + r.friend.name.split(' ')[0] + ' are now friends!');
    await loadFriends();
  } catch (err) { toast(err.message.replace(/^n8n request failed \(\d+\) /, ''), true); }
});
document.getElementById('friendsList').addEventListener('click', (e) => {
  const pg = e.target.closest('[data-friend-page]');
  if (pg) { friendsModal.classList.remove('open'); openPage(pg.dataset.friendPage); }
});
document.getElementById('friendsList').addEventListener('click', async (e) => {
  const view = e.target.closest('[data-view-friend]');
  if (view) { friendsModal.classList.remove('open'); setShelfView('friend:' + view.dataset.viewFriend); return; }
  const rm = e.target.closest('[data-remove-friend]');
  if (rm) {
    if (!confirm('Remove ' + rm.dataset.name + ' as a friend? You’ll stop seeing each other’s shelves.')) return;
    try {
      await n8nFetch('/friends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: Number(rm.dataset.removeFriend) }) });
      if (viewingFriend() === Number(rm.dataset.removeFriend)) setShelfView(homeShelf());
      await loadFriends();
    } catch (err) { toast(err.message, true); }
  }
});
document.getElementById('friendsClose').addEventListener('click', () => friendsModal.classList.remove('open'));
friendsModal.addEventListener('click', (e) => { if (e.target === friendsModal) friendsModal.classList.remove('open'); });

// ---------- Tip jar ----------
// The Ko-fi page; were it ever empty, only the owner would see the button, with a reminder
var TIP_URL = 'https://ko-fi.com/dandehaan'; // var: the top bar can ask before this line runs
var tipModal = document.getElementById('tipModal');
function updateTipJar() { document.getElementById('tipBtn').hidden = !TIP_URL && !isAdmin(); }
document.getElementById('tipBtn').addEventListener('click', () => {
  document.getElementById('tipBody').innerHTML = TIP_URL
    ? '<a class="btn primary" style="display:inline-flex; align-items:center; gap:0.4rem; margin-top:0.4rem; text-decoration:none;" href="' + esc(TIP_URL) + '" target="_blank" rel="noopener"><i class="ti ti-coffee"></i> Leave a tip on Ko-fi</a>'
    : '<p class="hint" style="background:var(--exp-bg); border-radius:0.8rem; padding:0.6rem 0.8rem;">Only you see this until the Ko-fi link is added. Make a Ko-fi page and send Claude the link.</p>';
  tipModal.classList.add('open');
});
document.getElementById('tipClose').addEventListener('click', () => tipModal.classList.remove('open'));
tipModal.addEventListener('click', (e) => { if (e.target === tipModal) tipModal.classList.remove('open'); });
document.getElementById('signInCancel').addEventListener('click', () => document.getElementById('signInModal').classList.remove('open'));
finishRedirectSignIn(); // back from Google's sign-in page
window.addEventListener('load', () => { initGoogle(); renderLandingSignIn(); }); // the Google script loads async

try { setToken(localStorage.getItem(LS_TOKEN)); } catch (e) { setToken(null); }
// Signed in before the owner check existed: confirm once instead of asking to sign in again
if (signedIn() && !isMember() && tokenFresh()) verifyMember(false);
else if (isMember() && !myPlayerId() && tokenFresh()) verifyMember(true);
// Members get the collection and people; visitors see the welcome page and nothing is fetched
if (isMember()) { loadCollection(); loadPeople(); loadFriends(); }
