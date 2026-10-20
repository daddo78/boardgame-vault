// Generates the Board Game Curator n8n workflows into ./workflows/*.json
// Usage: node gen.js <airtableCredId> <bggCredId> [bggUsername]
// Data lives in Postgres (server/bgc-db). The workflows still speak Airtable's record format; each storage node calls
// the database's at.request() adapter, which answers like the Airtable API did. STORE=airtable ./deploy.sh rolls back
// to the frozen Airtable archive.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [AIRTABLE_CRED = 'AIRTABLE_CRED_ID', BGG_CRED = 'BGG_CRED_ID', BGG_USERNAME = ''] = process.argv.slice(2);
const BASE = 'appb5FKsyLareQzG4';
const TABLE = 'tblbGc0UuDxIPP2a8';
const AT_URL = `https://api.airtable.com/v0/${BASE}/${TABLE}`;
const PLAYERS_TABLE = 'tblNahVdHDueJJ0w4';
const RATINGS_TABLE = 'tbllInOWIokikEiQH';
const atUrl = (table) => `https://api.airtable.com/v0/${BASE}/${table}`;
const TABLER_CSS = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.49.0/dist/tabler-icons.min.css';
const VISION_MODEL = 'google/gemini-2.5-flash-lite';
// Google sign-in: only these accounts may change the collection (reading stays public)
const GOOGLE_CLIENT_ID = '91195561493-sbejlc54u0jgr6bid835k9mo8k3j5kqc.apps.googleusercontent.com';
const OWNER_EMAILS = ['dandehaan@gmail.com'];
const ICON_MODEL = 'anthropic/claude-haiku-5.5';
// Ask: picks games for the people at the table (override with ASK_MODEL=... ./deploy.sh ask to compare models)
const ASK_MODEL = process.env.ASK_MODEL || 'anthropic/claude-haiku-5.5';

const ID = {
  collection: 'BGVaultCollect01',
  update: 'BGVaultUpdate001',
  del: 'BGVaultDelete001',
  identify: 'BGVaultIdentify1',
  iconOne: 'BGVaultIconOne01',
  iconBatch: 'BGVaultIconBatch',
  bggOne: 'BGVaultBggOne001',
  bggBatch: 'BGVaultBggBatch1',
  syncPlays: 'BGVaultSyncPlays',
  photoSweep: 'BGVaultPhotoSwp1',
  bggSearch: 'BGVaultBggSrch01',
  addByName: 'BGVaultAddName01',
  whoAmI: 'BGVaultWhoAmI001',
  people: 'BGVaultPeople001',
  rate: 'BGVaultRate00001',
  playerSave: 'BGVaultPlyrSave1',
  playersAdmin: 'BGVaultPlyrAdmn1',
  bggUserRatings: 'BGVaultBggUser01',
  syncPeople: 'BGVaultSyncPpl01',
  ask: 'BGVaultAsk000001',
  me: 'BGVaultMeGet0001',
  meSave: 'BGVaultMeSave001',
  shelf: 'BGVaultShelf0001',
  shelfUpdate: 'BGVaultShelfUpd1',
  shelfRemove: 'BGVaultShelfRem1',
  importBgg: 'BGVaultImport001',
  shelfCsv: 'BGVaultShelfCsv1',
  wishlist: 'BGVaultWishGet01',
  wishChange: 'BGVaultWishSet01',
  profilePage: 'BGVaultProfile01',
  admin: 'BGVaultAdminGet1',
  adminAction: 'BGVaultAdminSet1',
  rulebookUpload: 'BGVaultRulesUp01',
  rulebookGet: 'BGVaultRulesGet1',
  dashboard: 'BGVaultDashbrd01',
  askTest: 'BGVaultAskTest01',
  selfTest: 'BGVaultSelfTest1',
  shelfAdd: 'BGVaultShelfAdd1',
  shelfIdentify: 'BGVaultShelfPic1',
  friends: 'BGVaultFriends01',
  friendsChange: 'BGVaultFriendCh1',
  errorAlert: 'BGVaultAlert0001',
  healthCheck: 'BGVaultHealth001',
};

const STORE = process.env.STORE || 'postgres';
const CRED = {
  airtable: { airtableTokenApi: { id: AIRTABLE_CRED, name: 'Airtable Personal Access Token account' } },
  postgres: { postgres: { id: 'BGCPostgres00001', name: 'BGC Postgres' } },
  smtp: { smtp: { id: 'wj7wyYOWaVVIrifQ', name: 'Resend SMTP' } },
  openrouter: { httpHeaderAuth: { id: 'vxwyGYOyusPAYIJd', name: 'OpenRouter API' } },
  bgg: { httpHeaderAuth: { id: BGG_CRED, name: 'BGG API Token' } },
};

// ---------- shared code-node prelude ----------
function prelude() {
  const F = {
    title: 'fldOSxvCDWJdYbUZe', gameId: 'fldJ1g6gtxWDwlWsI', num: 'fldMTwTBzGdIl5juS',
    genre: 'fldiVlY0CFWH4HMmy', type: 'fldAz2n321hbVgQyN', desc: 'fldUvT2Ek81fKIIDG',
    expansions: 'fldVITaI4eagPe9tS', desireToPlay: 'fldV5vlwouSyJcPjY', thinningCandidate: 'fldskzh1rq9uchgYI',
    icon: 'fldAeaCX58kL3EtaF', bggId: 'fldbWi7hhf2VGYzZl', bggRating: 'fld39CpmejKlyRSU9',
    addedAt: 'fldH3CEdj0SibBeMJ', updatedAt: 'fldFQIX0PXXyas2V7',
    minPlayers: 'fldzXSHLRYoKjn9YY', maxPlayers: 'fldwlQj31eoBIgF32', bestPlayers: 'fldGj8TR8Qgr3awAe',
    minTime: 'fldmxVhDKLpxevVS4', maxTime: 'fldAAPDFVAH2lOax5', weight: 'flduy1oWFgwMcu3my',
    year: 'fldt0ihrGswaVysGs', minAge: 'fldyGkN5wNmeMWY1Z', designers: 'fldv2Eza3ozH8eFTy',
    rank: 'fldydnO9FCaM9K4Bx', categories: 'fldDiWapezN3rdwyH', mechanics: 'fldBe9528dZEr70ez',
    playCount: 'fld9pSGve6FsTDxMN', lastPlayed: 'fldVjyyNET9JmjN8d', favorite: 'fldyfp0FG1zY0K4qu', extraBggIds: 'fldzltyZj2UE9Mj67',
    coverCard: 'fldjYYhunnxlv1OI3', coverLarge: 'flduJBzJRHtHfFR44',
  };
  const jsonList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const toGame = (r) => {
    const f = r.fields || {};
    return {
      id: f[F.gameId] || r.id, recordId: r.id, bggId: f[F.bggId] ?? null, num: f[F.num] ?? null,
      title: f[F.title] || '', genre: f[F.genre] || '', type: f[F.type] || '', desc: f[F.desc] || '',
      expansions: jsonList(f[F.expansions]).map(String), desireToPlay: f[F.desireToPlay] || 0, thinningCandidate: !!f[F.thinningCandidate],
      bggRating: f[F.bggRating] ?? null, icon: f[F.icon] || 'meeple',
      minPlayers: f[F.minPlayers] ?? null, maxPlayers: f[F.maxPlayers] ?? null, bestPlayers: jsonList(f[F.bestPlayers]).map(Number),
      minTime: f[F.minTime] ?? null, maxTime: f[F.maxTime] ?? null, weight: f[F.weight] ?? null,
      year: f[F.year] ?? null, minAge: f[F.minAge] ?? null, designers: jsonList(f[F.designers]).map(String),
      rank: f[F.rank] ?? null, categories: jsonList(f[F.categories]).map(String), mechanics: jsonList(f[F.mechanics]).map(String),
      favorite: !!f[F.favorite], coverCard: f[F.coverCard] || null, coverLarge: f[F.coverLarge] || null, playCount: f[F.playCount] ?? 0, lastPlayed: f[F.lastPlayed] ?? null, addedAt: f[F.addedAt] ?? null,
      // Other editions whose logged plays count toward this game
      extraBggIds: String(f[F.extraBggIds] || '').split(',').map((x) => Number(x.trim())).filter((x) => x > 0),
    };
  };
  const formulaFor = (id) => /^rec[A-Za-z0-9]{14}$/.test(id)
    ? `RECORD_ID()='${id}'`
    : `{GameID}='${String(id).replace(/'/g, "\\'")}'`;
  const normTitle = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();
  // ---- People: Players and Ratings tables ----
  const PF = {
    name: 'fldWVws64FVcdtuSJ', aliases: 'fldbPxy87tXFVHtm1', active: 'fldCTgjMOoTTokadR', googleEmail: 'fldnwPL9Z33JcXoj2',
    bggUsername: 'fldDfHIAzk1AyaJEd', complexity: 'fldobSISLYhxr2nb5', conflict: 'fldslaw9Fv5cxiICf', luck: 'fldzLybJ5l8ALWyPz',
    tableTalk: 'fldVkKcUgFxkxTNfi', theme: 'fldk6X4H1FHJ7Uugm', likes: 'fld7R2WFALqZ2gkR7', dislikes: 'fld6ynTKz3kfM6QHx',
    age: 'fldZvY4FJ2QQDCyyh', notes: 'fldcgwd6wvrgnTSdW', playHistory: 'fldGI1Kr6p107QdZp', updatedAt: 'fldyIFTgzcvEqKaGK',
  };
  const RF = { key: 'fldSVVMwQygNrpyBm', playerId: 'fldB2cw5ie4ypHPGl', gameId: 'fldhrJoBfiLAg1E8q', stars: 'fldSM283jOPAOs2YP', source: 'fldaPLq2gL3UP6zon', updatedAt: 'fldqI4c09b3iHt3um' };
  const toPlayer = (r) => {
    const f = r.fields || {};
    let history = {};
    try { history = JSON.parse(f[PF.playHistory] || '{}') || {}; } catch (e) {}
    return {
      id: r.id, name: f[PF.name] || '', aliases: String(f[PF.aliases] || '').split(',').map((a) => a.trim()).filter(Boolean),
      active: !!f[PF.active], googleEmail: f[PF.googleEmail] || '', bggUsername: f[PF.bggUsername] || '',
      complexity: f[PF.complexity] ?? null, conflict: f[PF.conflict] ?? null, luck: f[PF.luck] ?? null,
      tableTalk: f[PF.tableTalk] ?? null, theme: f[PF.theme] ?? null,
      likes: f[PF.likes] || '', dislikes: f[PF.dislikes] || '', age: f[PF.age] ?? null, notes: f[PF.notes] || '', history,
    };
  };
  // What visitors may see about a person: names and play history (no email, no taste profile; BGG usernames are public on BGG anyway)
  const publicPlayer = (p) => { const { googleEmail, complexity, conflict, luck, tableTalk, theme, likes, dislikes, notes, age, ...rest } = p; return rest; };
  // The part of a player card that belongs to the person: only they edit it (via /me)
  const ownProfile = (p) => ({ name: p.name, bggUsername: p.bggUsername, age: p.age, complexity: p.complexity, conflict: p.conflict, luck: p.luck,
    tableTalk: p.tableTalk, theme: p.theme, likes: p.likes, dislikes: p.dislikes, notes: p.notes });
  const playerNames = (p) => [p.name, ...p.aliases].map((n) => n.toLowerCase());
  // Highest-priority source wins when one person has several ratings for a game
  // BGC stars come only from the person themselves ("site"); BGG ratings are kept apart, out of 10 (stored as stars x2)
  const ratingsByPlayerGame = (list) => {
    const out = {};
    for (const r of list) {
      if (!r.gameId || !r.playerId || !r.stars) continue;
      const e = (out[r.playerId + '|' + r.gameId] ??= { playerId: r.playerId, gameId: r.gameId });
      if (r.source === 'site') e.stars = r.stars;
      else if (r.source === 'bgg') e.bgg = Math.round(r.stars * 2);
    }
    return out;
  };
  // BGG's /thing XML (stats=1) -> plain objects: the facts the catalog keeps, plus an expansion's base game ids
  const parseThingXml = (xml) => {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const attr = (s, tag) => { const m = s.match(new RegExp('<' + tag + '\\s[^>]*value="([^"]*)"')); return m ? m[1] : null; };
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const links = (s, type) => [...s.matchAll(new RegExp('<link type="' + type + '" id="\\d+" value="([^"]*)"', 'g'))].map((m) => decode(m[1]));
    // "Best with": player counts where Best is the top vote in BGG's suggested_numplayers poll
    const bestWith = (s) => {
      const poll = (s.match(/<poll name="suggested_numplayers"[\s\S]*?<\/poll>/) || [''])[0];
      const rows = [...poll.matchAll(/<results numplayers="(\d+)">([\s\S]*?)<\/results>/g)].map((m) => {
        const votes = (label) => Number((m[2].match(new RegExp('value="' + label + '" numvotes="(\\d+)"')) || [])[1] || 0);
        return { n: Number(m[1]), best: votes('Best'), rec: votes('Recommended'), not: votes('Not Recommended') };
      });
      const winners = rows.filter((r) => r.best > 0 && r.best >= r.rec && r.best >= r.not).map((r) => r.n);
      if (winners.length) return winners;
      const top = rows.filter((r) => r.best > 0).sort((a, b) => b.best - a.best)[0];
      return top ? [top.n] : [];
    };
    return [...String(xml || '').matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => {
      const s = m[3];
      const rank = (s.match(/<rank type="subtype"[^>]*name="boardgame"[^>]*value="(\d+)"/) || [])[1];
      const avg = Number(attr(s, 'average') || 0);
      return { id: Number(m[2]), type: m[1], name: decode((s.match(/<name type="primary"[^>]*value="([^"]*)"/) || [])[1] || ''),
        year: num(attr(s, 'yearpublished')), weight: num(attr(s, 'averageweight')) ? Math.round(Number(attr(s, 'averageweight')) * 100) / 100 : null,
        minPlayers: num(attr(s, 'minplayers')), maxPlayers: num(attr(s, 'maxplayers')), minTime: num(attr(s, 'minplaytime')), maxTime: num(attr(s, 'maxplaytime')),
        minAge: num(attr(s, 'minage')), rank: rank ? Number(rank) : null, rating: avg > 0 ? Math.round(avg * 10) / 10 : null, bestPlayers: bestWith(s),
        designers: links(s, 'boardgamedesigner').filter((d) => d !== '(Uncredited)'), categories: links(s, 'boardgamecategory'), mechanics: links(s, 'boardgamemechanic'),
        // An expansion's inbound links point at the base game(s) it expands
        baseIds: [...s.matchAll(/<link type="boardgameexpansion" id="(\d+)"[^>]*inbound="true"/g)].map((x) => Number(x[1])),
        description: decode(decode((s.match(/<description>([\s\S]*?)<\/description>/) || ['', ''])[1])).replace(/&#10;/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700) || null,
        picId: (s.match(/<image>[^<]*\/pic(\d+)\.[a-z]+<\/image>/) || [])[1] || null };
    });
  };
  const toRating = (r) => {
    const f = r.fields || {};
    const src = f[RF.source];
    return { recordId: r.id, playerId: f[RF.playerId] || '', gameId: f[RF.gameId] || '', stars: f[RF.stars] ?? null,
      source: typeof src === 'object' && src ? src.name : src || '' };
  };
}
const body = (fn) => { const s = fn.toString(); return s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')).replace(/^\n/, ''); };
const PRELUDE = body(prelude);

// ---------- node factories ----------
let pos = 0;
const uuid = () => crypto.randomUUID();
const node = (name, type, typeVersion, parameters, extra = {}) => ({
  id: uuid(), name, type, typeVersion, position: [(pos++) * 220, 300], parameters, ...extra,
});
const code = (name, fn, extra) => node(name, 'n8n-nodes-base.code', 2, { jsCode: PRELUDE + '\n' + body(fn) }, extra);
const webhook = (name, method, p, responseMode = 'responseNode') => node(name, 'n8n-nodes-base.webhook', 2,
  { httpMethod: method, path: p, responseMode, ...(responseMode === 'lastNode' ? { responseData: 'firstEntryJson' } : {}), options: { allowedOrigins: '*' } },
  { webhookId: uuid() });
const respond = (name, bodyExpr, codeExpr = 200) => node(name, 'n8n-nodes-base.respondToWebhook', 1.1,
  { respondWith: 'json', responseBody: bodyExpr, options: { responseCode: codeExpr } });
const respondError = () => respond('Respond Error',
  '={{ JSON.stringify({ ok: false, message: $json.message }) }}', '={{ $json.status || 400 }}');
const ifTrue = (name, expr) => node(name, 'n8n-nodes-base.if', 2, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: uuid(), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
const qs = (pairs) => ({ sendQuery: true, queryParameters: { parameters: Object.entries(pairs).map(([name, value]) => ({ name, value })) } });
// table defaults to Games; pass PLAYERS_TABLE / RATINGS_TABLE for the people data
// '={{ expr }}' -> 'expr'; a plain string -> its JSON literal
const innerExpr = (v) => { const m = String(v).match(/^=\{\{([\s\S]*)\}\}$/); return m ? m[1].trim() : JSON.stringify(String(v)); };
// '/{{ $json.id }}' -> a JS template literal that builds the same path at run time
const BT = String.fromCharCode(96);
const templateExpr = (v) => BT + String(v || '').split(BT).join('\\' + BT).replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => '$' + '{' + e + '}') + BT;
// Same request as the Airtable API call, answered by Postgres: at.request(table, method, path, body, formula)
const pgRequest = (name, method, urlSuffix, params, table) => {
  const formula = ((params.queryParameters || {}).parameters || []).find((p) => p.name === 'filterByFormula');
  return node(name, 'n8n-nodes-base.postgres', 2.6, {
    operation: 'executeQuery',
    query: "SELECT x -> 'records' AS records, x ->> 'id' AS id, x ->> 'createdTime' AS \"createdTime\", x -> 'fields' AS fields, (x ->> 'deleted')::boolean AS deleted FROM (SELECT at.request($1, $2, $3, $4::jsonb, $5) AS x) q",
    options: {
      queryReplacement: '={{ [' + [JSON.stringify(table), JSON.stringify(method), templateExpr(urlSuffix),
        params.jsonBody ? innerExpr(params.jsonBody) : "'null'", formula ? innerExpr(formula.value) : "''"].join(', ') + '] }}',
      queryBatching: 'independently',
    },
  }, { credentials: CRED.postgres, ...retry });
};
const airtable = (name, method, urlSuffix, params = {}, options = {}, table = TABLE) => STORE === 'postgres'
  ? pgRequest(name, method, urlSuffix, params, table)
  : node(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method, url: `=${atUrl(table)}${urlSuffix}`, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
    ...params, options,
  }, { credentials: CRED.airtable, ...retry });
// Native Postgres query (no Airtable equivalent): params is an n8n expression returning an array
const pg = (name, query, params) => node(name, 'n8n-nodes-base.postgres', 2.6, {
  operation: 'executeQuery', query, options: { ...(params ? { queryReplacement: params } : {}), queryBatching: 'independently' },
}, { credentials: CRED.postgres, ...retry });
const airtableLookup = (name, formulaExpr = '={{ $json.formula }}') =>
  airtable(name, 'GET', '', qs({ filterByFormula: formulaExpr, returnFieldsByFieldId: 'true', maxRecords: '1' }));
const airtableListAll = (name, table = TABLE) => airtable(name, 'GET', '', qs({ returnFieldsByFieldId: 'true', pageSize: '100' }), {
  pagination: { pagination: {
    paginationMode: 'updateAParameterInEachRequest',
    parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $response.body.offset }}' }] },
    paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.offset }}',
    limitPagesFetched: true, maxRequests: 50, requestInterval: 250,
  } },
}, table);
const jsonBody = (expr) => ({ sendBody: true, specifyBody: 'json', jsonBody: expr });
const airtablePatch = (name) => airtable(name, 'PATCH', '/{{ $json.recordId }}',
  jsonBody('={{ JSON.stringify({ fields: $json.fields, typecast: true, returnFieldsByFieldId: true }) }}'));
const openrouter = (name) => node(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendHeaders: true, headerParameters: { parameters: [
    { name: 'HTTP-Referer', value: 'https://n8n.ondorilabo.com/vault' },
    { name: 'X-Title', value: 'Board Game Curator' },
  ] },
  ...jsonBody('={{ JSON.stringify($json.requestBody) }}'),
  options: { timeout: 90000 },
}, { credentials: CRED.openrouter, ...retry });
const textGet = (name, url, params = {}, creds) => node(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'GET', url, ...(creds ? { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } : {}),
  ...params, options: { timeout: 30000, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
}, { ...(creds ? { credentials: creds } : {}), ...retry });
const execSub = (name, workflowId) => node(name, 'n8n-nodes-base.executeWorkflow', 1.1, {
  source: 'database', workflowId: { __rl: true, value: workflowId, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
}, { onError: 'continueRegularOutput' });
const subTrigger = () => node('When Called By Another Workflow', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' });
const manual = () => node('Run Manually', 'n8n-nodes-base.manualTrigger', 1, {});
const wait = (name, seconds) => node(name, 'n8n-nodes-base.wait', 1.1, { amount: seconds }, { webhookId: uuid() });

// n8n writes uploaded files to disk (executions/temp while running, then moves them under the execution's
// id) and keeps them even for executions it doesn't save. This deletes the webhook's uploaded photo by the
// file id n8n recorded for it, then passes items through unchanged. n8n then logs a harmless
// "Failed to restore binary data" when it tries to move the now-missing file.
const N8N_STORAGE = '/home/node/.n8n/storage';
const deleteUploads = (name) => node(name, 'n8n-nodes-base.code', 2, { jsCode: [
  "const fs = require('fs');",
  "const bin = $('Webhook').first().binary || {};",
  'for (const key of Object.keys(bin)) {',
  "  const id = String(bin[key].id || ''); // e.g. filesystem-v2:workflows/<wf>/executions/temp/binary_data/<uuid>",
  "  if (!id.includes(':')) continue;",
  "  const file = '" + N8N_STORAGE + "/' + id.slice(id.indexOf(':') + 1);",
  "  for (const f of [file, file + '.metadata']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }",
  '}',
  'return $input.all();',
].join('\n') });

// connections: [from, to, fromOutput=0]
const wf = (id, name, nodes, edges, extraSettings = {}) => {
  pos = 0;
  const connections = {};
  for (const [from, to, out = 0] of edges) {
    const c = (connections[from] ??= { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: to, type: 'main', index: 0 });
  }
  const names = new Set(nodes.map((n) => n.name));
  for (const [a, b] of edges) for (const n of [a, b]) if (!names.has(n)) throw new Error(`${name}: unknown node ${n}`);
  return { id, name, active: false, isArchived: false, nodes, connections, pinData: {},
    // Every workflow reports its failures to the Error Alert workflow (which emails Dan)
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner', ...(id !== ID.errorAlert ? { errorWorkflow: ID.errorAlert } : {}), ...extraSettings }, tags: [] };
};

// =====================================================================
// 1. Get Collection  GET /webhook/vault/collection  (member gate; thinning flags only for the owner)
// =====================================================================
const getCollection = wf(ID.collection, 'Vault — Get Collection', [
  webhook('Webhook', 'GET', 'vault/collection'),
  // Dan's own view; friends see his shelf through Friends (which checks the friendship), everyone else sees their own
  code('Owner Only', function () {
    const owner = $('Auth: Role').first().json._auth.role === 'owner';
    return [{ json: owner ? { ok: true } : { ok: false, status: 403, message: 'Open a friend’s shelf from Friends' } }];
  }),
  ifTrue('Owner?', '={{ $json.ok }}'),
  airtableListAll('List All Games'),
  code('Shape For Frontend', function () {
    const owner = $('Auth: Role').first().json._auth.role === 'owner';
    const items = $input.all().flatMap((i) => i.json.records || []).map(toGame)
      .map((g) => owner ? g : { ...g, thinningCandidate: false }) // what Dan may give away is his business
      .sort((a, b) => (a.num || 0) - (b.num || 0));
    return [{ json: { items } }];
  }),
  respond('Respond', '={{ JSON.stringify($json.items) }}'),
  respondError(),
], [['Webhook', 'Owner Only'], ['Owner Only', 'Owner?'], ['Owner?', 'List All Games', 0], ['Owner?', 'Respond Error', 1],
  ['List All Games', 'Shape For Frontend'], ['Shape For Frontend', 'Respond']]);
addMemberAuth(getCollection, { failTo: 'Respond Error' });

// =====================================================================
// 2. Update  POST /webhook/vault/update  { id, fields: { desireToPlay?, thinningCandidate?, ... } }
// =====================================================================
const update = wf(ID.update, 'Vault — Update Game', [
  webhook('Webhook', 'POST', 'vault/update'),
  code('Validate', function () {
    const b = $input.first().json.body || {};
    const err = (message) => [{ json: { ok: false, status: 400, message } }];
    if (!b.id) return err('Missing id');
    const out = {};
    for (const [k, v] of Object.entries(b.fields || {})) {
      switch (k) {
        case 'desireToPlay': {
          const n = Math.round(Number(v));
          if (!(n >= 0 && n <= 5)) return err('desireToPlay must be 0-5');
          out[F.desireToPlay] = n; break;
        }
        case 'thinningCandidate': case 'favorite': out[F[k]] = v === true || v === 'true'; break;
        case 'title': case 'genre': case 'type': case 'desc': case 'icon': out[F[k]] = String(v ?? ''); break;
        case 'expansions':
          if (!Array.isArray(v)) return err('expansions must be an array');
          out[F.expansions] = JSON.stringify(v.map(String)); break;
        case 'bggId': case 'bggRating': out[F[k]] = v === null || v === '' ? null : Number(v); break;
        default: return err('Field not editable: ' + k);
      }
    }
    if (!Object.keys(out).length) return err('No fields to update');
    out[F.updatedAt] = new Date().toISOString();
    return [{ json: { ok: true, id: String(b.id), formula: formulaFor(String(b.id)), fields: out } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  airtableLookup('Find Record'),
  code('Check Found', function () {
    const rec = ($input.first().json.records || [])[0];
    const v = $('Validate').first().json;
    if (!rec) return [{ json: { ok: false, status: 404, message: 'Game not found: ' + v.id } }];
    return [{ json: { ok: true, id: v.id, recordId: rec.id, fields: v.fields } }];
  }),
  ifTrue('Found?', '={{ $json.ok }}'),
  airtablePatch('Update Record'),
  respond('Respond OK', '={{ JSON.stringify({ ok: true, game: $json }) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Find Record', 0], ['Valid?', 'Respond Error', 1],
  ['Find Record', 'Check Found'], ['Check Found', 'Found?'], ['Found?', 'Update Record', 0], ['Found?', 'Respond Error', 1],
  ['Update Record', 'Respond OK'],
]);
// Return the frontend-shaped game rather than the raw Airtable record
update.nodes.find((n) => n.name === 'Respond OK').parameters.responseBody = '={{ JSON.stringify({ ok: true, id: $(\'Check Found\').first().json.id }) }}';

// =====================================================================
// 3. Delete  POST /webhook/vault/delete  { id }
// =====================================================================
const del = wf(ID.del, 'Vault — Delete Game', [
  webhook('Webhook', 'POST', 'vault/delete'),
  code('Validate', function () {
    const b = $input.first().json.body || {};
    if (!b.id) return [{ json: { ok: false, status: 400, message: 'Missing id' } }];
    return [{ json: { ok: true, id: String(b.id), formula: formulaFor(String(b.id)) } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  airtableLookup('Find Record'),
  code('Check Found', function () {
    const rec = ($input.first().json.records || [])[0];
    const v = $('Validate').first().json;
    if (!rec) return [{ json: { ok: false, status: 404, message: 'Game not found: ' + v.id } }];
    return [{ json: { ok: true, id: v.id, recordId: rec.id, title: toGame(rec).title } }];
  }),
  ifTrue('Found?', '={{ $json.ok }}'),
  airtable('Delete Record', 'DELETE', '/{{ $json.recordId }}'),
  respond('Respond OK', '={{ JSON.stringify({ ok: true, id: $(\'Check Found\').first().json.id, title: $(\'Check Found\').first().json.title }) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Find Record', 0], ['Valid?', 'Respond Error', 1],
  ['Find Record', 'Check Found'], ['Check Found', 'Found?'], ['Found?', 'Delete Record', 0], ['Found?', 'Respond Error', 1],
  ['Delete Record', 'Respond OK'],
]);

// =====================================================================
// 5a. Assign Icon (single)  sub-workflow + POST /webhook/vault/assign-icon { id }
// =====================================================================
const iconOne = wf(ID.iconOne, 'Vault — Assign Icon (single)', [
  subTrigger(),
  webhook('Webhook', 'POST', 'vault/assign-icon', 'lastNode'),
  code('Normalize', function () {
    const j = $input.first().json;
    const src = j.body || j;
    if (!src.id) throw new Error('Missing id');
    // avoid: icons already used by many other games; picked only if nothing else fits
    const avoid = Array.isArray(src.avoid) ? src.avoid.map(String) : [];
    return [{ json: { id: String(src.id), formula: formulaFor(String(src.id)), avoid } }];
  }),
  airtableLookup('Find Record'),
  code('Prep', function () {
    const rec = ($input.first().json.records || [])[0];
    if (!rec) throw new Error('Game not found: ' + $('Normalize').first().json.id);
    return [{ json: { recordId: rec.id, game: toGame(rec), avoid: $('Normalize').first().json.avoid } }];
  }),
  textGet('Fetch Tabler Catalog', TABLER_CSS),
  code('Build Icon Prompt', function () {
    const names = [...String($input.first().json.data || '').matchAll(/\.ti-([a-z0-9-]+):before/g)].map((m) => m[1]);
    if (names.length < 1000) throw new Error('Tabler catalog looks wrong: only ' + names.length + ' icons');
    const { game: g, avoid } = $('Prep').first().json;
    const prompt = [
      `Board game: ${g.title}`,
      `Theme/genre: ${g.genre}`,
      `Mechanics: ${g.type}`,
      `Description: ${g.desc}`,
      '',
      'Suggest 8 Tabler Icons (v3) names for a small pictogram on this game\'s collection card, best first.',
      '- Use exact Tabler names: kebab-case, as in class "ti ti-<name>", without the "ti-" prefix.',
      '- Depict what is most distinctive about this particular game (a signature object, creature, place or action), not its broad genre or its mechanics.',
      '- Avoid generic gaming icons (meeple, dice, cards, chess, puzzle, device-gamepad) unless the game is literally about them.',
      '- Never use "-off" variants.',
      ...(avoid.length ? [`- These icons are already used by many other games in the collection; do not suggest them: ${avoid.join(', ')}.`] : []),
      'Reply with JSON only: {"candidates":["name1","name2",...]}',
    ].join('\n');
    return [{ json: { requestBody: {
      model: '__ICON_MODEL__', max_tokens: 1000, temperature: 0.2, reasoning: { enabled: false },
      messages: [
        { role: 'system', content: 'You pick pictograms from the Tabler Icons library for a board game collection app. Reply with JSON only.' },
        { role: 'user', content: prompt },
      ],
    } } }];
  }),
  openrouter('Ask AI For Icon'),
  code('Validate Icon', function () {
    const names = [...String($('Fetch Tabler Catalog').first().json.data || '').matchAll(/\.ti-([a-z0-9-]+):before/g)].map((m) => m[1]);
    const catalog = new Set(names);
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    let candidates = [];
    try { candidates = JSON.parse(text.match(/\{[\s\S]*\}/)[0]).candidates || []; } catch (e) {}
    candidates = candidates.map((c) => String(c).toLowerCase().trim().replace(/^ti-/, '').replace(/\s+/g, '-'));
    const avoid = new Set($('Prep').first().json.avoid);
    let icon = null, match = 'fallback';
    for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off') && !avoid.has(c)) { icon = c; match = 'exact'; break; }
    if (!icon) for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off')) { icon = c; match = 'exact-avoided'; break; }
    if (!icon) for (const c of candidates) {
      const n = names.find((x) => x.startsWith(c + '-') && !x.endsWith('-off') && !x.endsWith('-filled'));
      if (n) { icon = n; match = 'prefix'; break; }
    }
    if (!icon) icon = 'meeple';
    const p = $('Prep').first().json;
    return [{ json: { recordId: p.recordId, id: p.game.id, title: p.game.title, icon, match, candidates,
      fields: { [F.icon]: icon, [F.updatedAt]: new Date().toISOString() } } }];
  }),
  airtablePatch('Save Icon'),
  code('Result', function () {
    const v = $('Validate Icon').first().json;
    return [{ json: { ok: true, id: v.id, title: v.title, icon: v.icon, match: v.match, candidates: v.candidates } }];
  }),
], [
  ['When Called By Another Workflow', 'Normalize'], ['Webhook', 'Normalize'], ['Normalize', 'Find Record'],
  ['Find Record', 'Prep'], ['Prep', 'Fetch Tabler Catalog'], ['Fetch Tabler Catalog', 'Build Icon Prompt'],
  ['Build Icon Prompt', 'Ask AI For Icon'], ['Ask AI For Icon', 'Validate Icon'], ['Validate Icon', 'Save Icon'], ['Save Icon', 'Result'],
]);

// =====================================================================
// 6a. BGG Enrich (single)  sub-workflow + POST /webhook/vault/bgg-enrich { id, dryRun?, applyFuzzy? }
// =====================================================================
const bggOne = wf(ID.bggOne, 'Vault — BGG Enrich (single)', [
  subTrigger(),
  webhook('Webhook', 'POST', 'vault/bgg-enrich', 'lastNode'),
  code('Normalize', function () {
    const j = $input.first().json;
    const src = j.body || j;
    if (!src.id) throw new Error('Missing id');
    const flag = (v) => v === true || v === 'true';
    // bggId: force a specific BGG game (fixes a bad match); rematch: ignore the stored BGGId and search again;
    // adoptTitle: let BGG fix this game's title (case/punctuation only). The collection owns its titles by default.
    return [{ json: { id: String(src.id), formula: formulaFor(String(src.id)), dryRun: flag(src.dryRun), applyFuzzy: flag(src.applyFuzzy),
      forceBggId: Number(src.bggId) || null, rematch: flag(src.rematch), adoptTitle: flag(src.adoptTitle) } }];
  }),
  airtableLookup('Find Record'),
  code('Prep', function () {
    const rec = ($input.first().json.records || [])[0];
    const n = $('Normalize').first().json;
    if (!rec) throw new Error('Game not found: ' + n.id);
    const game = toGame(rec);
    const fixedId = n.forceBggId || (!n.rematch && game.bggId) || null;
    return [{ json: { recordId: rec.id, game, query: game.title.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(),
      dryRun: n.dryRun, applyFuzzy: n.applyFuzzy, adoptTitle: n.adoptTitle,
      fixedId, fixedType: n.forceBggId ? 'manual' : 'stored', needSearch: !fixedId } }];
  }),
  ifTrue('Need Search?', '={{ $json.needSearch }}'),
  textGet('BGG Search', 'https://boardgamegeek.com/xmlapi2/search',
    qs({ query: '={{ $json.query }}', type: 'boardgame' }), CRED.bgg),
  code('Find Candidates', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const p = $('Prep').first().json;
    if (p.fixedId) return [{ json: { ...p, matchType: p.fixedType, ids: String(p.fixedId), found: true, searchHits: 0 } }];
    const xml = String($input.first().json.data || '');
    const items = [...xml.matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => ({
      id: m[2], name: decode((m[3].match(/<name type="[^"]+" value="([^"]*)"/) || [])[1] || ''),
    }));
    const t = normTitle(p.game.title);
    let matchType = 'exact';
    let pool = items.filter((i) => normTitle(i.name) === t);
    if (!pool.length) {
      matchType = 'fuzzy';
      pool = items.filter((i) => { const n = normTitle(i.name); return n && (n.startsWith(t + ' ') || t.startsWith(n + ' ')); });
    }
    const ids = [...new Set(pool.map((i) => i.id))].slice(0, 20);
    return [{ json: { ...p, matchType: ids.length ? matchType : 'none', ids: ids.join(','), found: ids.length > 0, searchHits: items.length } }];
  }),
  ifTrue('Any Candidates?', '={{ $json.found }}'),
  textGet('BGG Thing', 'https://boardgamegeek.com/xmlapi2/thing', qs({ id: '={{ $json.ids }}', stats: '1' }), CRED.bgg),
  code('Choose Match', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const xml = String($input.first().json.data || '');
    const c = $('Find Candidates').first().json;
    const attr = (s, tag) => { const m = s.match(new RegExp('<' + tag + '\\s[^>]*value="([^"]*)"')); return m ? m[1] : null; };
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const links = (s, type) => [...s.matchAll(new RegExp('<link type="' + type + '" id="\\d+" value="([^"]*)"', 'g'))].map((m) => decode(m[1]));
    // "Best with": player counts where Best is the top vote in BGG's suggested_numplayers poll
    const bestWith = (s) => {
      const poll = (s.match(/<poll name="suggested_numplayers"[\s\S]*?<\/poll>/) || [''])[0];
      const rows = [...poll.matchAll(/<results numplayers="(\d+)">([\s\S]*?)<\/results>/g)].map((m) => {
        const votes = (label) => Number((m[2].match(new RegExp('value="' + label + '" numvotes="(\\d+)"')) || [])[1] || 0);
        return { n: Number(m[1]), best: votes('Best'), rec: votes('Recommended'), not: votes('Not Recommended') };
      });
      const winners = rows.filter((r) => r.best > 0 && r.best >= r.rec && r.best >= r.not).map((r) => r.n);
      if (winners.length) return winners;
      const top = rows.filter((r) => r.best > 0).sort((a, b) => b.best - a.best)[0];
      return top ? [top.n] : [];
    };
    const things = [...xml.matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => {
      const s = m[3];
      const rank = (s.match(/<rank type="subtype"[^>]*name="boardgame"[^>]*value="(\d+)"/) || [])[1];
      return {
        type: m[1], id: Number(m[2]),
        name: decode((s.match(/<name type="primary"[^>]*value="([^"]*)"/) || [])[1] || ''),
        year: num(attr(s, 'yearpublished')),
        usersRated: Number(attr(s, 'usersrated') || 0),
        average: Number(attr(s, 'average') || 0),
        weight: num(attr(s, 'averageweight')),
        minPlayers: num(attr(s, 'minplayers')), maxPlayers: num(attr(s, 'maxplayers')),
        minTime: num(attr(s, 'minplaytime')), maxTime: num(attr(s, 'maxplaytime')), minAge: num(attr(s, 'minage')),
        rank: rank ? Number(rank) : null, bestPlayers: bestWith(s),
        designers: links(s, 'boardgamedesigner').filter((d) => d !== '(Uncredited)'),
        categories: links(s, 'boardgamecategory'), mechanics: links(s, 'boardgamemechanic'),
        picId: (s.match(/<image>[^<]*\/pic(\d+)\.[a-z]+<\/image>/) || [])[1] || null,
      };
    });
    things.sort((a, b) => ((b.type === 'boardgame') - (a.type === 'boardgame')) || (b.usersRated - a.usersRated));
    const best = things[0];
    if (!best) return [{ json: { ...c, matchType: 'none', apply: false } }];
    const bggRating = best.average > 0 ? Math.round(best.average * 10) / 10 : null;
    const fields = {
      [F.bggId]: best.id, [F.bggRating]: bggRating,
      [F.minPlayers]: best.minPlayers, [F.maxPlayers]: best.maxPlayers, [F.bestPlayers]: JSON.stringify(best.bestPlayers),
      [F.minTime]: best.minTime, [F.maxTime]: best.maxTime, [F.minAge]: best.minAge,
      [F.weight]: best.weight ? Math.round(best.weight * 100) / 100 : null, [F.year]: best.year, [F.rank]: best.rank,
      [F.designers]: JSON.stringify(best.designers), [F.categories]: JSON.stringify(best.categories), [F.mechanics]: JSON.stringify(best.mechanics),
      [F.updatedAt]: new Date().toISOString(),
    };
    // The collection is the source of truth: titles change only with adoptTitle, and only cosmetically; a match on an alternate name
    // ("Steam: Rails to Riches" -> "Steam") keeps the collection's own, more specific title
    const trusted = c.matchType === 'exact' || c.matchType === 'manual';
    const retitle = c.adoptTitle && best.name && best.name !== c.game.title && normTitle(best.name) === normTitle(c.game.title);
    if (retitle) fields[F.title] = best.name;
    const apply = !c.dryRun && (trusted || c.matchType === 'stored' || c.applyFuzzy);
    const { designers, categories, mechanics, ...summary } = best;
    return [{ json: { ...c, apply, fields, bgg: { ...summary, rating: bggRating, designers },
      newTitle: retitle ? best.name : null, alternatives: things.slice(1, 4).map((t) => ({ id: t.id, title: t.name, year: t.year, usersRated: t.usersRated })) } }];
  }),
  // The XML API only gives a 200x150 thumbnail and the full original (often >1 MB); BGG's image
  // endpoint lists the in-between sizes its own site uses. A failure here just means no cover.
  node('BGG Image Sizes', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: '=https://api.geekdo.com/api/images/{{ ($json.bgg && $json.bgg.picId) || 0 }}', options: { timeout: 20000 },
  }, { ...retry, maxTries: 2, onError: 'continueRegularOutput' }),
  code('Add Cover', function () {
    const m = $('Choose Match').first().json;
    const im = $input.first().json.images || {};
    const card = im.medium?.url || im.itempage?.url || null;
    const large = im.itempage?.url || im.medium?.url || null;
    const fields = { ...(m.fields || {}) };
    if (card) { fields[F.coverCard] = card; fields[F.coverLarge] = large; }
    return [{ json: { ...m, fields, bgg: m.bgg ? { ...m.bgg, coverCard: card } : m.bgg } }];
  }),
  // Plays for just this game, so a newly added game shows its BG Stats/BGG plays right away
  // instead of waiting for the daily sync. A failure here leaves the play fields untouched.
  { ...textGet('BGG Plays For Game', 'https://boardgamegeek.com/xmlapi2/plays',
    qs({ username: '__BGG_USERNAME__', id: '={{ ($json.bgg && $json.bgg.id) || 0 }}', type: 'thing' }), CRED.bgg), onError: 'continueRegularOutput' },
  code('Add Plays', function () {
    const m = $('Add Cover').first().json;
    const res = $input.first().json;
    const xml = String(res.data || '');
    if (res.error || !m.bgg || !xml.includes('<plays')) return [{ json: m }];
    let count = 0, last = null;
    for (const p of xml.matchAll(/<play id="\d+" date="([^"]*)" quantity="(\d+)"/g)) {
      count += Number(p[2]) || 1;
      if (p[1] && p[1] !== '0000-00-00' && (!last || p[1] > last)) last = p[1];
    }
    // A page holds 100 plays; past that, fall back to BGG's total (the daily sync sums quantities exactly)
    const total = Number((xml.match(/<plays [^>]*total="(\d+)"/) || [])[1] || 0);
    if (total > 100) count = Math.max(count, total);
    return [{ json: { ...m, fields: { ...m.fields, [F.playCount]: count, [F.lastPlayed]: last }, bgg: { ...m.bgg, playCount: count, lastPlayed: last } } }];
  }),
  ifTrue('Apply?', '={{ $json.apply }}'),
  airtablePatch('Save BGG Data'),
  code('Result', function () {
    const src = $('Add Plays').isExecuted ? $('Add Plays').first().json : $('Find Candidates').first().json;
    const applied = $('Save BGG Data').isExecuted;
    return [{ json: { ok: true, id: src.game.id, title: src.game.title, matchType: src.matchType, applied,
      dryRun: src.dryRun, bgg: src.bgg || null, newTitle: src.newTitle || null, alternatives: src.alternatives || [] } }];
  }),
  wait('Throttle BGG', 1.5),
], [
  ['When Called By Another Workflow', 'Normalize'], ['Webhook', 'Normalize'], ['Normalize', 'Find Record'],
  ['Find Record', 'Prep'], ['Prep', 'Need Search?'], ['Need Search?', 'BGG Search', 0], ['Need Search?', 'Find Candidates', 1], ['BGG Search', 'Find Candidates'], ['Find Candidates', 'Any Candidates?'],
  ['Any Candidates?', 'BGG Thing', 0], ['Any Candidates?', 'Result', 1], ['BGG Thing', 'Choose Match'], ['Choose Match', 'BGG Image Sizes'], ['BGG Image Sizes', 'Add Cover'], ['Add Cover', 'BGG Plays For Game'], ['BGG Plays For Game', 'Add Plays'], ['Add Plays', 'Apply?'],
  ['Apply?', 'Save BGG Data', 0], ['Apply?', 'Result', 1], ['Save BGG Data', 'Result'], ['Result', 'Throttle BGG'],
]);

// =====================================================================
// 5b / 6b. Batch runners (manual trigger in the n8n UI)
// =====================================================================
const batch = (id, name, subId, filterFn, subName) => wf(id, name, [
  manual(),
  code('Options', function () {
    // Edit these before clicking "Execute workflow"
    return [{ json: { all: false, limit: 0, dryRun: false, applyFuzzy: false } }];
  }),
  airtableListAll('List All Games'),
  code('Pick Games', filterFn),
  execSub(subName, subId),
  code('Summary', function () {
    const rows = $input.all().map((i) => i.json);
    const failed = rows.filter((r) => r.error || r.ok !== true);
    return [{ json: { processed: rows.length, failed: failed.length, failures: failed.slice(0, 50), results: rows } }];
  }),
], [['Run Manually', 'Options'], ['Options', 'List All Games'], ['List All Games', 'Pick Games'], ['Pick Games', subName], [subName, 'Summary']]);

const iconBatch = batch(ID.iconBatch, 'Vault — Assign Icons (batch)', ID.iconOne, function () {
  const o = $('Options').first().json;
  let games = $input.all().flatMap((i) => i.json.records || []).map(toGame)
    .filter((g) => o.all || !g.icon || g.icon === 'meeple');
  if (o.limit > 0) games = games.slice(0, o.limit);
  return games.map((g) => ({ json: { id: g.id } }));
}, 'Assign Icon');

const bggBatch = batch(ID.bggBatch, 'Vault — BGG Enrich (batch)', ID.bggOne, function () {
  const o = $('Options').first().json;
  let games = $input.all().flatMap((i) => i.json.records || []).map(toGame)
    .filter((g) => o.all || !g.bggId);
  if (o.limit > 0) games = games.slice(0, o.limit);
  return games.map((g) => ({ json: { id: g.id, dryRun: o.dryRun, applyFuzzy: o.applyFuzzy } }));
}, 'BGG Enrich');

// =====================================================================
// 4. Identify From Photo  POST /webhook/vault/identify  multipart { photo }
//    One photo can hold several boxes. Each one is classified before anything is written:
//      skip      - already owned (same title, the model matched it to an owned title, or already listed as an expansion)
//      expansion - an expansion of an owned game: appended to that game's Expansions list
//      create    - new game: created, BGG-enriched, then removed again if its BGG ID matches an owned game
// =====================================================================
const identify = wf(ID.identify, 'Vault — Identify Games From Photo', [
  webhook('Webhook', 'POST', 'vault/identify'),
  node('Photo To Base64', 'n8n-nodes-base.extractFromFile', 1, {
    operation: 'binaryToPropery', binaryPropertyName: '={{ Object.keys($binary)[0] }}', destinationKey: 'photoB64', options: {},
  }),
  airtableListAll('List All Games'),
  code('Build Vision Request', function () {
    const bin = $('Webhook').first().binary || {};
    const key = Object.keys(bin)[0];
    if (!key) throw new Error('No photo uploaded');
    const mime = bin[key].mimeType || 'image/jpeg';
    const b64 = $('Photo To Base64').first().json.photoB64;
    const owned = $input.all().flatMap((i) => i.json.records || []).map(toGame).map((g) => g.title).sort();
    const instructions = [
      'Identify every board game box visible in this photo (fronts, backs or spines). Skip anything you cannot read confidently.',
      'Reply with JSON only:',
      '{"items": [{',
      '  "title": "official title as printed, e.g. \\"Dune: Imperium\\"",',
      '  "kind": "game" or "expansion",',
      '  "baseGame": "for an expansion, the title of the game it expands; else null",',
      '  "owned": "if this is the same game (any edition, spelling or language) as a title in the OWNED list below, that exact OWNED title; else null. An expansion is never the same game as its base game: for an expansion, only fill this if the expansion itself is in the list",',
      '  "genre": "theme/setting, 1-2 short labels joined by \\" / \\", e.g. \\"Nature / Ecology\\"",',
      '  "type": "core mechanics, 1-2 labels joined by \\" / \\", e.g. \\"Engine Building / Tableau\\"",',
      '  "desc": "one vivid sentence (max ~22 words) about what players do",',
      '  "confidence": 0.0-1.0',
      '}], "reason": "only if no boxes could be identified"}',
      'Style example: {"title":"Earth","kind":"game","genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
      '',
      'OWNED:',
      ...owned,
    ].join('\n');
    return [{ json: { requestBody: {
      // Low reasoning keeps answers fast and cheap (some vision models require reasoning to be on)
      model: '__VISION_MODEL__', max_tokens: 8000, reasoning: { effort: 'low' },
      // Only route to providers that don't store or train on the photo
      provider: { data_collection: 'deny' },
      messages: [
        { role: 'system', content: 'You identify board games from photos for a personal collection catalog. Reply with JSON only.' },
        { role: 'user', content: [
          { type: 'text', text: instructions },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ] },
      ],
    } } }];
  }),
  openrouter('Ask Vision Model'),
  code('Plan', function () {
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    let r = {};
    try { r = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch (e) {}
    const found = (Array.isArray(r.items) ? r.items : [])
      .filter((i) => i && i.title && (i.confidence == null || Number(i.confidence) >= 0.5))
      .map((i) => ({ title: String(i.title).trim(), kind: i.kind === 'expansion' ? 'expansion' : 'game', baseGame: i.baseGame ? String(i.baseGame) : null,
        owned: i.owned ? String(i.owned) : null, genre: String(i.genre || ''), type: String(i.type || ''), desc: String(i.desc || '') }));
    if (!found.length) {
      return [{ json: { ok: false, status: 422, message: 'Could not identify a game in that photo' + (r.reason ? ': ' + r.reason : '') } }];
    }
    const games = $('List All Games').all().flatMap((i) => i.json.records || []).map(toGame);
    const byTitle = new Map(games.map((g) => [normTitle(g.title), g]));
    const expansionOwner = new Map();
    for (const g of games) for (const e of g.expansions) expansionOwner.set(normTitle(e), g);
    const skipped = [], expansions = [], creates = [], deferred = [];
    const seen = new Set();
    const expUpdates = new Map(); // recordId -> { game, list }
    let num = Math.max(0, ...games.map((g) => Number(g.num) || 0));
    for (const it of found) {
      const key = normTitle(it.title);
      if (seen.has(key)) continue; // same box twice in one photo
      seen.add(key);
      const sameTitle = byTitle.get(key);
      const modelMatch = it.owned ? byTitle.get(normTitle(it.owned)) : null;
      // For an expansion, the model sometimes points "owned" at the base game; that means "expansion of", not "duplicate"
      const modelDupe = modelMatch && !(it.kind === 'expansion' && normTitle(modelMatch.title) !== key) ? modelMatch : null;
      if (sameTitle || modelDupe) { skipped.push({ title: it.title, reason: 'already in your collection', existing: (sameTitle || modelDupe).title }); continue; }
      const owner = expansionOwner.get(key);
      if (owner) { skipped.push({ title: it.title, reason: 'already listed as an expansion', existing: owner.title }); continue; }
      if (it.kind === 'expansion') {
        // Base game: what the model named, else the longest owned title the expansion's name starts with
        const base = (it.baseGame && byTitle.get(normTitle(it.baseGame))) || modelMatch
          || games.filter((g) => key.startsWith(normTitle(g.title) + ' ')).sort((a, b) => b.title.length - a.title.length)[0];
        if (base) {
          const u = expUpdates.get(base.recordId) || { game: base, list: [...base.expansions] };
          u.list.push(it.title);
          expUpdates.set(base.recordId, u);
          expansions.push({ title: it.title, base: base.title });
          continue;
        }
      }
      // At most 8 new games per photo keeps the run inside Cloudflare's ~100s response limit
      if (creates.length >= 8) { deferred.push(it.title); continue; }
      num += 1;
      const gameId = `photo-g${num}`;
      const now = new Date().toISOString();
      creates.push({ gameId, title: it.title, fields: {
        [F.title]: it.title, [F.gameId]: gameId, [F.num]: num, [F.genre]: it.genre, [F.type]: it.type, [F.desc]: it.desc,
        [F.expansions]: '[]', [F.desireToPlay]: 0, [F.thinningCandidate]: false, [F.icon]: 'meeple', [F.addedAt]: now, [F.updatedAt]: now,
      } });
    }
    const expRecords = [...expUpdates.entries()].map(([id, u]) => ({ id, fields: { [F.expansions]: JSON.stringify(u.list), [F.updatedAt]: new Date().toISOString() } }));
    return [{ json: { ok: true, creates, skipped, expansions, deferred, expRecords,
      ownedBgg: games.filter((g) => g.bggId).map((g) => ({ bggId: g.bggId, title: g.title })) } }];
  }),
  ifTrue('Identified?', '={{ $json.ok }}'),
  ifTrue('Expansions To Add?', '={{ $json.expRecords.length > 0 }}'),
  airtable('Save Expansions', 'PATCH', '', jsonBody('={{ JSON.stringify({ records: $json.expRecords.slice(0, 10), typecast: true }) }}')),
  code('After Expansions', function () { return [{ json: $('Plan').first().json }]; }),
  ifTrue('New Games?', '={{ $json.creates.length > 0 }}'),
  airtable('Create Records', 'POST', '', jsonBody('={{ JSON.stringify({ records: $json.creates.map(c => ({ fields: c.fields })), typecast: true, returnFieldsByFieldId: true }) }}')),
  code('One Item Per New Game', function () {
    return ($input.first().json.records || []).map((r) => ({ json: { id: r.fields[F.gameId], recordId: r.id, title: r.fields[F.title] } }));
  }),
  execSub('BGG Enrich', ID.bggOne),
  code('Check BGG Duplicates', function () {
    const plan = $('Plan').first().json;
    const created = $('One Item Per New Game').all().map((i) => i.json);
    const results = $input.all().map((i) => i.json);
    const owned = new Map(plan.ownedBgg.map((o) => [Number(o.bggId), o.title]));
    const keep = [], dupes = [];
    created.forEach((c, i) => {
      const bggId = Number(results[i]?.bgg?.id) || null;
      if (bggId && owned.has(bggId)) { dupes.push({ ...c, existing: owned.get(bggId) }); return; }
      if (bggId) owned.set(bggId, c.title); // two different-looking boxes of the same game in one photo
      keep.push({ ...c, bggTitle: results[i]?.bgg?.name || null });
    });
    return [{ json: { keep, dupes } }];
  }),
  ifTrue('Remove Duplicates?', '={{ $json.dupes.length > 0 }}'),
  airtable('Delete Duplicates', 'DELETE', '{{ "?" + $json.dupes.map(d => "records[]=" + d.recordId).join("&") }}'),
  code('After Duplicates', function () { return [{ json: $('Check BGG Duplicates').first().json }]; }),
  ifTrue('Icons Needed?', '={{ $json.keep.length > 0 }}'),
  code('One Item Per Kept Game', function () { return $input.first().json.keep.map((k) => ({ json: { id: k.id } })); }),
  execSub('Assign Icon', ID.iconOne),
  code('Summary', function () {
    const plan = $('Plan').first().json;
    const check = $('Check BGG Duplicates').isExecuted ? $('Check BGG Duplicates').first().json : { keep: [], dupes: [] };
    const added = check.keep.map((k) => ({ id: k.id, title: k.title }));
    const skipped = [...plan.skipped, ...check.dupes.map((d) => ({ title: d.title, reason: 'same BGG game as one you own', existing: d.existing }))];
    return [{ json: { ok: true, added, skipped, expansions: plan.expansions, deferred: plan.deferred,
      // kept for older clients that read a single game
      title: added[0]?.title || null } }];
  }),
  deleteUploads('Delete Photo'),
  deleteUploads('Delete Photo (no match)'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Photo To Base64'], ['Photo To Base64', 'List All Games'], ['List All Games', 'Build Vision Request'],
  ['Build Vision Request', 'Ask Vision Model'], ['Ask Vision Model', 'Plan'], ['Plan', 'Identified?'],
  ['Identified?', 'Expansions To Add?', 0], ['Identified?', 'Delete Photo (no match)', 1], ['Delete Photo (no match)', 'Respond Error'],
  ['Expansions To Add?', 'Save Expansions', 0], ['Expansions To Add?', 'After Expansions', 1], ['Save Expansions', 'After Expansions'],
  ['After Expansions', 'New Games?'], ['New Games?', 'Create Records', 0], ['New Games?', 'Summary', 1],
  ['Create Records', 'One Item Per New Game'], ['One Item Per New Game', 'BGG Enrich'], ['BGG Enrich', 'Check BGG Duplicates'],
  ['Check BGG Duplicates', 'Remove Duplicates?'], ['Remove Duplicates?', 'Delete Duplicates', 0], ['Remove Duplicates?', 'After Duplicates', 1],
  ['Delete Duplicates', 'After Duplicates'], ['After Duplicates', 'Icons Needed?'],
  ['Icons Needed?', 'One Item Per Kept Game', 0], ['Icons Needed?', 'Summary', 1],
  ['One Item Per Kept Game', 'Assign Icon'], ['Assign Icon', 'Summary'],
  ['Summary', 'Delete Photo'], ['Delete Photo', 'Respond OK'],
], {
  // Photos must not outlive the request: never keep this workflow's executions (they'd hold the image)
  saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false,
});

// =====================================================================
// 7. Sync Plays  daily + POST /webhook/vault/sync-plays
//    Plays are logged in BG Stats, which posts them to BGG; this pulls them back per bggId.
// =====================================================================
const syncPlays = wf(ID.syncPlays, 'Vault — Sync Plays From BGG', [
  node('Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ triggerAtHour: 4 }] } }),
  webhook('Webhook', 'POST', 'vault/sync-plays', 'lastNode'),
  code('Options', function () {
    const username = '__BGG_USERNAME__';
    if (!username) throw new Error('BGG username not configured (BGG_USERNAME in n8n/deploy.sh)');
    return [{ json: { username } }];
  }),
  node('BGG Plays', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/plays',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ username: '={{ $json.username }}', type: 'thing', subtype: 'boardgame' }),
    options: {
      timeout: 30000,
      response: { response: { responseFormat: 'text', outputPropertyName: 'data' } },
      pagination: { pagination: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
        paginationCompleteWhen: 'other', completeExpression: '={{ !String($response.body).includes("<play ") }}',
        limitPagesFetched: true, maxRequests: 100, requestInterval: 2000,
      } },
    },
  }, { credentials: CRED.bgg, ...retry }),
  code('Tally Plays', function () {
    const byGame = {};
    let total = 0;
    for (const page of $input.all()) {
      const xml = String(page.json.data || '');
      for (const m of xml.matchAll(/<play id="\d+" date="([^"]*)" quantity="(\d+)"[^>]*>[\s\S]*?<item [^>]*objectid="(\d+)"/g)) {
        const [, date, qty, objectId] = m;
        const g = (byGame[objectId] ??= { count: 0, last: null });
        g.count += Number(qty) || 1;
        total += Number(qty) || 1;
        if (date && date !== '0000-00-00' && (!g.last || date > g.last)) g.last = date;
      }
    }
    return [{ json: { byGame, total, gamesPlayed: Object.keys(byGame).length } }];
  }),
  code('Parse Plays', function () {
    const unxml = (v) => String(v || '').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const attr = (tag, k) => { const m = tag.match(new RegExp('\\b' + k + '="([^"]*)"')); return m ? unxml(m[1]) : ''; };
    const plays = [];
    for (const page of $('BGG Plays').all()) {
      for (const p of String(page.json.data || '').match(/<play [\s\S]*?<\/play>/g) || []) {
        const head = p.match(/<play [^>]*>/)[0];
        const item = (p.match(/<item [^>]*>/) || [''])[0];
        plays.push({ id: Number(attr(head, 'id')), date: attr(head, 'date'), quantity: Number(attr(head, 'quantity')) || 1,
          minutes: Number(attr(head, 'length')) || 0, incomplete: attr(head, 'incomplete') === '1', location: attr(head, 'location'),
          bggId: Number(attr(item, 'objectid')), gameName: attr(item, 'name'), comments: unxml((p.match(/<comments>([\s\S]*?)<\/comments>/) || ['', ''])[1]).trim(),
          players: (p.match(/<player [^>]*\/?>/g) || []).map((t, i) => ({ seat: i + 1, name: attr(t, 'name') || attr(t, 'username') || 'Anonymous',
            user: attr(t, 'username'), win: attr(t, 'win') === '1', score: attr(t, 'score'), isNew: attr(t, 'new') === '1' })) });
      }
    }
    return [{ json: { plays: plays.filter((p) => p.id && p.bggId) } }];
  }),
  pg('Save Plays', 'SELECT at.save_plays($1, $2::jsonb) AS saved', "={{ ['__OWNER_EMAIL__', JSON.stringify($json.plays)] }}"),
  airtableListAll('List All Games'),
  code('Build Updates', function () {
    const { byGame, total, gamesPlayed } = $('Tally Plays').first().json;
    const games = $input.all().flatMap((i) => i.json.records || []).map(toGame);
    const changes = [];
    for (const g of games) {
      if (!g.bggId) continue;
      const p = { count: 0, last: null };
      for (const id of [g.bggId, ...g.extraBggIds]) {
        const x = byGame[String(id)];
        if (!x) continue;
        p.count += x.count;
        if (x.last && (!p.last || x.last > p.last)) p.last = x.last;
      }
      if ((g.playCount || 0) !== p.count || (g.lastPlayed || null) !== p.last) {
        changes.push({ id: g.recordId, fields: { [F.playCount]: p.count, [F.lastPlayed]: p.last } });
      }
    }
    const batches = [];
    for (let i = 0; i < changes.length; i += 10) batches.push({ json: { records: changes.slice(i, i + 10) } });
    const matched = games.filter((g) => g.bggId && [g.bggId, ...g.extraBggIds].some((id) => byGame[String(id)])).length;
    const summary = { totalPlays: total, gamesPlayedOnBgg: gamesPlayed, matchedInCollection: matched, updated: changes.length, stored: $('Save Plays').first().json.saved };
    return batches.length ? batches.map((b) => ({ json: { ...b.json, summary } })) : [{ json: { records: [], summary } }];
  }),
  ifTrue('Anything To Save?', '={{ $json.records.length > 0 }}'),
  airtable('Save Play Counts', 'PATCH', '', jsonBody('={{ JSON.stringify({ records: $json.records, typecast: true }) }}')),
  code('Result', function () {
    return [{ json: { ok: true, ...$('Build Updates').first().json.summary } }];
  }),
], [
  ['Daily', 'Options'], ['Webhook', 'Options'], ['Options', 'BGG Plays'], ['BGG Plays', 'Tally Plays'],
  ['Tally Plays', 'Parse Plays'], ['Parse Plays', 'Save Plays'], ['Save Plays', 'List All Games'], ['List All Games', 'Build Updates'], ['Build Updates', 'Anything To Save?'],
  ['Anything To Save?', 'Save Play Counts', 0], ['Anything To Save?', 'Result', 1], ['Save Play Counts', 'Result'],
]);

// =====================================================================
// 8. Photo Sweep  every 15 min: safety net for photo uploads left behind by a crashed identify run
// =====================================================================
const photoSweep = wf(ID.photoSweep, 'Vault — Photo Sweep', [
  node('Every 15 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
  node('Delete Old Uploads', 'n8n-nodes-base.code', 2, { jsCode: [
    "const fs = require('fs'), path = require('path');",
    "const dir = '" + N8N_STORAGE + "/workflows/" + ID.identify + "/executions';",
    "const cutoff = Date.now() - 10 * 60 * 1000;",
    "const old = (p) => { try { return fs.statSync(p).mtimeMs < cutoff; } catch (e) { return false; } };",
    "let removed = 0;",
    "const ls = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };",
    "// In-progress uploads live in temp/binary_data; finished runs get a folder named by execution id",
    "for (const f of ls(path.join(dir, 'temp', 'binary_data'))) {",
    "  const p = path.join(dir, 'temp', 'binary_data', f);",
    "  if (old(p)) { fs.rmSync(p, { force: true }); removed++; }",
    "}",
    "for (const e of ls(dir)) {",
    "  if (e === 'temp') continue;",
    "  const p = path.join(dir, e);",
    "  if (old(p)) { fs.rmSync(p, { recursive: true, force: true }); removed++; }",
    "}",
    "return [{ json: { removed } }];",
  ].join('\n') }),
], [['Every 15 Minutes', 'Delete Old Uploads']], { saveDataSuccessExecution: 'none' });

// =====================================================================
// 9. Search BGG  GET /webhook/vault/bgg-search?q=<title>
//    Candidates for "add by name": BGG search, then one thing call for primary names, type, thumbnail
//    and popularity. Ownership is flagged by the page, which already has the collection.
// =====================================================================
const bggSearch = wf(ID.bggSearch, 'Vault — Search BGG', [
  webhook('Webhook', 'GET', 'vault/bgg-search'),
  code('Validate', function () {
    const q = String(($input.first().json.query || {}).q || '').trim();
    if (q.length < 2 || q.length > 100) return [{ json: { ok: false, status: 400, message: 'Type 2-100 characters to search' } }];
    return [{ json: { ok: true, q } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  textGet('BGG Search', 'https://boardgamegeek.com/xmlapi2/search', qs({ query: '={{ $json.q }}', type: 'boardgame,boardgameexpansion' }), CRED.bgg),
  code('Pick Ids', function () {
    const xml = String($input.first().json.data || '');
    const q = normTitle($('Validate').first().json.q);
    const items = [...xml.matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => ({
      id: m[2], name: (m[3].match(/<name type="[^"]+" value="([^"]*)"/) || [])[1] || '',
    }));
    // Exact and prefix matches first; BGG returns the rest in no useful order
    const score = (i) => { const n = normTitle(i.name); return n === q ? 0 : n.startsWith(q) ? 1 : 2; };
    const ids = [...new Set(items.sort((a, b) => score(a) - score(b)).map((i) => i.id))].slice(0, 20);
    return [{ json: { ids: ids.join(','), found: ids.length > 0 } }];
  }),
  ifTrue('Any Results?', '={{ $json.found }}'),
  textGet('BGG Thing', 'https://boardgamegeek.com/xmlapi2/thing', qs({ id: '={{ $json.ids }}', stats: '1' }), CRED.bgg),
  code('Shape Results', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const xml = String($input.first().json.data || '');
    const q = normTitle($('Validate').first().json.q);
    const attr = (s, tag) => { const m = s.match(new RegExp('<' + tag + '\\s[^>]*value="([^"]*)"')); return m ? m[1] : null; };
    const results = [...xml.matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => {
      const s = m[3];
      const name = decode((s.match(/<name type="primary"[^>]*value="([^"]*)"/) || [])[1] || '');
      const base = [...s.matchAll(/<link type="boardgameexpansion" id="(\d+)" value="([^"]*)" inbound="true"/g)].map((b) => ({ id: Number(b[1]), title: decode(b[2]) }));
      const rank = (s.match(/<rank type="subtype"[^>]*name="boardgame"[^>]*value="(\d+)"/) || [])[1];
      return {
        bggId: Number(m[2]), title: name, year: Number(attr(s, 'yearpublished')) || null,
        kind: m[1] === 'boardgameexpansion' ? 'expansion' : 'game', expands: base,
        thumbnail: (s.match(/<thumbnail>([^<]+)<\/thumbnail>/) || [])[1] || null,
        rating: Math.round(Number(attr(s, 'average') || 0) * 10) / 10 || null,
        usersRated: Number(attr(s, 'usersrated') || 0), rank: rank ? Number(rank) : null,
      };
    });
    const score = (r) => { const n = normTitle(r.title); return n === q ? 0 : n.startsWith(q) ? 1 : 2; };
    results.sort((a, b) => score(a) - score(b) || b.usersRated - a.usersRated);
    return [{ json: { results: results.slice(0, 12) } }];
  }),
  code('No Results', function () { return [{ json: { results: [] } }]; }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'BGG Search', 0], ['Valid?', 'Respond Error', 1],
  ['BGG Search', 'Pick Ids'], ['Pick Ids', 'Any Results?'], ['Any Results?', 'BGG Thing', 0], ['Any Results?', 'No Results', 1],
  ['BGG Thing', 'Shape Results'], ['Shape Results', 'Respond OK'], ['No Results', 'Respond OK'],
]);

// =====================================================================
// 10. Add Game By Name  POST /webhook/vault/add { bggId } | { title }   (title only = not on BGG)
//     Same rules as the photo path: owned games are refused, an expansion of an owned game is appended
//     to that game, anything else is created, then BGG-enriched (cover, details, plays) and given an icon.
// =====================================================================
const addByName = wf(ID.addByName, 'Vault — Add Game By Name', [
  webhook('Webhook', 'POST', 'vault/add'),
  code('Validate', function () {
    const b = $input.first().json.body || {};
    const bggId = Number(b.bggId) || null;
    const title = String(b.title || '').trim().slice(0, 200);
    if (!bggId && !title) return [{ json: { ok: false, status: 400, message: 'Send a bggId, or a title for a game that is not on BGG' } }];
    return [{ json: { ok: true, bggId, title } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  airtableListAll('List All Games'),
  { ...textGet('BGG Thing', 'https://boardgamegeek.com/xmlapi2/thing',
    qs({ id: "={{ $('Validate').first().json.bggId || 0 }}", stats: '1' }), CRED.bgg), onError: 'continueRegularOutput' },
  code('Plan', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#10;/g, '\n');
    const v = $('Validate').first().json;
    const games = $('List All Games').all().flatMap((i) => i.json.records || []).map(toGame);
    let thing = null;
    if (v.bggId) {
      const xml = String($input.first().json.data || '');
      const m = xml.match(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/);
      if (!m) return [{ json: { action: 'error', status: 404, message: 'BGG has no game #' + v.bggId } }];
      const s = m[3];
      thing = {
        kind: m[1] === 'boardgameexpansion' ? 'expansion' : 'game',
        title: decode((s.match(/<name type="primary"[^>]*value="([^"]*)"/) || [])[1] || ''),
        base: [...s.matchAll(/<link type="boardgameexpansion" id="(\d+)" value="([^"]*)" inbound="true"/g)].map((b) => ({ id: Number(b[1]), title: decode(b[2]) })),
        description: decode((s.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '').replace(/\s+/g, ' ').slice(0, 1500),
        categories: [...s.matchAll(/<link type="boardgamecategory" id="\d+" value="([^"]*)"/g)].map((x) => decode(x[1])),
        mechanics: [...s.matchAll(/<link type="boardgamemechanic" id="\d+" value="([^"]*)"/g)].map((x) => decode(x[1])),
      };
    }
    const title = (thing && thing.title) || v.title;
    const key = normTitle(title);
    // Already owned: same BGG game, same title, or listed as an expansion
    const owned = (v.bggId && games.find((g) => Number(g.bggId) === v.bggId)) || games.find((g) => normTitle(g.title) === key);
    if (owned) return [{ json: { action: 'error', status: 409, message: `"${owned.title}" is already in your collection` } }];
    const listedIn = games.find((g) => g.expansions.some((e) => normTitle(e) === key));
    if (listedIn) return [{ json: { action: 'error', status: 409, message: `"${title}" is already listed as an expansion of ${listedIn.title}` } }];
    if (thing && thing.kind === 'expansion') {
      const baseIds = new Set(thing.base.map((b) => b.id));
      const base = games.find((g) => g.bggId && baseIds.has(Number(g.bggId)))
        || games.find((g) => thing.base.some((b) => normTitle(b.title) === normTitle(g.title)));
      if (base) {
        return [{ json: { action: 'expansion', title, base: base.title, record: { id: base.recordId,
          fields: { [F.expansions]: JSON.stringify([...base.expansions, title]), [F.updatedAt]: new Date().toISOString() } } } }];
      }
    }
    const num = Math.max(0, ...games.map((g) => Number(g.num) || 0)) + 1;
    const gameId = `name-g${num}`;
    const now = new Date().toISOString();
    return [{ json: { action: 'create', gameId, title, bggId: v.bggId, thing,
      fields: { [F.title]: title, [F.gameId]: gameId, [F.num]: num, [F.genre]: '', [F.type]: '', [F.desc]: '', [F.expansions]: '[]',
        [F.desireToPlay]: 0, [F.thinningCandidate]: false, [F.icon]: 'meeple', [F.addedAt]: now, [F.updatedAt]: now } } }];
  }),
  ifTrue('Create?', "={{ $json.action === 'create' }}"),
  ifTrue('Expansion?', "={{ $json.action === 'expansion' }}"),
  airtable('Save Expansion', 'PATCH', '', jsonBody('={{ JSON.stringify({ records: [$json.record], typecast: true }) }}')),
  code('Expansion Result', function () {
    const p = $('Plan').first().json;
    return [{ json: { ok: true, added: [], expansions: [{ title: p.title, base: p.base }], skipped: [] } }];
  }),
  // Genre / type / one-liner in the collection's style, from BGG's description (skipped for games not on BGG)
  code('Build Blurb Request', function () {
    const p = $input.first().json;
    if (!p.thing) return [{ json: { ...p, requestBody: null } }];
    const prompt = [
      `Board game: ${p.title}`,
      `BGG categories: ${p.thing.categories.join(', ')}`,
      `BGG mechanics: ${p.thing.mechanics.join(', ')}`,
      `BGG description: ${p.thing.description}`,
      '',
      'Write catalog fields in this collection\'s style. Reply with JSON only:',
      '{"genre": "theme/setting, 1-2 short labels joined by \\" / \\"", "type": "core mechanics, 1-2 labels joined by \\" / \\"", "desc": "one vivid sentence (max ~22 words) about what players do"}',
      'Style example: {"genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
    ].join('\n');
    return [{ json: { ...p, requestBody: { model: '__VISION_MODEL__', max_tokens: 2000, reasoning: { effort: 'low' }, provider: { data_collection: 'deny' },
      messages: [{ role: 'user', content: prompt }] } } }];
  }),
  ifTrue('On BGG?', '={{ !!$json.requestBody }}'),
  { ...openrouter('Ask AI For Blurb'), onError: 'continueRegularOutput' },
  code('Add Blurb', function () {
    const p = $('Build Blurb Request').first().json;
    let r = {};
    if ($('Ask AI For Blurb').isExecuted) {
      const text = $input.first().json.choices?.[0]?.message?.content || '';
      try { r = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
    }
    const fields = { ...p.fields, [F.genre]: String(r.genre || ''), [F.type]: String(r.type || ''), [F.desc]: String(r.desc || '') };
    return [{ json: { ...p, fields } }];
  }),
  airtable('Create Record', 'POST', '', jsonBody('={{ JSON.stringify({ records: [{ fields: $json.fields }], typecast: true }) }}')),
  code('Enrich Input', function () {
    const p = $('Add Blurb').first().json;
    return [{ json: { id: p.gameId, ...(p.bggId ? { bggId: p.bggId } : {}) } }];
  }),
  ifTrue('Enrich?', '={{ !!$json.bggId }}'),
  execSub('BGG Enrich', ID.bggOne),
  code('Icon Input', function () { return [{ json: { id: $('Add Blurb').first().json.gameId } }]; }),
  execSub('Assign Icon', ID.iconOne),
  code('Created Result', function () {
    const p = $('Add Blurb').first().json;
    return [{ json: { ok: true, added: [{ id: p.gameId, title: p.title }], expansions: [], skipped: [], title: p.title } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'List All Games', 0], ['Valid?', 'Respond Error', 1],
  ['List All Games', 'BGG Thing'], ['BGG Thing', 'Plan'], ['Plan', 'Create?'],
  ['Create?', 'Build Blurb Request', 0], ['Create?', 'Expansion?', 1],
  ['Expansion?', 'Save Expansion', 0], ['Expansion?', 'Respond Error', 1],
  ['Save Expansion', 'Expansion Result'], ['Expansion Result', 'Respond OK'],
  ['Build Blurb Request', 'On BGG?'], ['On BGG?', 'Ask AI For Blurb', 0], ['On BGG?', 'Add Blurb', 1], ['Ask AI For Blurb', 'Add Blurb'],
  ['Add Blurb', 'Create Record'], ['Create Record', 'Enrich Input'], ['Enrich Input', 'Enrich?'],
  ['Enrich?', 'BGG Enrich', 0], ['Enrich?', 'Icon Input', 1], ['BGG Enrich', 'Icon Input'],
  ['Icon Input', 'Assign Icon'], ['Assign Icon', 'Created Result'], ['Created Result', 'Respond OK'],
]);

// =====================================================================
// Sign-in gate: every webhook that changes something checks the caller's Google ID token first.
// The page sends it as "Authorization: Bearer <id token>"; Google's tokeninfo endpoint verifies the
// signature and expiry, then we require our client ID and an owner email. Sub-workflow calls
// (executeWorkflowTrigger) are internal and skip the gate.
//   mode 'respond': failure is routed to failTo (a Respond node path) with status 401
//   mode 'throw':   for lastNode webhooks, failure throws so nothing runs
// =====================================================================
function addAuth(w, { mode, failTo }) {
  const conns = w.connections;
  const targets = conns.Webhook.main[0];
  const at = (dx) => { const p = w.nodes.find((n) => n.name === 'Webhook').position; return [p[0] + dx, p[1] + 200]; };
  const readToken = node('Auth: Read Token', 'n8n-nodes-base.code', 2, { jsCode: [
    "const h = $input.first().json.headers || {};",
    "const a = String(h.authorization || '');",
    "return [{ json: { token: a.startsWith('Bearer ') ? a.slice(7).trim() : '' } }];",
  ].join('\n') });
  const tokeninfo = node('Auth: Verify With Google', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://oauth2.googleapis.com/tokeninfo',
    ...qs({ id_token: "={{ $json.token || 'missing' }}" }), options: { timeout: 10000 },
  }, { onError: 'continueRegularOutput' });
  const check = node('Auth: Check Owner', 'n8n-nodes-base.code', 2, { jsCode: [
    "const info = $input.first().json || {};",
    "const owners = '" + OWNER_EMAILS.join(',') + "'.split(',');",
    "const ok = info.aud === '" + GOOGLE_CLIENT_ID + "'",
    "  && owners.includes(String(info.email || '').toLowerCase())",
    "  && (info.email_verified === true || info.email_verified === 'true')",
    "  && Number(info.exp) * 1000 > Date.now();",
    mode === 'throw'
      ? "if (!ok) throw new Error('Sign in as the collection owner to make changes');"
      : "if (!ok) return [{ json: { ok: false, status: 401, message: 'Sign in as the collection owner to make changes' } }];",
    "// Hand the original webhook items (body, query, uploaded files) to the rest of the workflow",
    "return $('Webhook').all().map((i) => ({ ...i, json: { ...i.json, _authOk: true } }));",
  ].join('\n') });
  [readToken, tokeninfo, check].forEach((n, i) => { n.position = at(220 * (i + 1)); });
  w.nodes.push(readToken, tokeninfo, check);
  conns.Webhook = { main: [[{ node: readToken.name, type: 'main', index: 0 }]] };
  conns[readToken.name] = { main: [[{ node: tokeninfo.name, type: 'main', index: 0 }]] };
  conns[tokeninfo.name] = { main: [[{ node: check.name, type: 'main', index: 0 }]] };
  if (mode === 'throw') { conns[check.name] = { main: [targets] }; return w; }
  const gate = ifTrue('Signed In?', '={{ $json._authOk === true }}');
  gate.position = at(220 * 4);
  w.nodes.push(gate);
  conns[check.name] = { main: [[{ node: gate.name, type: 'main', index: 0 }]] };
  conns[gate.name] = { main: [targets, [{ node: failTo, type: 'main', index: 0 }]] };
  return w;
}
// =====================================================================
// Member sign-in gate: like addAuth, but besides the owner it accepts friends whose Google email is
// on a player card (rating-only features). Downstream nodes get json._auth = { role, playerId, playerName }.
// =====================================================================
function addMemberAuth(w, { failTo }) {
  const conns = w.connections;
  const targets = conns.Webhook.main[0];
  const p0 = w.nodes.find((n) => n.name === 'Webhook').position;
  const at = (i) => [p0[0] + 220 * i, p0[1] + 200];
  const readToken = node('Auth: Read Token', 'n8n-nodes-base.code', 2, { jsCode: [
    "const h = $input.first().json.headers || {};",
    "const a = String(h.authorization || '');",
    "return [{ json: { token: a.startsWith('Bearer ') ? a.slice(7).trim() : '' } }];",
  ].join('\n') });
  const tokeninfo = node('Auth: Verify With Google', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://oauth2.googleapis.com/tokeninfo',
    ...qs({ id_token: "={{ $json.token || 'missing' }}" }), options: { timeout: 10000 },
  }, { onError: 'continueRegularOutput' });
  const checkToken = node('Auth: Check Token', 'n8n-nodes-base.code', 2, { jsCode: [
    "const info = $input.first().json || {};",
    "const owners = '" + OWNER_EMAILS.join(',') + "'.split(',');",
    "const email = String(info.email || '').toLowerCase();",
    "const ok = info.aud === '" + GOOGLE_CLIENT_ID + "'",
    "  && (info.email_verified === true || info.email_verified === 'true')",
    "  && Number(info.exp) * 1000 > Date.now() && !!email;",
    "if (!ok) return [{ json: { ok: false, status: 401, message: 'Sign in to do that' } }];",
    "return [{ json: { ok: true, email, owner: owners.includes(email) } }];",
  ].join('\n') });
  const tokenOk = ifTrue('Token Valid?', '={{ $json.ok === true }}');
  // Members are the people on the invite list; their card in Dan's people (if he plays with them) links their ratings there
  const findPlayer = pg('Auth: Find Player', 'SELECT bgc.sign_in($1) AS r', '={{ [$json.email] }}');
  const role = code('Auth: Role', function () {
    const t = $('Auth: Check Token').first().json;
    const m = $input.first().json.r || {};
    const role = t.owner ? 'owner' : m.member ? 'friend' : null;
    if (!role) return [{ json: { ok: false, status: 401, message: 'This account can view only' } }];
    const auth = { role, email: t.email, memberId: m.id || null, admin: !!m.isAdmin || !!t.owner, playerId: m.playerId || null, playerName: m.playerName || null };
    return $('Webhook').all().map((i) => ({ ...i, json: { ...i.json, _authOk: true, _auth: auth } }));
  });
  const member = ifTrue('Member?', '={{ $json._authOk === true }}');
  [readToken, tokeninfo, checkToken, tokenOk, findPlayer, role, member].forEach((n, i) => { n.position = at(i + 1); });
  w.nodes.push(readToken, tokeninfo, checkToken, tokenOk, findPlayer, role, member);
  const to = (name) => ({ node: name, type: 'main', index: 0 });
  conns.Webhook = { main: [[to(readToken.name)]] };
  conns[readToken.name] = { main: [[to(tokeninfo.name)]] };
  conns[tokeninfo.name] = { main: [[to(checkToken.name)]] };
  conns[checkToken.name] = { main: [[to(tokenOk.name)]] };
  conns[tokenOk.name] = { main: [[to(findPlayer.name)], [to(failTo)]] };
  conns[findPlayer.name] = { main: [[to(role.name)]] };
  conns[role.name] = { main: [[to(member.name)]] };
  conns[member.name] = { main: [targets, [to(failTo)]] };
  return w;
}

// =====================================================================
// 11. Who Am I  GET /webhook/vault/whoami  (member gate)
//     Right after Google sign-in: owner → full editing; friend → can rate for themselves; 401 → view-only.
// =====================================================================
const whoAmI = wf(ID.whoAmI, 'Vault — Who Am I', [
  webhook('Webhook', 'GET', 'vault/whoami'),
  respond('Respond OK', "={{ JSON.stringify({ ok: true, role: $json._auth.role, owner: $json._auth.role === 'owner', playerId: $json._auth.playerId, playerName: $json._auth.playerName, admin: !!$json._auth.admin }) }}"),
  respondError(),
], [['Webhook', 'Respond OK']]);
addMemberAuth(whoAmI, { failTo: 'Respond Error' });

// =====================================================================
// 12. People  GET /webhook/vault/people[?shelf=mine]  (member gate: names and play history are for the group, not visitors)
//     shelf=mine: the member's own player list (from their plays) and ratings, for their own shelf.
//     Player profiles (no emails) + every rating, resolved to one per person per game by source priority.
// =====================================================================
const people = wf(ID.people, 'Vault — People', [
  webhook('Webhook', 'GET', 'vault/people'),
  pg('Shelf View', "SELECT v, bgc.my_ratings_on($1, (v ->> 'ownerId')::bigint) AS mine FROM (SELECT bgc.shelf_view($1, $2, $3) AS v) q",
    "={{ [$json._auth.email, /^(mine|friend:\\d+)$/.test(String(($json.query || {}).shelf || '')) ? String($json.query.shelf) : 'main', $json._auth.playerId] }}"),
  code('List Players', function () { return [{ json: { records: $input.first().json.v.players } }]; }),
  code('One Item', function () { return [{ json: {} }]; }),
  code('List Ratings', function () { return [{ json: { records: $('Shelf View').first().json.v.ratings } }]; }),
  pg('Asks Used', 'SELECT bgc.asks_used($1) AS used, bgc.ask_limit() AS lim', "={{ [$('Auth: Role').first().json._auth.email] }}"),
  code('Shape People', function () {
    const players = $('List Players').all().flatMap((i) => i.json.records || []).map(toPlayer).map(publicPlayer)
      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    const best = {}; // gameId -> playerId -> { stars (their BGC rating), bgg (their BGG rating, /10) }
    for (const e of Object.values(ratingsByPlayerGame($('List Ratings').all().flatMap((i) => i.json.records || []).map(toRating)))) {
      (best[e.gameId] ??= {})[e.playerId] = { ...(e.stars ? { stars: e.stars } : {}), ...(e.bgg ? { bgg: e.bgg } : {}) };
    }
    const sv = $('Shelf View').first().json.v;
    // me: the signed-in member's card in this list (their own BGC stars show under "Your rating")
    const used = Number($('Asks Used').first().json.used) || 0;
    const lim = Number($('Asks Used').first().json.lim) || __ASK_PER_MEMBER__;
    // owner: the shelf owner's card, whose stars show on the game cards
    // mine: your own stars for this shelf's games (yours wherever the copy sits)
    return [{ json: { players, ratings: best, me: sv.askerKey || null, owner: sv.ownerKey || null, mine: $('Shelf View').first().json.mine || {}, shelf: sv.shelf, asks: { limit: lim, left: Math.max(0, lim - used) } } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Shelf View'], ['Shelf View', 'List Players'], ['List Players', 'One Item'], ['One Item', 'List Ratings'], ['List Ratings', 'Asks Used'], ['Asks Used', 'Shape People'], ['Shape People', 'Respond OK']]);
addMemberAuth(people, { failTo: 'Respond Error' });

// =====================================================================
// 13. Rate Game  POST /webhook/vault/rate { gameId, stars (0 clears) }  (member gate)
//     Everyone rates only for themselves (source "site"); nobody rates on someone else's behalf.
// =====================================================================
const rate = wf(ID.rate, 'Vault — Rate Game', [
  webhook('Webhook', 'POST', 'vault/rate'),
  code('Validate', function () {
    const j = $input.first().json;
    const b = j.body || {};
    const err = (status, message) => [{ json: { ok: false, status, message } }];
    const gameId = String(b.gameId || '').trim();
    const stars = Math.round(Number(b.stars) * 2) / 2;
    if (!gameId) return err(400, 'Missing gameId');
    if (!(stars >= 0 && stars <= 5)) return err(400, 'stars must be 0-5 (0 clears your rating)');
    // Everyone rates only for themselves: the rating belongs to the signed-in member's own account
    return [{ json: { ok: true, email: j._auth.email, gameId, stars } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Save Rating', 'SELECT bgc.rate($1, $2, $3::numeric) AS r', '={{ [$json.email, $json.gameId, String($json.stars)] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Saved?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Save Rating', 0], ['Valid?', 'Respond Error', 1],
  ['Save Rating', 'Result'], ['Result', 'Saved?'], ['Saved?', 'Respond OK', 0], ['Saved?', 'Respond Error', 1],
]);
addMemberAuth(rate, { failTo: 'Respond Error' });

// =====================================================================
// 14. Save Player  POST /webhook/vault/player-save { id?, name, aliases[], active, googleEmail, bggUsername }  (owner only)
//     Bookkeeping only: a person's taste profile is theirs to fill in (see /me).
// =====================================================================
const playerSave = wf(ID.playerSave, 'Vault — Save Player', [
  webhook('Webhook', 'POST', 'vault/player-save'),
  code('Validate', function () {
    const b = $input.first().json.body || {};
    const err = (message) => [{ json: { ok: false, status: 400, message } }];
    const name = String(b.name || '').trim();
    if (!name) return err('A player needs a name');
    const text = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
    const email = text(b.googleEmail, 200).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('That Google email doesn’t look right');
    const fields = {
      [PF.name]: name.slice(0, 100),
      [PF.aliases]: (Array.isArray(b.aliases) ? b.aliases : String(b.aliases || '').split(',')).map((a) => String(a).trim()).filter(Boolean).join(', '),
      [PF.active]: !!b.active, [PF.googleEmail]: email || null, [PF.bggUsername]: text(b.bggUsername, 100) || null,
      [PF.updatedAt]: new Date().toISOString(),
    };
    const id = /^rec[A-Za-z0-9]{14}$/.test(String(b.id || '')) ? b.id : null;
    return [{ json: { ok: true, id, fields } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  ifTrue('Existing?', '={{ !!$json.id }}'),
  airtable('Update Player', 'PATCH', '/{{ $json.id }}', jsonBody('={{ JSON.stringify({ fields: $json.fields, typecast: true, returnFieldsByFieldId: true }) }}'), {}, PLAYERS_TABLE),
  airtable('Create Player', 'POST', '', jsonBody('={{ JSON.stringify({ fields: $json.fields, typecast: true, returnFieldsByFieldId: true }) }}'), {}, PLAYERS_TABLE),
  code('Shape Player', function () { return [{ json: { ok: true, player: toPlayer($input.first().json) } }]; }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Existing?', 0], ['Valid?', 'Respond Error', 1],
  ['Existing?', 'Update Player', 0], ['Existing?', 'Create Player', 1],
  ['Update Player', 'Shape Player'], ['Create Player', 'Shape Player'], ['Shape Player', 'Respond OK'],
]);
addAuth(playerSave, { mode: 'respond', failTo: 'Respond Error' });

// =====================================================================
// 15. Players Admin  GET /webhook/vault/players-admin  (owner only): full profiles incl. emails
// =====================================================================
const playersAdmin = wf(ID.playersAdmin, 'Vault — Players Admin', [
  webhook('Webhook', 'GET', 'vault/players-admin'),
  airtableListAll('List Players', PLAYERS_TABLE),
  code('Shape Players', function () {
    const players = $input.all().flatMap((i) => i.json.records || []).map(toPlayer)
      .map(({ history, ...p }) => ({ ...p, games: Object.keys(history).length, plays: Object.values(history).reduce((n, h) => n + (h.plays || 0), 0) }))
      .sort((a, b) => (b.active - a.active) || (b.plays - a.plays) || a.name.localeCompare(b.name));
    return [{ json: { players } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'List Players'], ['List Players', 'Shape Players'], ['Shape Players', 'Respond OK']]);
addAuth(playersAdmin, { mode: 'respond', failTo: 'Respond Error' });

// =====================================================================
// 16. BGG User Ratings (sub-workflow) { playerId, username } -> { playerId, ratings: [{ bggId, rating10 }] }
//     BGG's collection API answers 202 "queued" until it has built the list, so retry twice with waits.
// =====================================================================
const bggCollectionGet = (name) => node(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/collection',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  ...qs({ username: "={{ $('When Called By Another Workflow').first().json.username }}", rated: '1', stats: '1', subtype: 'boardgame' }),
  options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'data' } } },
}, { credentials: CRED.bgg });
const collectionReady = (name) => ifTrue(name, "={{ $json.statusCode === 200 && String($json.data || '').includes('<items') }}");
const bggUserRatings = wf(ID.bggUserRatings, 'Vault — BGG User Ratings', [
  subTrigger(),
  bggCollectionGet('Fetch Collection'),
  collectionReady('Ready?'),
  wait('Wait 8s', 8),
  bggCollectionGet('Fetch Again'),
  collectionReady('Ready Now?'),
  wait('Wait 20s', 20),
  bggCollectionGet('Fetch Last Time'),
  code('Parse Ratings', function () {
    const t = $('When Called By Another Workflow').first().json;
    const xml = String($input.first().json.data || '');
    const ratings = [...xml.matchAll(/<item objecttype="thing" objectid="(\d+)"[\s\S]*?<rating value="([\d.]+)"/g)]
      .map((m) => ({ bggId: Number(m[1]), rating10: Number(m[2]) })).filter((r) => r.rating10 > 0);
    return [{ json: { playerId: t.playerId, username: t.username, ok: xml.includes('<items'), ratings } }];
  }),
], [
  ['When Called By Another Workflow', 'Fetch Collection'], ['Fetch Collection', 'Ready?'],
  ['Ready?', 'Parse Ratings', 0], ['Ready?', 'Wait 8s', 1], ['Wait 8s', 'Fetch Again'], ['Fetch Again', 'Ready Now?'],
  ['Ready Now?', 'Parse Ratings', 0], ['Ready Now?', 'Wait 20s', 1], ['Wait 20s', 'Fetch Last Time'], ['Fetch Last Time', 'Parse Ratings'],
]);

// =====================================================================
// 17. Sync People  daily 4:20 + POST /webhook/vault/sync-people  (owner)
//     From BGG plays (logged in BG Stats): each person's history per owned game (plays, wins, last),
//     a player card for anyone with 3+ plays, and BG Stats per-play ratings. Then friends' BGG ratings.
//     Ratings are stored 1-5 (BGG/BG Stats 1-10 halved, to the nearest half star).
// =====================================================================
const upsertRatings = (name) => airtable(name, 'PATCH', '', jsonBody("={{ JSON.stringify({ performUpsert: { fieldsToMergeOn: ['fldSVVMwQygNrpyBm'] }, records: $json.records, typecast: true }) }}"), {}, RATINGS_TABLE);
const syncPeople = wf(ID.syncPeople, 'Vault — Sync People', [
  node('Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ triggerAtHour: 4, triggerAtMinute: 20 }] } }),
  webhook('Webhook', 'POST', 'vault/sync-people', 'lastNode'),
  code('Options', function () { return [{ json: { username: '__BGG_USERNAME__' } }]; }),
  node('BGG Plays', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/plays',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ username: '={{ $json.username }}', type: 'thing', subtype: 'boardgame' }),
    options: {
      timeout: 30000,
      response: { response: { responseFormat: 'text', outputPropertyName: 'data' } },
      pagination: { pagination: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
        paginationCompleteWhen: 'other', completeExpression: '={{ !String($response.body).includes("<play ") }}',
        limitPagesFetched: true, maxRequests: 100, requestInterval: 2000,
      } },
    },
  }, { credentials: CRED.bgg, ...retry }),
  code('Tally People', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const people = {}; // lowercased name -> { name, total, games: { bggId: { plays, wins, last, ratings: [] } } }
    for (const page of $input.all()) {
      for (const m of String(page.json.data || '').matchAll(/<play id="\d+" date="([^"]*)" quantity="(\d+)"[^>]*>([\s\S]*?)<\/play>/g)) {
        const [, date, qty, inner] = m;
        const bggId = (inner.match(/objectid="(\d+)"/) || [])[1];
        if (!bggId) continue;
        for (const pm of inner.matchAll(/<player ([^>]*)\/>/g)) {
          const a = Object.fromEntries([...pm[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
          const name = (a.name || a.username || '').trim();
          if (!name || /^anonymous/i.test(name)) continue;
          const p = (people[name.toLowerCase()] ??= { name, total: 0, games: {} });
          const g = (p.games[bggId] ??= { plays: 0, wins: 0, last: null, ratings: [] });
          const n = Number(qty) || 1;
          g.plays += n; p.total += n;
          if (a.win === '1') g.wins += n;
          if (date && date !== '0000-00-00' && (!g.last || date > g.last)) g.last = date;
          if (Number(a.rating) > 0) g.ratings.push(Number(a.rating));
        }
      }
    }
    return [{ json: { people } }];
  }),
  airtableListAll('List Games'),
  code('One Item', function () { return [{ json: {} }]; }),
  airtableListAll('List Players', PLAYERS_TABLE),
  code('Plan New Players', function () {
    const { people } = $('Tally People').first().json;
    const known = new Set($input.all().flatMap((i) => i.json.records || []).map(toPlayer).flatMap(playerNames));
    const creates = Object.values(people).filter((p) => p.total >= 1 && !known.has(p.name.toLowerCase())) // everyone you've played with
      .map((p) => ({ fields: { [PF.name]: p.name, [PF.active]: p.total >= 10, [PF.updatedAt]: new Date().toISOString() } }));
    const batches = [];
    for (let i = 0; i < creates.length; i += 10) batches.push({ json: { records: creates.slice(i, i + 10) } });
    return batches.length ? batches : [{ json: { records: [] } }];
  }),
  ifTrue('New Players?', '={{ $json.records.length > 0 }}'),
  airtable('Create Players', 'POST', '', jsonBody('={{ JSON.stringify({ records: $json.records, typecast: true }) }}'), {}, PLAYERS_TABLE),
  pg('Link New Players', "SELECT at.save_plays($1, '[]'::jsonb) AS linked", "={{ ['__OWNER_EMAIL__'] }}"),
  code('One Item Again', function () { return [{ json: {} }]; }),
  airtableListAll('Reload Players', PLAYERS_TABLE),
  code('Build Updates', function () {
    const { people } = $('Tally People').first().json;
    const games = $('List Games').all().flatMap((i) => i.json.records || []).map(toGame);
    const gameIdByBgg = Object.fromEntries(games.filter((g) => g.bggId).map((g) => [String(g.bggId), g.id]));
    const primaryBgg = {}; // any BGG id we count (own or extra edition) -> the game's own BGG id
    for (const g of games) if (g.bggId) for (const id of [g.bggId, ...g.extraBggIds]) primaryBgg[String(id)] ??= String(g.bggId);
    const players = $input.all().flatMap((i) => i.json.records || []).map(toPlayer);
    const now = new Date().toISOString();
    const playerRecords = [], ratingRecords = [];
    for (const pl of players) {
      const names = playerNames(pl);
      const merged = {};
      for (const n of names) for (const [bggId, g] of Object.entries((people[n] || {}).games || {})) {
        const own = primaryBgg[bggId];
        if (!own) continue; // only games in the collection
        const m = (merged[own] ??= { plays: 0, wins: 0, last: null, ratings: [] });
        m.plays += g.plays; m.wins += g.wins; m.ratings.push(...g.ratings);
        if (g.last && (!m.last || g.last > m.last)) m.last = g.last;
      }
      const history = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, { plays: v.plays, wins: v.wins, last: v.last }]));
      if (JSON.stringify(history) !== JSON.stringify(pl.history)) playerRecords.push({ id: pl.id, fields: { [PF.playHistory]: JSON.stringify(history), [PF.updatedAt]: now } });
    }
    const batch = (list) => { const out = []; for (let i = 0; i < list.length; i += 10) out.push(list.slice(i, i + 10)); return out; };
    return [{ json: { playerBatches: batch(playerRecords), ratingBatches: batch(ratingRecords),
      bggUsers: players.filter((p) => p.bggUsername).map((p) => ({ playerId: p.id, username: p.bggUsername })),
      gameIdByBgg, summary: { people: Object.keys(people).length, players: players.length, historiesUpdated: playerRecords.length, bgstatsRatings: ratingRecords.length } } }];
  }),
  code('Player Batches', function () {
    const b = $input.first().json.playerBatches;
    return b.length ? b.map((records) => ({ json: { records } })) : [{ json: { records: [] } }];
  }),
  ifTrue('Histories To Save?', '={{ $json.records.length > 0 }}'),
  airtable('Save Histories', 'PATCH', '', jsonBody('={{ JSON.stringify({ records: $json.records, typecast: true }) }}'), {}, PLAYERS_TABLE),
  code('Rating Batches', function () {
    const b = $('Build Updates').first().json.ratingBatches;
    return b.length ? b.map((records) => ({ json: { records } })) : [{ json: { records: [] } }];
  }),
  ifTrue('BG Stats Ratings?', '={{ $json.records.length > 0 }}'),
  upsertRatings('Save BG Stats Ratings'),
  code('BGG Users', function () {
    const u = $('Build Updates').first().json.bggUsers;
    return u.length ? u.map((x) => ({ json: x })) : [{ json: { none: true } }];
  }),
  ifTrue('Any BGG Users?', '={{ !$json.none }}'),
  execSub('Fetch BGG Ratings', ID.bggUserRatings),
  code('BGG Rating Batches', function () {
    const { gameIdByBgg } = $('Build Updates').first().json;
    const now = new Date().toISOString();
    const recs = [];
    for (const r of $input.all().map((i) => i.json)) {
      for (const x of r.ratings || []) {
        const gameId = gameIdByBgg[String(x.bggId)];
        if (!gameId || !r.playerId) continue;
        recs.push({ fields: { [RF.key]: `${r.playerId}|${gameId}|bgg`, [RF.playerId]: r.playerId, [RF.gameId]: gameId,
          [RF.stars]: Math.round(x.rating10) / 2, [RF.source]: 'bgg', [RF.updatedAt]: now } });
      }
    }
    const out = [];
    for (let i = 0; i < recs.length; i += 10) out.push({ json: { records: recs.slice(i, i + 10) } });
    return out.length ? out : [{ json: { records: [] } }];
  }),
  ifTrue('BGG Ratings?', '={{ $json.records.length > 0 }}'),
  upsertRatings('Save BGG Ratings'),
  code('Result', function () {
    const s = $('Build Updates').first().json.summary;
    const created = $('Create Players').isExecuted ? $('Create Players').all().flatMap((i) => i.json.records || []).length : 0;
    const bgg = $('BGG Rating Batches').isExecuted ? $('BGG Rating Batches').all().reduce((n, i) => n + i.json.records.length, 0) : 0;
    return [{ json: { ok: true, ...s, playersCreated: created, bggRatings: bgg } }];
  }),
], [
  ['Daily', 'Options'], ['Webhook', 'Options'], ['Options', 'BGG Plays'], ['BGG Plays', 'Tally People'],
  ['Tally People', 'List Games'], ['List Games', 'One Item'], ['One Item', 'List Players'], ['List Players', 'Plan New Players'],
  ['Plan New Players', 'New Players?'], ['New Players?', 'Create Players', 0], ['New Players?', 'One Item Again', 1],
  ['Create Players', 'Link New Players'], ['Link New Players', 'One Item Again'], ['One Item Again', 'Reload Players'], ['Reload Players', 'Build Updates'],
  ['Build Updates', 'Player Batches'], ['Player Batches', 'Histories To Save?'],
  ['Histories To Save?', 'Save Histories', 0], ['Histories To Save?', 'Rating Batches', 1], ['Save Histories', 'Rating Batches'],
  ['Rating Batches', 'BG Stats Ratings?'], ['BG Stats Ratings?', 'Save BG Stats Ratings', 0], ['BG Stats Ratings?', 'BGG Users', 1],
  ['Save BG Stats Ratings', 'BGG Users'], ['BGG Users', 'Any BGG Users?'], ['Any BGG Users?', 'Fetch BGG Ratings', 0], ['Any BGG Users?', 'Result', 1],
  ['Fetch BGG Ratings', 'BGG Rating Batches'], ['BGG Rating Batches', 'BGG Ratings?'],
  ['BGG Ratings?', 'Save BGG Ratings', 0], ['BGG Ratings?', 'Result', 1], ['Save BGG Ratings', 'Result'],
]);
addAuth(syncPeople, { mode: 'throw' });

addAuth(update, { mode: 'respond', failTo: 'Respond Error' });
addAuth(del, { mode: 'respond', failTo: 'Respond Error' });
addAuth(identify, { mode: 'respond', failTo: 'Delete Photo (no match)' }); // drop the upload, then 401
addMemberAuth(bggSearch, { failTo: 'Respond Error' }); // any member can search BGG (it only reads)
addAuth(addByName, { mode: 'respond', failTo: 'Respond Error' });
addAuth(iconOne, { mode: 'throw' });
addAuth(bggOne, { mode: 'throw' });
addAuth(syncPlays, { mode: 'throw' });

// =====================================================================
// 18. Ask  POST /webhook/vault/ask { question, playerIds?: [], previous?: { question, constraints, pickIds } }  (member gate, 30 a day each)
//     "What should we play?" (or "what sci-fi games do I have?") for this shelf and these people:
//       1. a small model turns the question into constraints + who is playing
//       2. code applies the hard limits (players, time, age, weight, exclusions) and scores a shortlist
//       3. a stronger model picks from the shortlist using profiles, play history and ratings
//       4. code drops anything that isn't on the shortlist
//     Members only, 30 questions each per day (plus a shared safety cap); board games only.
// =====================================================================
const ASK_DAILY_CAP = 200;
const ASK_PER_MEMBER = 30; // Nathan's questions per member per day
const OWNER_NAME = 'Dan';
const ask = wf(ID.ask, 'Vault — Ask Nathan', [
  webhook('Webhook', 'POST', 'vault/ask'),
  code('Validate', function () {
    const b = $input.first().json.body || {};
    const err = (status, message) => [{ json: { ok: false, status, message } }];
    const question = String(b.question || '').trim();
    if (question.length < 3) return err(400, 'Ask a question, like "a co-op for 3 under an hour".');
    if (question.length > 500) return err(400, 'Keep the question under 500 characters.');
    // Safety net across everyone (the per-member allowance is checked next, in the database)
    const st = $getWorkflowStaticData('global');
    const today = new Date().toISOString().slice(0, 10);
    if (st.day !== today) { st.day = today; st.count = 0; }
    if (st.count >= __ASK_DAILY_CAP__) return err(429, 'Ask has answered a lot of questions today. Try again tomorrow.');
    st.count += 1;
    const playerIds = Array.isArray(b.playerIds) ? b.playerIds.map(String).filter((x) => /^rec[A-Za-z0-9]{14}$/.test(x)).slice(0, 12) : [];
    const prev = b.previous && typeof b.previous === 'object' ? {
      question: String(b.previous.question || '').slice(0, 500),
      constraints: b.previous.constraints && typeof b.previous.constraints === 'object' ? b.previous.constraints : null,
      pickIds: Array.isArray(b.previous.pickIds) ? b.previous.pickIds.map(String).slice(0, 6) : [],
      setIds: Array.isArray(b.previous.setIds) ? b.previous.setIds.map(String).filter((x) => x.length < 40).slice(0, 60) : [],
      fromOwn: b.previous.fromOwn === true,
    } : null;
    const mentioned = Array.isArray(b.mentioned) ? b.mentioned.map(String).filter((x) => x.length < 40).slice(0, 100) : [];
    const auth = $input.first().json._auth;
    return [{ json: { ok: true, t0: Date.now(), question, playerIds, previous: prev, mentioned, email: auth.email, askerId: auth.playerId || null, askerName: auth.playerName || '',
      shelf: /^friend:\d+$/.test(String(b.shelf || '')) ? String(b.shelf) : b.shelf === 'mine' ? 'mine' : 'main' } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Use Allowance', 'SELECT bgc.use_ask($1) AS questions, bgc.ask_limit() AS lim',
    '={{ [$json.email] }}'),
  code('Allowance Left?', function () {
    const used = Number($input.first().json.questions) || 0;
    const lim = Number($input.first().json.lim) || __ASK_PER_MEMBER__;
    if (used > lim) return [{ json: { ok: false, status: 429, message: 'Nathan has answered your ' + lim + ' questions for today. He’ll be back at the shelves tomorrow!' } }];
    return [{ json: { ok: true, used } }];
  }),
  ifTrue('Allowed?', '={{ $json.ok }}'),
  // Dan's shelf, or the member's own: its games, its owner's player list (from their plays) and ratings
  pg('Shelf View', 'SELECT bgc.shelf_view($1, $2, $3) AS v',
    "={{ [$('Validate').first().json.email, $('Validate').first().json.shelf, $('Validate').first().json.askerId] }}"),
  code('List Games', function () { return [{ json: { records: $input.first().json.v.games } }]; }),
  code('One Item', function () { return [{ json: {} }]; }),
  code('List Players', function () { return [{ json: { records: $('Shelf View').first().json.v.players } }]; }),
  code('One More Item', function () { return [{ json: {} }]; }),
  code('List Ratings', function () { return [{ json: { records: $('Shelf View').first().json.v.ratings } }]; }),
  code('Build Understand Request', function () {
    const v = $('Validate').first().json;
    const sv = $('Shelf View').first().json.v;
    const askerId = sv.askerPerson || sv.askerKey || null;
    const players = $('List Players').all().flatMap((i) => i.json.records || []).map(toPlayer);
    const askerName = (players.find((p) => p.id === askerId) || {}).name || sv.askerName || v.askerName;
    // Regulars on this shelf, anyone @-mentioned, the asker, and the asker's friends (recMember…)
    const roster = players.filter((p) => p.active || v.playerIds.includes(p.id) || p.id === askerId || p.id.startsWith('recMember'))
      .map((p) => `${p.id} | ${p.name}${p.aliases.length ? ' (also: ' + p.aliases.join(', ') + ')' : ''}`).join('\n');
    const selected = players.filter((p) => v.playerIds.includes(p.id)).map((p) => p.name);
    const prompt = [
      'You read requests for a board game night recommender that only knows one family\'s board game shelf.',
      'Extract what they want. Reply with JSON only:',
      '{',
      '  "onTopic": true if this is about board games (any game, owned or not), choosing or playing them, buying them, the games on this shelf, or the people who play here (their tastes, profile, play history), else false,',
      '  "intent": "browse" if they ask what games they have, or to list, show, rank, count or sum up part of the shelf (e.g. "what sci-fi games do I have", "show me our co-ops", "my top ten most played", "do I have Azul", "games by Uwe Rosenberg"); "recommend" if they want something to play; "person" if they ask about a person rather than games (e.g. "what do you know about me", "what does Keith like", "how do I do at Catan", "who wins most"); "game" if they ask about one or more specific games themselves, owned or not (e.g. "what genre is Terraforming Mars", "how long is Brass", "would I like Ark Nova", "is Spirit Island good for 2", "should I buy Cascadia", "does Dan own Spirit Island", "who has Brass"); "rules" if they ask how to play a game or about its rules (e.g. "how do I set up Brass", "how does combat work in Spirit Island", "can you trade in Catan on someone else\'s turn", "how many cards do you draw in Wingspan"); "buy" if they want ideas for games to buy or get next (e.g. "what should I buy next", "what game should I add to my collection", "a co-op I don\'t own yet"),',
      '  "atFriend": the first name of a friend if they are playing at that friend\'s place or ask about that friend\'s shelf or collection ("what can we play at Keith\'s", "anything good on Matt\'s shelf for 4"), else null,',
      '  "acrossFriends": true if they ask which friend owns something or want games from any of their friends\' shelves ("who has a co-op for 6", "can anyone lend me a party game", "which of my friends owns Brass"), else false,',
      '  "games": [for intent "game" or "rules": the official BoardGameGeek titles of the games they name, spelling corrected and completed (e.g. "Teraforming Mars" -> "Terraforming Mars", "Tanares Adventures" -> "Arena: The Contest – Tanares Adventures"). If they describe a game without naming it ("that Viking game by Uwe Rosenberg", "the trick-taking game in space"), always 2 or 3 different guesses of its official title, most likely first, so the right one is among them],',
      '  "guessed": true if "games" are your guesses from a description rather than names they typed, else false,',
      '  "personIds": [for intent "person": ids from ROSTER of who they ask about; "me", "I" and "my" mean the ASKER],',
      '  "sort": for a ranked list only: "plays" (most played), "leastPlays", "recent" (most recently played), "stale" (longest since played), "stars" (their own star ratings: "my highest rated", "games I rated best", "my top rated"), "rating" (BGG rating, only when they say BGG or "the community"), "rank" (BGG rank), "weight" (heaviest), "newest" (latest added); else null,',
      '  "limit": how many games they asked for ("top ten" = 10, "my 5 heaviest" = 5), else null,',
      '  "reply": "only if onTopic is false: one friendly, lightly punny sentence from Nathan, the collection curator, steering back to board games",',
      '  "playerIds": [ids from ROSTER for people playing, named or clearly meant (first names, nicknames); when they include themselves ("for me and Brittany", "something I would like") add the ASKER id],',
      '  "unknownPeople": number of other people mentioned who are not on the roster (e.g. "and 2 friends" = 2),',
      '  "playerCount": total players if stated or implied, else null,',
      '  "maxMinutes": longest acceptable play time in minutes, else null ("quick" ~ 30, "an hour" = 60, "all evening" ~ 240),',
      '  "youngestAge": age of the youngest player if stated, else null,',
      '  "weight": {"min": 1-5, "max": 1-5} complexity if they hint at it ("light" max 2.2, "brain burner" min 3.2), else null,',
      '  "coop": true for cooperative only, false for competitive only, null if either,',
      '  "scope": "mine" if they ask about the ASKER\'s own games, collection, shelf or plays ("my top ten most played", "do I own Azul", "what have I played most", "my co-ops") rather than the SHELF OPEN; "here" if about the open shelf ("on this shelf", "here", "Matt\'s games") or when unsure. If the SHELF OPEN is the asker\'s own, use "here",',
      '  "themes": ["genres, themes or mechanisms they want, as BoardGameGeek category or mechanic words plus common synonyms, e.g. sci-fi: science fiction, space exploration; dice: dice rolling; worker placement. Also any game titles or designer names they name, as written. Leave empty for a plain ranking like most played"],',
      '  "avoid": ["themes, mechanisms or titles to avoid"],',
      '  "freshness": "unplayed" | "stale" (not played in a long time) | "favorite" | null,',
      '  "mood": "a few words on the vibe",',
      '  "excludeIds": []',
      '}',
      'If PREVIOUS is given, this is a follow-up ("shorter", "something else"): start from its constraints and change only what the new message changes. Only when they want different games ("something else", "another one") put the previous picks in excludeIds; when they narrow it down ("which of those are quick") keep excludeIds empty.',
      'Also add "fromPrevious": true when the new message is about the games in the PREVIOUS answer ("those", "these", "of them", "which one", "the first one", "out of my top ten", "of those, which is heaviest"), else false.',
      '',
      'ROSTER (id | name):', roster || '(none)',
      // Nathan the curator is a member too (Nathan Schmidt): questions to him about himself are about that person
      (() => { const me = players.find((p) => p.name === 'Nathan Schmidt'); return me && askerName !== 'Nathan Schmidt'
        ? 'You are talking to Nathan, the curator: "you", "your" and "yourself" addressed to him, or "Nathan" ("what do you like to play?", "what\'s your favorite game?", "what does Nathan like?"), mean the roster person ' + me.id + ' | Nathan Schmidt (intent "person").' : ''; })(),
      askerId ? 'ASKER (the person typing): ' + askerId + ' | ' + (askerName || 'unknown') : '',
      'SHELF OPEN: ' + (sv.ownerName || '__OWNER_NAME__') + '\'s' + (sv.shelf === 'mine' || (sv.shelf === 'main' && $('Auth: Role').first().json._auth.role === 'owner') ? ' (the asker\'s own)' : ' (not the asker\'s)'),
      selected.length ? `Already selected as playing: ${selected.join(', ')}` : '',
      v.previous ? 'PREVIOUS: ' + JSON.stringify({ question: v.previous.question, constraints: v.previous.constraints }) + ' (its answer had ' + (v.previous.setIds || []).length + ' games)' : '',
      '',
      'REQUEST: ' + v.question,
    ].filter((l) => l !== '').join('\n');
    return [{ json: { requestBody: {
      model: '__VISION_MODEL__', models: ['__VISION_MODEL__', '__ASK_MODEL__'], max_tokens: 1500, reasoning: { enabled: false }, provider: { data_collection: 'deny' },
      messages: [{ role: 'user', content: prompt }],
    } } }];
  }),
  openrouter('Understand Request'),
  // "My top ten" while looking at someone else's shelf: answer from the asker's own shelf instead
  code('Scope', function () {
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    const sv = $('Shelf View').first().json.v;
    const onOwn = sv.shelf === 'mine' || (sv.shelf === 'main' && $('Auth: Role').first().json._auth.role === 'owner');
    // The model's call, backed by the words: "my games", "do I own", "have I played" are about the asker's own shelf,
    // unless the question names the open shelf ("here", "this shelf", "Matt's")
    const q = String($('Validate').first().json.question || '');
    const first = String(sv.ownerName || '').toLowerCase();
    const aboutMine = /\b(my|mine)\b|\b(do|did) i (own|have)\b|\bi(?:'ve|’ve| have)? (played|own|got)\b/i.test(q);
    const aboutOpen = /\b(here|this shelf|this collection|on (his|her|their) shelf)\b/i.test(q) || (first && q.toLowerCase().includes(first));
    let c = {};
    try { c = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
    // Firm rules on top of the model's reading: "a game I don't own / don't have / not on my shelf" means buy ideas
    // (also as a follow-up), and a question about "a game" that names none is a recommendation, or a search of friends' shelves
    if (/\b(don'?t|do not|doesn'?t|don’t|doesn’t) (own|have)\b|\bnot (on|in) my (shelf|collection|library)\b|\bi (don'?t|don’t) already (own|have)\b|\b(new to me|haven'?t got)\b/i.test(q)) c.intent = 'buy';
    if ((c.intent === 'game' || c.intent === 'rules') && !(Array.isArray(c.games) && c.games.filter(Boolean).length)) c.intent = /\b(who (owns|has)|any(one|body) (own|has|have)|can anyone lend|which (of my )?friends?)\b/i.test(q) ? 'browse' : 'recommend';
    // A question about a game or what to buy is about the asker: their shelf and taste, wherever they are
    const forMe = c.intent === 'game' || c.intent === 'buy' || c.intent === 'rules';
    const titles = (c.intent === 'game' || c.intent === 'rules') && Array.isArray(c.games) ? c.games.map((t) => String(t).trim()).filter(Boolean).slice(0, 3) : [];
    const prev = $('Validate').first().json.previous;
    const followsOwn = !!(prev && prev.fromOwn && (prev.setIds || []).length); // "which of those…" after an answer from their own shelf
    // Social: "at Keith's" plays from that friend's shelf; "who has…" / "can anyone lend me…" looks across all friends' shelves
    const atFriend = typeof c.atFriend === 'string' && c.atFriend.trim() && !/^(me|my|mine|you)$/i.test(c.atFriend.trim()) ? c.atFriend.replace(/\(.*$/, '').trim().split(/\s+/)[0].slice(0, 40) : '';
    const across = !atFriend && (c.acrossFriends === true || /\b(who (owns|has)|any(one|body) (own|has|have)|can anyone lend|which (of my )?friends?)\b/i.test(q))
      && c.intent !== 'person';
    return [{ json: { useOwn: !onOwn && !atFriend && (forMe || followsOwn || (!aboutOpen && (/"scope"\s*:\s*"mine"/.test(text) || aboutMine))), titles, buy: c.intent === 'buy',
      atFriend, across, rules: c.intent === 'rules', forFriends: c.intent === 'game' && /\b(friends?|who would|anyone)\b/i.test(q) } }];
  }),
  pg('Own Shelf', "SELECT CASE WHEN $2::boolean THEN bgc.shelf_view($1, 'mine', NULL) END AS own, bgc.friend_by_name($1, $3) AS fid, " +
    "CASE WHEN bgc.friend_by_name($1, $3) IS NOT NULL THEN bgc.shelf_view($1, 'friend:' || bgc.friend_by_name($1, $3), NULL) END AS visit",
    "={{ [$('Validate').first().json.email, String($json.useOwn), $json.atFriend] }}"),
  // Games asked about (from the shared catalog, with which friends own them), ideas to buy, friends' shelves, and the asker's Top 10 and wishlist
  pg('Game Lookup', 'SELECT bgc.lookup_games($1, $2::jsonb) AS games, CASE WHEN $3::boolean THEN bgc.buy_pool($1) END AS pool, bgc.curator_card() AS curator, ' +
    'CASE WHEN $4::boolean THEN bgc.friends_pool($1) END AS fpool, bgc.asker_extras($1) AS extras, CASE WHEN $5::boolean THEN bgc.rulebooks_for($2::jsonb) END AS rules',
    "={{ [$('Validate').first().json.email, JSON.stringify($('Scope').first().json.titles), String($('Scope').first().json.buy), String($('Scope').first().json.across), String(!!$('Scope').first().json.rules)] }}"),
  code('Lookup Queries', function () {
    const missing = ($input.first().json.games || []).filter((l) => !l.game).map((l) => l.asked);
    return missing.length ? missing.map((t) => ({ json: { title: t, query: t.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim() } })) : [{ json: { none: true } }];
  }),
  ifTrue('Ask BGG?', '={{ !$json.none }}'),
  // Not in our catalog: BGG's most-rated exact match
  { ...node('Game Search', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/search',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ query: '={{ $json.query }}', type: 'boardgame,boardgameexpansion' }),
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 600 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg }), onError: 'continueRegularOutput' },
  code('Game Candidates', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const asked = $('Lookup Queries').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const t = normTitle(asked[i].title);
      const items = [...String(res.json.data || '').matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)]
        .map((m) => ({ id: m[2], name: decode((m[3].match(/<name type="[^"]+" value="([^"]*)"/) || [])[1] || '') }));
      let pool = items.filter((x) => normTitle(x.name) === t);
      if (!pool.length) pool = items.filter((x) => { const n = normTitle(x.name); return n && (n.startsWith(t + ' ') || t.startsWith(n + ' ')); });
      // A partial name ("Tanares Adventures" for "Arena: The Contest – Tanares Adventures"): titles that contain it; the most-rated wins later
      if (!pool.length && t.length >= 5) pool = items.filter((x) => normTitle(x.name).includes(t));
      return { json: { ids: [...new Set(pool.map((x) => x.id))].slice(0, 15).join(',') } };
    });
  }),
  { ...node('Game Thing', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/thing',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ id: '={{ $json.ids || 0 }}', stats: '1' }),
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 600 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg }), onError: 'continueRegularOutput' },
  code('Game Choose', function () {
    const asked = $('Lookup Queries').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const usersRated = (id) => Number(((String(res.json.data || '').match(new RegExp('<item type="[^"]+" id="' + id + '">[\\s\\S]*?<usersrated value="(\\d+)"')) || [])[1]) || 0);
      const t = parseThingXml(res.json.data).sort((a, b) => ((b.type === 'boardgame') - (a.type === 'boardgame')) || (usersRated(b.id) - usersRated(a.id)))[0];
      return { json: { asked: asked[i].title, game: t ? { bggId: t.id, title: t.name, year: t.year, minPlayers: t.minPlayers, maxPlayers: t.maxPlayers, bestPlayers: t.bestPlayers,
        minTime: t.minTime, maxTime: t.maxTime, weight: t.weight, minAge: t.minAge, rating: t.rating, rank: t.rank, designers: t.designers,
        categories: t.categories, mechanics: t.mechanics, description: t.description, expansion: t.type === 'boardgameexpansion' } : null } };
    });
  }),
  code('Shortlist', function () {
    const v = $('Validate').first().json;
    const text = $('Understand Request').first().json.choices?.[0]?.message?.content || '';
    let c = {};
    try { c = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
    if (c.onTopic === false) return [{ json: { offTopic: true, reply: String(c.reply || 'I can only help pick board games from this shelf.') } }];
    { const q = String(v.question || '');
    // Firm rules on top of the model's reading: "a game I don't own / don't have / not on my shelf" means buy ideas
    // (also as a follow-up), and a question about "a game" that names none is a recommendation, or a search of friends' shelves
    if (/\b(don'?t|do not|doesn'?t|don’t|doesn’t) (own|have)\b|\bnot (on|in) my (shelf|collection|library)\b|\bi (don'?t|don’t) already (own|have)\b|\b(new to me|haven'?t got)\b/i.test(q)) c.intent = 'buy';
    if ((c.intent === 'game' || c.intent === 'rules') && !(Array.isArray(c.games) && c.games.filter(Boolean).length)) c.intent = /\b(who (owns|has)|any(one|body) (own|has|have)|can anyone lend|which (of my )?friends?)\b/i.test(q) ? 'browse' : 'recommend';
    }
    const open = $('Shelf View').first().json.v;
    const scope = $('Scope').first().json;
    const visit = $('Own Shelf').first().json.visit || null; // "at Keith's": that friend's shelf
    const own = visit ? null : ($('Own Shelf').first().json.own || null);
    const sv = visit || own || open; // the shelf this answer is about
    if (scope.atFriend && !visit) return [{ json: { offTopic: true, reply: scope.atFriend + ' isn’t on your friends list yet, so I can’t see their shelf. Swap friend codes under Friends and ask me again!' } }];
    const fpool = scope.across ? ($('Game Lookup').first().json.fpool || []) : null; // every game on your friends' shelves
    // A follow-up about the last answer ("which of those are co-op?") works within that answer's games
    const prevSet = new Set((v.previous && v.previous.setIds) || []);
    const narrow = prevSet.size > 0 && c.intent !== 'game' && c.intent !== 'buy' && c.intent !== 'rules'
      && (c.fromPrevious === true || /\b(those|these|them|that list|which one|the first|the last|out of (my|the|those|these))\b/i.test(v.question));
    let games = (sv.games || []).map(toGame).filter((g) => !narrow || prevSet.has(g.id));
    // Across friends: the games on all their shelves, each with who owns it (ids "bgg:<id>"; cards link to BGG)
    if (fpool) games = fpool.map((x) => ({ id: 'bgg:' + x.bggId, recordId: null, bggId: x.bggId, num: null, title: x.title, genre: '', type: '', desc: '', expansions: [],
      desireToPlay: 0, thinningCandidate: false, bggRating: x.rating || null, icon: 'meeple', minPlayers: x.minPlayers || null, maxPlayers: x.maxPlayers || null,
      bestPlayers: x.bestPlayers || [], minTime: x.minTime || null, maxTime: x.maxTime || null, weight: x.weight || null, year: x.year || null, minAge: x.minAge || null,
      designers: x.designers || [], rank: x.rank || null, categories: x.categories || [], mechanics: x.mechanics || [], favorite: false, coverCard: x.cover || null,
      coverLarge: null, playCount: x.ownerPlays || 0, lastPlayed: null, addedAt: null, extraBggIds: [], owners: x.owners || [], mine: !!x.mine }));
    // 'Who has…' is about borrowing: leave out games the asker already owns (unless that's all there is)
    if (fpool && games.some((g) => !g.mine)) games = games.filter((g) => !g.mine);
    const players = (sv.players || []).map(toPlayer);
    const ratings = (sv.ratings || []).map(toRating);
    const byId = Object.fromEntries(players.map((p) => [p.id, p]));
    // "What do you like to play?" / "What's your favorite game?" asked of Nathan: a question about Nathan Schmidt, the curator
    const curator = players.find((p) => p.name === 'Nathan Schmidt');
    const toNathan = curator && sv.askerName !== 'Nathan Schmidt' && c.intent !== 'game' && c.intent !== 'buy'
      && /\b(you|your|yours|yourself)\b[^?]*\b(like|love|enjoy|favou?rites?|prefer|own|shelf|collection|rate|rated|played|taste|top)\b/i.test(v.question)
      && !/\b(i|me|my|mine|i'm|i've|we|us|our)\b|\b(would|should|could|can) you\b|\b(recommend|suggest|pick)\b/i.test(v.question);
    if (toNathan) { c.intent = 'person'; c.personIds = [curator.id]; }
    // Nathan the curator speaks for himself from his own shelf (his plays on someone else's shelf would be the wrong picture)
    const cc = $('Game Lookup').first().json.curator || {};
    const curatorFacts = (p) => ['- Nathan Schmidt: this is YOU, the curator. Answer about him in the first person ("I", "my shelf").',
      ...profile(p).split('\n').slice(1).filter((l) => !/logged|most played|rated 4\+|no logged plays/.test(l)),
      '  my own shelf: ' + (cc.games || 0) + ' games, ' + (cc.plays || 0) + ' logged plays, ' + (cc.unplayed || 0) + ' never played yet',
      (cc.top || []).length ? '  my most played: ' + cc.top.join(', ') : '', (cc.loved || []).length ? '  my highest rated: ' + cc.loved.join(', ') : '',
      (cc.favorites || []).length ? '  my favorites: ' + cc.favorites.join(', ') : ''].filter(Boolean).join('\n');

    // People picked from the open shelf's list, found on the asker's shelf by name when the answer comes from there
    const openNames = Object.fromEntries((open.players || []).map(toPlayer).map((p) => [p.id, p.name.toLowerCase()]));
    const byName = Object.fromEntries(players.map((p) => [p.name.toLowerCase(), p]));
    const group = [...new Set([...(v.playerIds || []), ...(Array.isArray(c.playerIds) ? c.playerIds : [])])]
      .map((id) => byId[id] || (own && openNames[id] ? byName[openNames[id]] : null)).filter(Boolean);
    const count = c.intent === 'browse' ? (Number(c.playerCount) || null)
      : Math.max(Number(c.playerCount) || 0, group.length + (Number(c.unknownPeople) || 0)) || null;
    const ages = [Number(c.youngestAge) || null, ...(c.intent === 'browse' ? [] : group.map((p) => p.age))].filter((a) => a > 0); // a browse is about the shelf, not who's playing
    const youngest = ages.length ? Math.min(...ages) : null;
    const maxMin = Number(c.maxMinutes) || null;
    const wMin = c.weight && Number(c.weight.min) || null, wMax = c.weight && Number(c.weight.max) || null;
    const words = (list) => (Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase().trim()).filter((s) => s.length > 2);
    // Common words map onto BGG's category and mechanic names, so the matching set doesn't depend on the model's wording
    const SYN = {
      'sci-fi': ['science fiction', 'space exploration'], 'scifi': ['science fiction', 'space exploration'], 'science fiction': ['sci-fi', 'space exploration'], 'space exploration': ['sci-fi', 'science fiction'],
      'space': ['space exploration', 'science fiction'], 'aliens': ['science fiction'], 'robots': ['science fiction'],
      'co-op': ['cooperative game'], 'coop': ['cooperative game'], 'cooperative': ['cooperative game'],
      'dice': ['dice rolling'], 'war': ['wargame'], 'wargames': ['wargame'], 'deckbuilding': ['deck, bag, and pool building'], 'deck building': ['deck, bag, and pool building'], 'deck-building': ['deck, bag, and pool building'],
      'party': ['party game'], 'zombie': ['zombies'], 'trick taking': ['trick-taking'], 'pirate': ['pirates'], 'dragons': ['fantasy'], 'animal': ['animals'],
      'economic': ['economic'], 'train': ['trains'], 'railroad': ['trains'], 'mystery': ['deduction', 'murder/mystery'], 'detective': ['deduction', 'murder/mystery'],
    };
    const expand = (list) => [...new Set(list.flatMap((w) => [w, ...(SYN[w] || [])]))];
    const want = expand(words(c.themes)), avoid = words(c.avoid);
    const exclude = new Set(c.intent !== 'browse' && Array.isArray(c.excludeIds) ? c.excludeIds : []); // previous picks, when they want different games (a browse lists everything)
    // each person's own BGC stars and their BGG rating, kept apart
    const rate = ratingsByPlayerGame(ratings);
    // One set of stars: each game's stars are the shelf owner's own rating (kept on desireToPlay so ranking and scoring use it)
    for (const g of games) g.desireToPlay = ((rate[(sv.ownerKey || '') + '|' + g.id] || {}).stars) || 0;
    const fit = (r) => r ? (r.stars ? r.stars : r.bgg ? r.bgg / 2 : null) : null; // 1-5 for scoring; their BGC stars win over BGG
    const hay = (g) => [g.title, g.genre, g.type, g.desc, ...g.categories, ...g.mechanics].join(' ').toLowerCase();
    const isCoop = (g) => g.mechanics.some((m) => /cooperative/i.test(m)) || /co-?op/i.test(g.type);
    const daysSince = (d) => d ? (Date.now() - new Date(d).getTime()) / 86400000 : Infinity;
    const scored = [], loose = [];
    for (const g of games) {
      if (exclude.has(g.id)) continue;
      // Loose score for gap mode: same preferences, only the player count enforced
      if (!count || !g.minPlayers || (count >= g.minPlayers && count <= g.maxPlayers)) {
        const h0 = hay(g);
        loose.push({ g, s: want.filter((w) => h0.includes(w)).length * 2.5 + (count && g.bestPlayers.includes(count) ? 2 : 0) + (g.desireToPlay || 0) * 0.4 + ((g.bggRating || 6.5) - 6.5) * 0.5 - (g.minPlayers ? 0 : 3) });
      }
      // A game with no BGG data for an asked-for limit is not a confirmed fit (it can still be a gap-mode closest match)
      if (count && (!g.minPlayers || !g.maxPlayers || count < g.minPlayers || count > g.maxPlayers)) continue;
      if (maxMin && (!(g.maxTime || g.minTime) || (g.maxTime || g.minTime) > maxMin * 1.1)) continue; // "under an hour" means the whole game fits
      if (youngest && g.minAge && g.minAge > youngest + 1) continue;
      if (wMax && (!g.weight || g.weight > wMax + 0.3)) continue;
      if (wMin && (!g.weight || g.weight < wMin - 0.3)) continue;
      if (c.freshness === 'stale' && daysSince(g.lastPlayed) < 183) continue; // "haven't played in a while": not in the last ~6 months
      if (c.freshness === 'unplayed' && c.intent === 'browse' && g.playCount) continue; // "my shelf of shame": only the never-played ones
      if (c.coop === true && !isCoop(g)) continue;
      if (c.coop === false && isCoop(g) && !/semi/i.test(g.type)) continue;
      const h = hay(g);
      if (avoid.some((w) => h.includes(w))) continue;
      let s = 0;
      if (count && g.bestPlayers.includes(count)) s += 2;
      s += want.filter((w) => h.includes(w)).length * 2.5;
      s += (g.desireToPlay || 0) * 0.4 + (g.favorite ? 1 : 0) - (g.thinningCandidate ? 0.5 : 0);
      s += ((g.bggRating || 6.5) - 6.5) * 0.5;
      if (g.owners && g.mine) s -= 2.5; // "who has…": you're looking to borrow, so games you already own come last
      const groupStars = group.map((p) => fit(rate[p.id + '|' + g.id])).filter(Boolean);
      if (groupStars.length) s += (groupStars.reduce((a, b) => a + b, 0) / groupStars.length - 3) * 1.2;
      if (c.freshness === 'unplayed' && !g.playCount) s += 3;
      if (c.freshness === 'stale' && daysSince(g.lastPlayed) > 365) s += 3;
      if (c.freshness === 'favorite') s += (g.favorite ? 3 : 0) + (g.desireToPlay || 0) * 0.5;
      scored.push({ g, s });
    }
    scored.sort((a, b) => b.s - a.s);
    // The full set that fits: hard limits, plus at least one asked-for theme in the game's BGG tags (not the blurb, which is too loose)
    const tags = (g) => [g.title, g.genre, g.type, ...g.categories, ...g.mechanics, ...(g.designers || [])].join(' ').toLowerCase();
    let themed = want.length ? scored.filter((x) => want.some((w) => tags(x.g).includes(w))) : scored;
    // "My shelf of shame" or "haven't played in ages" is the whole question: words like "shame" aren't a theme to match
    if (!themed.length && c.freshness && scored.length) themed = scored;
    const browse = c.intent === 'browse';
    const gap0 = browse ? themed.length === 0 : scored.length === 0;
    // Themes filter only a browse ("what sci-fi games do I have"); for a recommendation they are moods that steer the score ("cozy")
    let fits = browse ? themed : scored;
    // A ranked browse ("my top ten most played"): order the set, keep only games that have the number, then cut to the limit
    const by = (key, dir) => (a, b) => ((b.g[key] ?? -Infinity) > (a.g[key] ?? -Infinity) ? 1 : (b.g[key] ?? -Infinity) < (a.g[key] ?? -Infinity) ? -1 : 0) * dir;
    const SORTS = {
      plays: { cmp: by('playCount', 1), keep: (g) => g.playCount > 0, label: 'most played first' },
      leastPlays: { cmp: by('playCount', -1), keep: () => true, label: 'fewest plays first' },
      recent: { cmp: by('lastPlayed', 1), keep: (g) => !!g.lastPlayed, label: 'most recently played first' },
      stale: { cmp: by('lastPlayed', -1), keep: (g) => !!g.lastPlayed, label: 'longest since played first' },
      rating: { cmp: by('bggRating', 1), keep: (g) => !!g.bggRating, label: 'highest BGG rating first' },
      rank: { cmp: by('rank', -1), keep: (g) => !!g.rank, label: 'best BGG rank first' },
      stars: { cmp: by('desireToPlay', 1), keep: (g) => !!g.desireToPlay, label: 'highest own star rating first' },
      want: { cmp: by('desireToPlay', 1), keep: (g) => !!g.desireToPlay, label: 'highest own star rating first' },
      weight: { cmp: by('weight', 1), keep: (g) => !!g.weight, label: 'heaviest first' },
      newest: { cmp: by('addedAt', 1), keep: () => true, label: 'latest added first' },
    };
    // Never-played games have no plays or last-played date, so a play-based order would drop them all
    if (c.freshness === 'unplayed' && ['stale', 'recent', 'plays', 'leastPlays'].includes(c.sort)) c.sort = null;
    const sorter = browse ? SORTS[c.sort] : null;
    if (sorter) fits = fits.filter((x) => sorter.keep(x.g)).sort(sorter.cmp);
    const limit = browse ? Math.max(0, Math.min(50, Math.round(Number(c.limit) || 0))) : 0;
    if (limit) fits = fits.slice(0, limit);
    const gap = gap0 || fits.length === 0;
    // "My top ten …": the whole ranked list, straight from the data (shown under Nathan's summary)
    const METRIC = {
      plays: (g) => g.playCount + ' play' + (g.playCount === 1 ? '' : 's'), leastPlays: (g) => (g.playCount || 0) + ' play' + (g.playCount === 1 ? '' : 's'),
      recent: (g) => 'last played ' + g.lastPlayed, stale: (g) => 'last played ' + g.lastPlayed,
      rating: (g) => 'BGG ' + Number(g.bggRating).toFixed(1), rank: (g) => 'BGG #' + g.rank, want: (g) => g.desireToPlay + '/5 stars', stars: (g) => g.desireToPlay + '/5 stars',
      weight: (g) => 'weight ' + Number(g.weight).toFixed(1), newest: (g) => 'added ' + String(g.addedAt || '').slice(0, 10),
    };
    const ranked = !gap && sorter && limit && limit <= 25 && METRIC[c.sort] ? fits.map((x, i) => (i + 1) + '. ' + x.g.title + ' (' + METRIC[c.sort](x.g) + ')').join('; ') : null;
    const short = (gap ? loose.sort((a, b) => b.s - a.s).slice(0, 12) : fits.slice(0, 30)).map((x) => x.g);
    const matchIds = gap ? [] : fits.map((x) => x.g.id);
    // A few facts about the matching set, so a browse summary can be specific without guessing
    const tally = (list) => Object.entries(list.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + ' ' + n).join(', ');
    const set = fits.map((x) => x.g);
    const weights = set.map((g) => g.weight).filter(Boolean);
    const setFacts = gap ? '' : [
      set.length === 1 ? 'THE ANSWER: ' + set[0].title + ' (lead with it; no need to count)' : 'COUNT: ' + set.length + ' of ' + games.length + (narrow ? ' games in the previous answer' : fpool ? ' games on their friends\' shelves' : ' games on the shelf') + ' match everything asked, including any limits like time or players (say it naturally, never mention matching, e.g. "17 sci-fi games under an hour")',
      weights.length > 1 ? 'weights: ' + weights.filter((w) => w < 2).length + ' light (<2), ' + weights.filter((w) => w >= 2 && w < 3).length + ' medium, ' + weights.filter((w) => w >= 3).length + ' heavy (3+)' : '',
      set.length < 2 ? '' : 'played: ' + set.filter((g) => g.playCount).length + ', never played: ' + set.filter((g) => !g.playCount).length + ', favorites: ' + set.filter((g) => g.favorite).length,
      set.length < 2 ? '' : 'top categories: ' + tally(set.flatMap((g) => g.categories)),
      set.length < 2 ? '' : 'top mechanics: ' + tally(set.flatMap((g) => g.mechanics)),
      sorter ? 'ORDER: the CANDIDATES are ranked, ' + sorter.label + (limit ? ', top ' + limit : '') : '',
      // A follow-up picks from the last answer: show that whole set (in the order asked), so "the heaviest" can be put in context
      narrow && sorter && METRIC[c.sort] ? 'ALL ' + games.length + ' GAMES FROM THE PREVIOUS ANSWER, ' + sorter.label + ': ' +
        games.filter((g) => sorter.keep(g)).map((g) => ({ g })).sort(sorter.cmp).map((x) => x.g.title + ' (' + METRIC[c.sort](x.g) + ')').join('; ') : '',
    ].filter(Boolean).join('\n');
    const shelfOwner = fpool ? 'your friends' : sv.ownerName || '__OWNER_NAME__';
    const askerIsOwner = !fpool && (sv.shelf === 'mine' || $('Auth: Role').first().json._auth.role === 'owner');
    const mineHere = !fpool && (sv.shelf === 'mine' || (sv.shelf === 'main' && $('Auth: Role').first().json._auth.role === 'owner')); // the asker's own shelf
    const curatorShelf = !mineHere && !fpool && curator && sv.ownerKey && sv.ownerKey === curator.id; // at Nathan's: his own shelf, so "I"
    const line = (g, ppl = group) => {
      if (g.owners) {
        // Across friends' shelves: who owns it, and whether the asker does too
        const f = [g.minPlayers ? `${g.minPlayers}-${g.maxPlayers}p` + (g.bestPlayers.length ? ` best ${g.bestPlayers.join('/')}` : '') : '',
          g.minTime ? `${g.minTime === g.maxTime ? g.minTime : g.minTime + '-' + g.maxTime}min` : '', g.weight ? `weight ${Number(g.weight).toFixed(1)}` : '',
          g.minAge ? `age ${g.minAge}+` : '', g.bggRating ? `BGG ${g.bggRating}` : '', g.mechanics.slice(0, 4).join(', '),
          'owned by ' + g.owners.map((o) => o === 'Nathan' ? 'Nathan (that is you, the curator: say "my copy")' : o).join(', '), g.mine ? 'the asker owns it too' : 'the asker does not own it', g.playCount ? `${g.owners.join(' and ')} logged ${g.playCount} plays of it` : ''].filter(Boolean).join('; ');
        return `${g.id} | ${g.title} | ${f}`;
      }
      const facts = [
        g.minPlayers ? `${g.minPlayers}-${g.maxPlayers}p` + (g.bestPlayers.length ? ` best ${g.bestPlayers.join('/')}` : '') : '',
        g.minTime ? `${g.minTime === g.maxTime ? g.minTime : g.minTime + '-' + g.maxTime}min` : '',
        g.weight ? `weight ${Number(g.weight).toFixed(1)}` : '', g.minAge ? `age ${g.minAge}+` : '',
        g.bggRating ? `BGG ${g.bggRating}` : '', g.genre, g.type,
        g.mechanics.slice(0, 4).join(', '),
        // On their own shelf the owner is the asker: "you", so Nathan never talks about them in the third person
        g.desireToPlay ? (mineHere ? `you rate it ${g.desireToPlay}/5` : curatorShelf ? `I (Nathan) rate it ${g.desireToPlay}/5` : `${shelfOwner} rates it ${g.desireToPlay}/5`) : (mineHere ? 'you haven\'t rated it' : curatorShelf ? 'I haven\'t rated it' : `${shelfOwner} hasn't rated it`),
        g.favorite ? (mineHere ? 'your favorite' : `${shelfOwner}'s favorite`) : '', g.thinningCandidate && askerIsOwner ? (mineHere ? 'you may give it away' : `${shelfOwner} may give it away`) : '',
        g.playCount ? `${mineHere ? 'you' : curatorShelf ? 'I (Nathan)' : shelfOwner} logged ${g.playCount} plays, last ${g.lastPlayed}` : `${mineHere ? 'you' : curatorShelf ? 'I' : shelfOwner} never logged a play`,
        (g.expansions || []).length ? `+${g.expansions.length} expansions` : '',
      ].filter(Boolean).join('; ');
      const people = ppl.map((p) => {
        const hst = p.history[String(g.bggId)] || null;
        const r = rate[p.id + '|' + g.id];
        const bits = [hst ? `${hst.plays} plays/${hst.wins} wins` : 'never played', r && r.stars ? `rates it ${r.stars}/5 on BGC` : '', r && r.bgg ? `BGG rating ${r.bgg}/10` : ''].filter(Boolean).join(', ');
        return `${p.name.split(' ')[0]}: ${bits}`;
      }).join('; ');
      return `${g.id} | ${g.title} | ${facts}${people ? ' | ' + people : ''}`;
    };
    const profile = (p) => {
      const dial = (label, v, lo, hi) => v ? `${label} ${v}/5 (${lo}..${hi})` : '';
      const top = Object.entries(p.history).map(([bgg, h]) => ({ g: games.find((x) => String(x.bggId) === bgg), h })).filter((x) => x.g)
        .sort((a, b) => b.h.plays - a.h.plays).slice(0, 6).map((x) => `${x.g.title} (${x.h.plays}x, ${x.h.wins} wins)`);
      const loved = Object.values(rate).filter((r) => r.playerId === p.id && fit(r) >= 4).map((r) => games.find((g) => g.id === r.gameId)?.title).filter(Boolean).slice(0, 6);
      const totals = Object.values(p.history).reduce((a, h) => ({ plays: a.plays + h.plays, wins: a.wins + h.wins }), { plays: 0, wins: 0 });
      return [
        `- ${p.name}` + (p.age ? `, age ${p.age}` : ''),
        [dial('complexity', p.complexity, 'light', 'heavy'), dial('conflict', p.conflict, 'co-op only', 'cutthroat'), dial('luck', p.luck, 'hates dice', 'loves chaos'),
          dial('table talk', p.tableTalk, 'quiet', 'party'), dial('theme', p.theme, 'puzzle first', 'story first')].filter(Boolean).join('; '),
        p.likes ? `in their own words, likes: ${p.likes}` : '', p.dislikes ? `in their own words, dislikes: ${p.dislikes}` : '', p.notes ? `about themselves: ${p.notes}` : '',
        totals.plays ? `logged ${totals.plays} plays, won ${totals.wins}` : 'no logged plays',
        top.length ? `most played: ${top.join(', ')}` : '', loved.length ? `rated 4+: ${loved.join(', ')}` : '',
        // The asker's own picks: their all-time Top 10 and their wishlist
        ...(p.name === sv.askerName || p.name === open.askerName ? (() => { const x = $('Game Lookup').first().json.extras || {};
          return [(x.top || []).length ? `all-time Top 10 (their own pick, best first): ${x.top.join(', ')}` : '', (x.wishlist || []).length ? `on their wishlist: ${x.wishlist.join(', ')}` : '']; })() : []),
      ].filter(Boolean).join('\n  ');
    };
    const asker = byId[sv.askerPerson || sv.askerKey] || null;
    // On someone else's shelf, the asker is a guest: "you" is the asker, the shelf, its plays and stars are the owner's
    const guest = asker && sv.ownerName && asker.name.split(' ')[0] !== sv.ownerName
      ? `SHELF: you are looking at ${sv.ownerName}'s shelf with ${asker.name.split(' ')[0]}. Speak to ${asker.name.split(' ')[0]} as "you" and never call them ${sv.ownerName}; the games, plays, wins, favorites and star ratings on this shelf are ${sv.ownerName}'s ("${sv.ownerName} has played it 12 times").` : '';
    if (c.intent === 'rules') c.intent = 'game', c.rulesQuestion = true;
    if (c.intent === 'game' || c.intent === 'buy') {
      // About a game (owned or not), or ideas to buy. sv is the asker's own shelf here, so their taste comes from it.
      const facts = (g) => [
        g.year ? 'published ' + g.year : '',
        g.minPlayers ? g.minPlayers + '-' + g.maxPlayers + ' players' + ((g.bestPlayers || []).length ? ', best at ' + g.bestPlayers.join('/') + ' (BGG community poll)' : '') : '',
        g.minTime ? (g.minTime === g.maxTime || !g.maxTime ? g.minTime : g.minTime + '-' + g.maxTime) + ' min' : '',
        g.weight ? 'BGG weight ' + Number(g.weight).toFixed(1) + '/5' : '', g.minAge ? 'age ' + g.minAge + '+' : '',
        g.rating ? 'BGG rating ' + Number(g.rating).toFixed(1) + '/10' : '', g.rank ? 'BGG rank #' + g.rank : '',
        (g.designers || []).length ? 'designed by ' + g.designers.join(', ') : '',
        (g.categories || []).length ? 'categories: ' + g.categories.join(', ') : '',
        (g.mechanics || []).length ? 'mechanics: ' + g.mechanics.slice(0, 8).join(', ') : '',
        g.expansion ? 'this is an expansion, not a standalone game' : '',
      ].filter(Boolean).join('; ');
      const topPlayed = games.filter((g) => g.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 8);
      const loved = asker ? Object.values(rate).filter((r) => r.playerId === asker.id && fit(r) >= 4).map((r) => games.find((g) => g.id === r.gameId)).filter(Boolean) : [];
      const tasteGames = [...new Set([...topPlayed, ...loved, ...games.filter((g) => g.favorite)])];
      const tasteTags = {};
      for (const g of tasteGames) for (const t of [...g.categories, ...g.mechanics]) tasteTags[t] = (tasteTags[t] || 0) + 1;
      const taste = [
        'ASKER\'S SHELF: ' + games.length + ' games' + (topPlayed.length ? '; most played: ' + topPlayed.map((g) => g.title + ' (' + g.playCount + ')').join(', ') : ''),
        loved.length ? 'rated 4+ by them: ' + loved.slice(0, 8).map((g) => g.title).join(', ') : '',
        Object.keys(tasteTags).length ? 'what their favorites have in common: ' + Object.entries(tasteTags).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k).join(', ') : '',
        asker ? 'PROFILE:\n' + profile(asker) : '',
      ].filter(Boolean).join('\n');
      const lookup = $('Game Lookup').first().json;
      const owners = (list) => (list || []).length ? 'friends who own it: ' + list.join(', ') : 'none of their friends own it';
      const off = [], lines = [], titles = {};
      const add = (g, friends) => {
        const shelfGame = games.find((x) => x.bggId && Number(x.bggId) === Number(g.bggId));
        const id = shelfGame ? shelfGame.id : 'bgg:' + g.bggId;
        if (titles[id]) return;
        titles[id] = shelfGame ? shelfGame.title : g.title;
        if (!shelfGame) off.push({ id, title: g.title, bggId: g.bggId, cover: g.cover || null, friends: friends || [] });
        lines.push(id + ' | ' + titles[id] + ' | ' + (shelfGame ? 'ON THEIR SHELF, ' + (shelfGame.playCount || 0) + ' logged plays' : 'not on their shelf') + ' | ' + facts(g) +
          (owners(friends) ? ' | ' + owners(friends) : '') + (c.intent === 'game' && g.description ? ' | BGG description: ' + g.description : ''));
      };
      if (c.intent === 'game') {
        let looked = [];
        try { looked = $('Game Choose').all().map((i) => i.json); } catch (e) { looked = []; }
        for (const l of lookup.games || []) if (l.game) add(l.game, l.friends);
        for (const l of looked) if (l.game) add(l.game, []);
        const notFound = (lookup.games || []).filter((l) => !l.game && !looked.some((x) => x.asked === l.asked && x.game)).map((l) => l.asked);
        // "Does Dan own Spirit Island?": say plainly for each person named, from the friends who own it
        const ownQ = /\b(own|owns|have|has|got)\b/i.test(v.question) ? players.map((p) => p.name.split(' ')[0]).filter((f, i, a) => f && a.indexOf(f) === i && new RegExp('\\b' + f + '\\b', 'i').test(v.question)) : [];
        const ownership = ownQ.flatMap((f) => (lookup.games || []).filter((l) => l.game).map((l) => 'OWNERSHIP: ' + f + ((l.friends || []).includes(f) ? ' owns ' : ' does not own ') + l.game.title + (l.onShelf ? ' (the asker does)' : '')));
        // A rules question about a game we have a rulebook for counts even if BGG doesn't know it
        if (c.rulesQuestion) for (const b of $('Game Lookup').first().json.rules || []) {
          const id = 'bgg:' + b.bggId;
          if (!Object.values(titles).includes(b.title) && !titles[id]) { titles[id] = b.title; lines.push(id + ' | ' + b.title + ' | rulebook uploaded'); }
        }
        if (!lines.length) return [{ json: { offTopic: true, reply: 'I couldn’t find ' + (notFound.join(' or ') || 'that game') + ' on BoardGameGeek. Could you check the spelling?' } }];
        if (c.rulesQuestion) {
          // The parts of the rulebook that match the question (plus its opening, which usually covers the goal and setup)
          const books = $('Game Lookup').first().json.rules || [];
          const stop = new Set('the and for with you your how what when does can are this that from have will into than then them they their there game games play playing rules rule turn'.split(' '));
          const words = (String(v.question).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !stop.has(w)).map((w) => w.slice(0, 6));
          const excerpt = (text) => {
            const paras = String(text || '').split(/\n\s*\n|\n(?=[A-Z][A-Z ]{3,}\n)/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 30);
            const chunks = [];
            for (const p of paras) { const last = chunks[chunks.length - 1]; if (last && last.length + p.length < 1400) chunks[chunks.length - 1] = last + ' ' + p; else chunks.push(p); }
            const scored = chunks.map((t, i) => ({ i, t, s: words.reduce((n, w) => n + (t.toLowerCase().split(w).length - 1), 0) }));
            const keep = new Set([0, 1]);
            let size = (chunks[0] || '').length + (chunks[1] || '').length;
            for (const x of [...scored].sort((a, b) => b.s - a.s)) { if (!x.s || size > 14000) break; keep.add(x.i); size += x.t.length; }
            return [...keep].sort((a, b) => a - b).map((i) => chunks[i]).filter(Boolean).join('\n[...]\n');
          };
          const named = (lookup.games || []).filter((l) => l.game).map((l) => l.game);
          const rb = books.map((b) => 'RULEBOOK EXCERPTS for ' + b.title + ' (from the rulebook a member uploaded' + (b.pages ? ', ' + b.pages + ' pages' : '') + '):\n' + excerpt(b.text)).join('\n\n');
          const missing = named.filter((g) => !books.some((b) => Number(b.bggId) === Number(g.bggId)));
          return [{ json: { offTopic: false, gap: false, browse: true, mode: 'rules', matchIds: [], understood: {}, constraints: c,
            setFacts: (rb || '') + (missing.length ? (rb ? '\n\n' : '') + 'NO RULEBOOK UPLOADED for: ' + missing.map((g) => g.title).join(', ') : ''),
            shortIds: Object.keys(titles), titles, off, gameLines: lines.join('\n'), profiles: '', askerName: asker ? asker.name : '', ownerName: shelfOwner, guest: '', fromOwn: !!own,
            rulebooks: named.map((g) => ({ bggId: g.bggId, title: g.title, has: books.some((b) => Number(b.bggId) === Number(g.bggId)) })) } }];
        }
        return [{ json: { offTopic: false, gap: false, browse: true, mode: 'game', matchIds: [], understood: {}, constraints: c,
          setFacts: (c.guessed ? 'GUESSED: they described a game without naming it; the CANDIDATES are your best guesses. Pick the candidate that best fits every detail of their description (theme, designer, mechanics) and lead with "Sounds like …"; mention another candidate only if it also fits, and ask them to say if you missed. Highlights: only the candidate(s) you think they mean.\n' : '') +
            (ownership.length ? ownership.join('\n') + ' (answer this first)\n' : '') + taste + (notFound.length ? '\nNOT FOUND ON BGG: ' + notFound.join(', ') : '') +
            // "Which of my friends would love Ark Nova?": their friends' own profiles, to match the game against
            (scope.forFriends ? '\nTHEIR FRIENDS (match the game to each one; say who would love it and who might not, and why):\n' +
              players.filter((p) => p.googleEmail && p.name !== sv.askerName).map((p) => p === curator ? curatorFacts(p) : profile(p)).join('\n') : ''),
          shortIds: Object.keys(titles), titles, off,
          gameLines: lines.join('\n'), profiles: '', askerName: asker ? asker.name : '', ownerName: shelfOwner, guest: '', fromOwn: !!own } }];
      }
      // Ideas to buy: games they don't own that share what their favorites have, within anything they asked for
      const hay2 = (g) => [g.title, ...(g.categories || []), ...(g.mechanics || [])].join(' ').toLowerCase();
      const coop = (g) => (g.mechanics || []).some((m) => /cooperative/i.test(m));
      const picks = (lookup.pool || []).filter((g) => (!count || (g.minPlayers <= count && count <= (g.maxPlayers || 99)))
          && (!maxMin || (g.maxTime || g.minTime || 999) <= maxMin * 1.1) && (!wMax || (g.weight && g.weight <= wMax + 0.3)) && (!wMin || (g.weight && g.weight >= wMin - 0.3))
          && (c.coop !== true || coop(g)) && (c.coop !== false || !coop(g)) && !avoid.some((w) => hay2(g).includes(w)))
        .map((g) => ({ g, s: [...(g.categories || []), ...(g.mechanics || [])].reduce((n, t) => n + (tasteTags[t] || 0), 0) / Math.max(1, tasteGames.length) * 3
          + want.filter((w) => hay2(g).includes(w)).length * 2.5 + ((g.rating || 6.5) - 6.5) * 0.8 + ((g.friends || []).length ? 1.5 : 0)
          // "a two-player game" means one that shines at 2, not one that merely allows it
          + (count ? ((g.bestPlayers || []).includes(count) ? 3 : -1.5) : 0) }))
        .sort((a, b) => b.s - a.s).slice(0, 12);
      for (const x of picks) add(x.g, x.g.friends);
      if (!lines.length) return [{ json: { offTopic: true, reply: 'I don’t have enough games beyond your shelf to suggest one for that yet. Try asking about a specific game!' } }];
      return [{ json: { offTopic: false, gap: false, browse: true, mode: 'buy', matchIds: [], understood: { themes: want, coop: c.coop ?? null, playerCount: count, maxMinutes: maxMin }, constraints: c,
        setFacts: taste, shortIds: Object.keys(titles), titles, off, gameLines: lines.join('\n'), profiles: '', askerName: asker ? asker.name : '', ownerName: shelfOwner, guest: '', fromOwn: !!own } }];
    }
    if (c.intent === 'person') {
      // "What do you know about me?": their own words, their play history here, and the games that show their taste
      const who = [...new Set(Array.isArray(c.personIds) ? c.personIds : [])].map((id) => byId[id]).filter(Boolean);
      const ppl = who.length ? who : asker ? [asker] : group;
      const playsOf = (g) => ppl.reduce((n, p) => n + ((p.history[String(g.bggId)] || {}).plays || 0), 0);
      const theirs = games.filter((g) => g.bggId && playsOf(g) > 0).sort((a, b) => playsOf(b) - playsOf(a));
      const pick = (theirs.length ? theirs : [...games].sort((a, b) => (b.desireToPlay || 0) - (a.desireToPlay || 0))).slice(0, 12);
      // Nathan the curator speaks for himself from his own shelf (his plays here on someone else's shelf would be the wrong picture)
      const onlyCurator = ppl.length === 1 && ppl[0] === curator;
      if (onlyCurator) {
        // Highlights: his favorites and most played wherever they're on this shelf, then the shelf's best fits for his taste
        const mine = new Set([...(cc.top || []), ...(cc.loved || []), ...(cc.favorites || [])].map((t) => normTitle(String(t).replace(/ \([^)]*\)$/, ''))));
        const hits = games.filter((g) => mine.has(normTitle(g.title)));
        pick.splice(0, pick.length, ...(hits.length ? hits : [...games].sort((a, b) => (b.bggRating || 0) - (a.bggRating || 0))).slice(0, 8));
      }
      const facts = [
        'ASKER (the person typing; call them "you"): ' + (asker ? asker.name : 'unknown'), guest,
        'ABOUT: ' + (ppl.map((p) => p.name).join(', ') || 'unknown'),
        ppl.length ? ppl.map((p) => p === curator ? curatorFacts(p) : profile(p)).join('\n') : '(no profile or play history found)',
        onlyCurator ? '' : 'COUNT: ' + (ppl.length === 1 ? 'they have' : 'together they have') + ' played ' + theirs.length + ' of the ' + games.length + ' games on this shelf (logged plays)',
      ].filter(Boolean).join('\n');
      return [{ json: { offTopic: false, gap: false, browse: true, person: true, matchIds: theirs.map((g) => g.id), setFacts: facts,
        understood: { players: ppl.map((p) => p.name) }, constraints: c, shortIds: pick.map((g) => g.id),
        titles: Object.fromEntries(pick.map((g) => [g.id, g.title])), gameLines: pick.map((g) => line(g, ppl)).join('\n'), profiles: '', ownerName: shelfOwner, guest, fromOwn: !!own } }];
    }
    const understood = { players: group.map((p) => p.name), playerCount: count, maxMinutes: maxMin, youngestAge: youngest,
      weight: c.weight || null, coop: c.coop ?? null, themes: want, avoid, freshness: c.freshness || null, mood: c.mood || '' };
    return [{ json: { offTopic: false, gap, browse, matchIds, setFacts, understood, constraints: c, shortIds: short.map((g) => g.id),
      titles: Object.fromEntries(short.map((g) => [g.id, g.title])),
      // A browse is about the shelf: its own play counts only, unless they named people (one set of numbers, no mix-ups)
      gameLines: short.map((g) => line(g, browse && !(v.playerIds || []).length ? [] : group)).join('\n'), profiles: group.map(profile).join('\n'), ranked,
      askerProfile: asker && !group.includes(asker) ? profile(asker) : '', askerName: asker ? asker.name : '', ownerName: shelfOwner, guest, fromOwn: !!own,
      // Across friends' shelves: cards link to BGG and say who has each game; "at Keith's": whose shelf
      ...(fpool ? { across: true, off: short.map((g) => ({ id: g.id, title: g.title, bggId: g.bggId, cover: g.coverCard, friends: g.owners })) } : {}),
      ...(visit ? { visiting: sv.ownerName, visitShelf: 'friend:' + $('Own Shelf').first().json.fid } : {}) } }];
  }),
  ifTrue('On Topic?', '={{ !$json.offTopic }}'),
  ifTrue('Any Candidates?', '={{ $json.shortIds.length > 0 }}'),
  code('Build Recommend Request', function () {
    const v = $('Validate').first().json;
    const s = $input.first().json;
    const mentioned = new Set(v.mentioned || []);
    const system = [
      'You are Nathan Schmidt, the warm, welcoming and meticulous curator of Board Game Curator. This shelf is the board game collection of {SHELF_OWNER} (never say "owner", say {SHELF_OWNER}).',
      'Your job: get the right game from THIS shelf to the table for the right people, mood and occasion. You speak like an enthusiastic, articulate host walking a friend through the game room shelves.',
      '',
      'GROUNDING (most important):',
      '- Recommend only games from CANDIDATES, by id. Never invent games, numbers or rules.',
      '- Cite the key metrics from the candidate facts: the best player count ("the BGG community poll says it is best at 4"), play time, BGG weight, and primary mechanics. These facts come from BoardGameGeek, so you may attribute them to BGG.',
      '- Do not quote forums, Reddit or reviews: you have no access to them.',
      '- Plays are a hint, not a verdict: "Keith has played it 12 times" suggests he does not mind it, not that he loves it. Only a BGC or BGG rating says how much someone likes a game; say which one you mean.',
      '- Fit to the people comes first: each person\'s dials, likes, dislikes and notes; their plays, wins and ratings on each candidate; {SHELF_OWNER}\'s own star ratings and favorites; a game {SHELF_OWNER} may give away is a good last-chance pick. Name people by first name. Be kind about people and never judge anyone\'s taste: party games and heavy economic games deserve equal respect.',
      '',
      'VOICE:',
      '- You are talking with the ASKER: always call them "you" (never by their name, never "he" or "she"). Use first names only for other people.',
      ...($('Shelf View').first().json.v.askerName !== 'Nathan Schmidt' ? [
      '- You ARE Nathan Schmidt. Facts explicitly about Nathan Schmidt (his profile, his own shelf, his plays and ratings) are about you: say them in the first person ("I love engine builders", "I\'ve played Ark Nova 39 times", "on my shelf"). Everything else (the plays, wins and stars in CANDIDATES) belongs to the shelf owner or the people named, never to you.',
      ] : []),
      '- Warm and enthusiastically corny: wholesome dad jokes and puns about cardboard and meeples, gentle self-deprecating humor about shelf space and the shelf of shame. Humor is a light flourish and never crowds out the recommendation.',
      '- First mention: for a title NOT in ALREADY_JOKED, open its entry with a one-line dad-joke quip about that game. For titles in ALREADY_JOKED, leave quip empty.',
      '- Only if you are confident the game has an unlimited or substitutable component pool, or it supports an expanded player count, add exactly this joke in swapJoke: "The [component] can be substituted as needed, so if you ever run short, feel free to use a suitable replacement… like [funny, semi-related household item]." Otherwise null.',
      '',
      // Social answers: across friends' shelves say who owns each pick; at a friend's place it's their shelf
      ...(s.across ? ['SOCIAL: the CANDIDATES come from the asker\'s friends\' shelves, not the asker\'s own (never call them "your shelf"). Talk only about those friends\' copies: don\'t bring up the asker\'s own games or play counts, which are only there to show their taste. For every game you mention, say which friend owns it ("Matt has it, so ask him to bring it"), and note when the asker owns it too.'] : []),
      ...(s.visiting ? ['SOCIAL: they are playing at ' + s.visiting + '\'s place, so the CANDIDATES are ' + s.visiting + '\'s shelf. Say so naturally ("at ' + s.visiting + '\'s, I\'d pull down…").'] : []),
      ...(s.mode === 'rules' ? [
      'FORMAT: this is a rules question. Answer it clearly and correctly in "summary": short paragraphs or numbered steps (use line breaks), no fluff, no quips. For RULEBOOK EXCERPTS: answer only from the excerpts and say "per the rulebook"; if the excerpts don\'t cover the question, say so plainly and suggest which section of the rulebook to check. For a game with NO RULEBOOK UPLOADED: start with "From memory:" and answer from what you reliably know about the game; say when you\'re not sure of a detail, never invent specifics, and suggest checking the official rulebook. Highlights: just the game asked about, with an empty or one-line "why". gap is null.',
      ] : s.mode === 'game' ? [
      'FORMAT: this is a question about specific game(s), owned or not. If they ask whether someone owns it or who has it ("does Dan own Spirit Island?", "who has Brass?"), answer that first from the facts: "ON THEIR SHELF" means the ASKER owns it, and "friends who own it" names the friends who do (if a named person is not listed there, they don\'t own it, as far as you know). Answer it directly and completely in "summary" (2-5 sentences) from the CANDIDATES facts, which come from BoardGameGeek ("genre" means its categories and main mechanics; name a few of each). If a game is not on their shelf, say so, then say honestly how well it would suit them, comparing it to games on ASKER\'S SHELF they play and love and to their PROFILE. Only when the facts name friends who own it, mention they could try that friend\'s copy first (by name); never suggest a friend\'s copy otherwise. If it looks like a great fit and they don\'t own it, you may say it could be worth buying. Never invent facts; for things BGG data doesn\'t cover (rules details, reviews, prices), say you only have BGG\'s facts. Highlights: the game(s) asked about, one sentence of "why" each. gap is null.',
      ] : s.mode === 'buy' ? [
      'FORMAT: they want ideas for games to buy. Every CANDIDATE is a game they don\'t own. Pick the 3 that best fit their taste (ASKER\'S SHELF, PROFILE) and anything in the request. In "summary" (2-4 sentences) name your 3 picks and why, tied to games they already play and love. Only mention a friend owning a pick when the facts list that friend (then suggest trying their copy first). Highlights: the 3 picks, each with one or two sentences of "why". gap is null.',
      ] : s.person ? [
      'FORMAT: this is a question about a person, not a request for a game. In "summary" (3-6 sentences) tell them what you know, warmly and specifically: their own words first (likes, dislikes, dials, about), then their play history here (plays, wins, most played, rated 4+), and what that says about their taste. Speak to the ASKER as "you" when the question is about them; use first names for anyone else.',
      'Use only the facts in SET FACTS. If the profile is empty, say so kindly: when it is the ASKER\'s own, suggest filling in My profile (under their name, top left of the site) so you can do better; for anyone else, suggest nudging that person to fill in theirs. Then pick 3 to 5 highlights from CANDIDATES that best show their taste (most played or rated highest), each with one sentence of "why". gap is null.',
      ] : s.browse ? [
      'FORMAT: this is a question about what is on the shelf, not a request for one game. Sum up the matching games in "summary" (2-4 sentences): use the exact COUNT from SET FACTS, then what kinds they are (weights, lengths, mechanics, sub-themes) and any pattern in plays or favorites. Then pick 3 to 5 varied highlights from CANDIDATES that show the range (for example a favorite, a light one, a heavy one, one that is never played), each with one sentence of "why".',
      ...(s.ranked ? [
      'RANKED (the exact answer, in order): ' + s.ranked,
      ] : [
      'If SET FACTS has an ORDER, it is a ranked list: name the games in order with their numbers (e.g. "The Crew leads with 21 plays").',
      ]),
      'Answer the question fully in the summary, in natural sentences: if they ask for ten, name all ten (with their numbers, in order); if they ask whether they own something, say yes or no first. Never stop at a sample of what they asked for. Then add a sentence on what it says about their taste. Make the highlights 3 to 5 of the most interesting games from the answer.',
      ] : [
      'FORMAT: one headline pick and one contrasting alternative (for example lighter, faster, or a different feel). For each, a short vivid table-feel picture (1-3 sentences) of what playing it actually feels like.',
      'Keep each entry scannable: "why" is 2-4 sentences, data and people fit first.',
      ]),
      '',
      'HONEST GAPS: if GAP is true (nothing meets the hard limits), or the kind of game asked for (a genre, theme or mechanic) is not really on the shelf, say so plainly in gap.missing (one sentence, no guessing), make your pick the closest match, and you may name ONE real, well-known game not on this shelf that fills the gap in gap.consider (only if you are sure it exists). Never present it as owned. If the shelf has a true match, gap is null.',
      '',
      'Reply with JSON only:',
      ...(s.browse ? [
      '{"summary": "...", "highlights": [{"id": "...", "quip": "..." or "", "why": "..."}],',
      ] : [
      '{"pick": {"id": "...", "quip": "..." or "", "why": "...", "tableFeel": "...", "swapJoke": "..." or null},',
      ' "alternative": {"id": "...", "quip": "..." or "", "why": "...", "tableFeel": "..."} or null,',
      ' "avoid": {"id": "...", "why": "..."} or null (only if a candidate would clearly flop tonight),',
      ]),
      ' "gap": {"missing": "...", "consider": "Game title" or null} or null,',
      ' "signoff": "an optional short corny sign-off, or empty"}',
    ].join('\n');
    const systemText = system.split('{SHELF_OWNER}').join(s.ownerName || '__OWNER_NAME__');
    const user = [
      'REQUEST: ' + v.question,
      v.previous ? 'This follows up on: ' + v.previous.question : '',
      'UNDERSTOOD: ' + JSON.stringify(s.understood),
      'GAP: ' + (s.gap ? 'true' : 'false'),
      s.setFacts ? (s.person ? 'SET FACTS (about the people asked about):\n' : s.mode === 'rules' ? '' : s.mode ? 'ABOUT THE ASKER:\n' : 'SET FACTS (all games that match):\n') + s.setFacts : '',
      'ALREADY_JOKED: ' + (s.shortIds.filter((id) => mentioned.has(id)).join(', ') || '(none)'),
      s.askerName ? 'ASKER (the person typing; call them "you"): ' + s.askerName : '', s.guest || '',
      s.askerProfile ? 'ASKER PROFILE (use it when they ask for something they would like, even if they are not listed as playing):\n' + s.askerProfile : '',
      '', 'PEOPLE PLAYING:', s.profiles || '(not specified; recommend for the group described in the request)',
      '', 'CANDIDATES (id | title | facts | how each person relates to it):', s.gameLines,
    ].filter((l) => l !== '').join('\n');
    return [{ json: { ...s, requestBody: {
      model: '__ASK_MODEL__', models: ['__ASK_MODEL__', 'google/gemini-2.5-flash'], max_tokens: 2500, reasoning: { enabled: false }, provider: { data_collection: 'deny' },
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: user }],
    } } }];
  }),
  openrouter('Recommend'),
  code('Check Answer', function () {
    const s = $('Build Recommend Request').first().json;
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    let a = {};
    try { a = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
    const allowed = new Set(s.shortIds);
    const seen = new Set();
    // Nathan talks to the asker as "you": drop their name when he addresses them with it ("Yes, Dan, …", "Good news, Nathan:", "…, Dan.")
    const askerFirst = String($('Shelf View').first().json.v.askerName || '').split(' ')[0].replace(/[^\p{L}'-]/gu, '');
    const unname = (t) => !askerFirst ? t : t
      .replace(new RegExp('(^|[.!?]\\s+)((?:Yes|No|Good news|Great news|Well|So|Okay|Ok|Alright|Hey|Ah|Oh)\\s*)?,?\\s*' + askerFirst + '\\s*[,:]\\s*', 'g'), (m, lead, word) => lead + (word ? word.trim() + ', ' : ''))
      .replace(new RegExp(',\\s*' + askerFirst + '(?=[.!?,:;])', 'g'), '')
      .replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
    const str = (v, n) => unname(String(v || '').trim()).slice(0, n);
    const entry = (x, withFeel) => {
      if (!x || !allowed.has(String(x.id)) || seen.has(String(x.id))) return null;
      seen.add(String(x.id));
      const off = (s.off || []).find((o) => o.id === String(x.id)); // a game not on their shelf: BGG link, cover, friends who have it
      return { id: String(x.id), title: s.titles[x.id], quip: str(x.quip, 200), why: str(x.why, 700),
        ...(withFeel ? { tableFeel: str(x.tableFeel, 400) } : {}), ...(x.swapJoke ? { swapJoke: str(x.swapJoke, 300) } : {}), ...(off ? { off } : {}) };
    };
    const gapOf = () => (s.gap || (a.gap && a.gap.missing)) ? { missing: str(a.gap && a.gap.missing, 300) || 'Nothing on the shelf matches every part of that.', consider: str(a.gap && a.gap.consider, 80) || null } : null;
    if (s.browse) {
      const highlights = (Array.isArray(a.highlights) ? a.highlights : []).map((x) => entry(x, false)).filter(Boolean).slice(0, 5);
      if (!highlights.length) for (const id of s.shortIds.slice(0, 3)) highlights.push({ id, title: s.titles[id], quip: '', why: '' });
      const summary = str(a.summary, s.mode === 'rules' ? 3500 : 900) || (s.matchIds.length ? 'You have ' + s.matchIds.length + ' games like that on the shelf.' : '');
      return [{ json: { ok: true, intent: 'browse', mode: s.mode || null, person: !!s.person, social: s.across ? 'friends' : s.visiting ? 'visit' : null, ...(s.rulebooks ? { rulebooks: s.rulebooks } : {}), understood: s.understood, constraints: s.constraints, summary, highlights, gap: gapOf(),
        matchIds: s.matchIds, fromOwn: !!s.fromOwn, ...(s.visitShelf ? { visitShelf: s.visitShelf } : {}), signoff: str(a.signoff, 200), pickIds: highlights.map((x) => x.id), model: $input.first().json.model || null } }];
    }
    let pick = entry(a.pick, true);
    // Model failed or went off-list: fall back to the top of the scored shortlist
    if (!pick && s.shortIds.length) { const id = s.shortIds[0]; seen.add(id); pick = { id, title: s.titles[id], quip: '', why: 'The best fit on the shelf for what you described.', tableFeel: '' }; }
    const alternative = entry(a.alternative, true);
    const avoid = entry(a.avoid, false);
    const gap = gapOf();
    return [{ json: { ok: true, intent: 'recommend', social: s.across ? 'friends' : s.visiting ? 'visit' : null, matchIds: s.matchIds, understood: s.understood, constraints: s.constraints, pick, alternative, avoid, gap, fromOwn: !!s.fromOwn, ...(s.visitShelf ? { visitShelf: s.visitShelf } : {}),
      signoff: str(a.signoff, 200), pickIds: [pick, alternative].filter(Boolean).map((x) => x.id), model: $input.first().json.model || null } }];
  }),
  code('No Candidates', function () {
    const s = $input.first().json;
    return [{ json: { ok: true, fromOwn: !!s.fromOwn, matchIds: [], understood: s.understood, constraints: s.constraints, pick: null, alternative: null, avoid: null,
      gap: { missing: s.fromOwn ? 'Your shelf doesn’t have any games yet. Add some under My shelf and ask me again!'
        : (s.ownerName ? s.ownerName + '’s' : 'This') + ' shelf is empty, so there is nothing to pick from yet.', consider: null }, signoff: '', pickIds: [] } }];
  }),
  code('Off Topic', function () {
    return [{ json: { ok: true, offTopic: true, pick: null, note: $input.first().json.reply } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  // For the admin dashboard: what kind of question it was and how long it took (never the question itself)
  { ...pg('Log Answer', 'SELECT bgc.log_ask($1, $2, $3::int, $4::boolean, $5)',
    "={{ [$('Validate').first().json.email, $json.offTopic ? 'off-topic' : ($json.mode || ($json.person ? 'person' : $json.intent) || 'other'), String(Date.now() - $('Validate').first().json.t0), String($json.ok !== false), $json.social || ''] }}"),
    onError: 'continueRegularOutput' },
  respondError(),
], [
  ['Respond OK', 'Log Answer'],
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Use Allowance', 0], ['Valid?', 'Respond Error', 1],
  ['Use Allowance', 'Allowance Left?'], ['Allowance Left?', 'Allowed?'], ['Allowed?', 'Shelf View', 0], ['Allowed?', 'Respond Error', 1], ['Shelf View', 'List Games'],
  ['List Games', 'One Item'], ['One Item', 'List Players'], ['List Players', 'One More Item'], ['One More Item', 'List Ratings'],
  ['List Ratings', 'Build Understand Request'], ['Build Understand Request', 'Understand Request'], ['Understand Request', 'Scope'], ['Scope', 'Own Shelf'], ['Own Shelf', 'Game Lookup'], ['Game Lookup', 'Lookup Queries'], ['Lookup Queries', 'Ask BGG?'],
  ['Ask BGG?', 'Game Search', 0], ['Ask BGG?', 'Shortlist', 1], ['Game Search', 'Game Candidates'], ['Game Candidates', 'Game Thing'], ['Game Thing', 'Game Choose'], ['Game Choose', 'Shortlist'],
  ['Shortlist', 'On Topic?'], ['On Topic?', 'Any Candidates?', 0], ['On Topic?', 'Off Topic', 1],
  ['Any Candidates?', 'Build Recommend Request', 0], ['Any Candidates?', 'No Candidates', 1],
  ['Build Recommend Request', 'Recommend'], ['Recommend', 'Check Answer'],
  ['Check Answer', 'Respond OK'], ['No Candidates', 'Respond OK'], ['Off Topic', 'Respond OK'],
]);
addMemberAuth(ask, { failTo: 'Respond Error' });

// =====================================================================
// 19. My Profile  GET /webhook/vault/me  (member gate): the signed-in person's own player card
// =====================================================================
const me = wf(ID.me, 'Vault — My Profile', [
  webhook('Webhook', 'GET', 'vault/me'),
  pg('Get Profile', 'SELECT bgc.my_profile($1) AS profile', '={{ [$json._auth.email] }}'),
  code('Shape Profile', function () { return [{ json: { ok: true, profile: $input.first().json.profile || null } }]; }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Get Profile'], ['Get Profile', 'Shape Profile'], ['Shape Profile', 'Respond OK']]);
addMemberAuth(me, { failTo: 'Respond Error' });

// =====================================================================
// 20. Save My Profile  POST /webhook/vault/me-save { bggUsername, age, complexity, conflict, luck, tableTalk, theme (1-5 or null),
//     likes, dislikes, notes }  (member gate): people describe themselves; nobody edits someone else's profile
// =====================================================================
const meSave = wf(ID.meSave, 'Vault — Save My Profile', [
  webhook('Webhook', 'POST', 'vault/me-save'),
  code('Validate', function () {
    const j = $input.first().json;
    const b = j.body || {};
    const err = (status, message) => [{ json: { ok: false, status, message } }];
    const dial = (v) => (v === null || v === '' || v === undefined) ? null : Math.min(5, Math.max(1, Math.round(Number(v))));
    const text = (v, n = 600) => String(v ?? '').trim().slice(0, n);
    const bgg = text(b.bggUsername, 60);
    if (bgg && !/^[A-Za-z0-9_ .-]+$/.test(bgg)) return err(400, 'That BGG username doesn’t look right');
    // Saved on the member's own account (not a card on someone's shelf)
    const profile = {
      bggUsername: bgg || null,
      age: b.age === '' || b.age == null ? null : Math.max(1, Math.min(120, Math.round(Number(b.age)))) || null,
      complexity: dial(b.complexity), conflict: dial(b.conflict), luck: dial(b.luck), tableTalk: dial(b.tableTalk), theme: dial(b.theme),
      likes: text(b.likes), dislikes: text(b.dislikes), notes: text(b.notes),
      // Top 10 of all time, best first: BGG games only
      ...(Array.isArray(b.topGames) ? { topGames: b.topGames.map((g) => ({ bggId: Number(g && g.bggId) || 0, title: text(g && g.title, 200),
        cover: /^https:\/\/cf\.geekdo-images\.com\//.test(String((g && g.cover) || '')) ? String(g.cover) : null }))
        .filter((g, i, a) => g.bggId && g.title && a.findIndex((x) => x.bggId === g.bggId) === i).slice(0, 10) } : {}),
    };
    return [{ json: { ok: true, email: j._auth.email, profile } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Save Profile', 'SELECT bgc.save_profile($1, $2::jsonb) AS r', '={{ [$json.email, JSON.stringify($json.profile)] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Saved?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Save Profile', 0], ['Valid?', 'Respond Error', 1], ['Save Profile', 'Result'], ['Result', 'Saved?'], ['Saved?', 'Respond OK', 0], ['Saved?', 'Respond Error', 1]]);
addMemberAuth(meSave, { failTo: 'Respond Error' });

// =====================================================================
// 21. My Shelf  GET /webhook/vault/shelf  (member gate): the signed-in member's own shelf + import progress
// =====================================================================
const shelf = wf(ID.shelf, 'Vault — My Shelf', [
  webhook('Webhook', 'GET', 'vault/shelf'),
  pg('Read Shelf', 'SELECT bgc.shelf($1) AS shelf', '={{ [$json._auth.email] }}'),
  code('Shape For Frontend', function () {
    const s = $input.first().json.shelf || {};
    const items = (s.records || []).map(toGame).sort((a, b) => (a.num || 0) - (b.num || 0));
    return [{ json: { ok: true, name: s.name || '', bggUsername: s.bggUsername || '', status: s.status || {}, items } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Read Shelf'], ['Read Shelf', 'Shape For Frontend'], ['Shape For Frontend', 'Respond OK']]);
addMemberAuth(shelf, { failTo: 'Respond Error' });

// =====================================================================
// 22. Update My Shelf  POST /webhook/vault/shelf-update { id, fields: { favorite?, desireToPlay?, thinningCandidate? } }  (member gate)
// 23. Remove From My Shelf  POST /webhook/vault/shelf-remove { id }  (member gate)
//     Only the member's own copy; the shared catalog isn't editable here.
// =====================================================================
const shelfUpdate = wf(ID.shelfUpdate, 'Vault — Update My Shelf', [
  webhook('Webhook', 'POST', 'vault/shelf-update'),
  pg('Update', 'SELECT bgc.shelf_update($1, $2, $3::jsonb) AS r', '={{ [$json._auth.email, String(($json.body || {}).id || ""), JSON.stringify(($json.body || {}).fields || {})] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Updated?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Update'], ['Update', 'Result'], ['Result', 'Updated?'], ['Updated?', 'Respond OK', 0], ['Updated?', 'Respond Error', 1]]);
addMemberAuth(shelfUpdate, { failTo: 'Respond Error' });

const shelfRemove = wf(ID.shelfRemove, 'Vault — Remove From My Shelf', [
  webhook('Webhook', 'POST', 'vault/shelf-remove'),
  pg('Remove', 'SELECT bgc.shelf_remove($1, $2) AS r', '={{ [$json._auth.email, String(($json.body || {}).id || "")] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Removed?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Remove'], ['Remove', 'Result'], ['Result', 'Removed?'], ['Removed?', 'Respond OK', 0], ['Removed?', 'Respond Error', 1]]);
addMemberAuth(shelfRemove, { failTo: 'Respond Error' });

// =====================================================================
// 24. Connect BGG  POST /webhook/vault/import { bggUsername }  (member gate)
//     The shelf is managed here, not on BGG, so this brings in plays only (no games): every play from their BGG
//     account -> their player list. A game's plays count as soon as the game is on their shelf.
//     Answers right away ("started"); progress shows on /shelf.
// =====================================================================
const importBgg = wf(ID.importBgg, 'Vault — Connect BGG Plays', [
  webhook('Webhook', 'POST', 'vault/import'),
  code('Validate', function () {
    const j = $input.first().json;
    const username = String((j.body || {}).bggUsername || '').trim();
    if (!/^[A-Za-z0-9_ .-]{2,40}$/.test(username)) return [{ json: { ok: false, status: 400, message: 'Enter your BoardGameGeek username' } }];
    return [{ json: { ok: true, email: j._auth.email, username } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Start', 'SELECT bgc.start_import($1, $2) AS r', '={{ [$json.email, $json.username] }}'),
  code('Started?', function () { return [{ json: { ...$input.first().json.r, status: 409 } }]; }),
  ifTrue('Can Start?', '={{ $json.ok }}'),
  respond('Respond Started', '={{ JSON.stringify({ ok: true, started: true }) }}'),
  { ...node('BGG Plays', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/plays',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ username: "={{ $('Validate').first().json.username }}", type: 'thing', subtype: 'boardgame' }),
    options: {
      timeout: 30000,
      response: { response: { responseFormat: 'text', outputPropertyName: 'data' } },
      pagination: { pagination: {
        paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
        paginationCompleteWhen: 'other', completeExpression: '={{ !String($response.body).includes("<play ") }}',
        limitPagesFetched: true, maxRequests: 100, requestInterval: 2000,
      } },
    },
  }, { credentials: CRED.bgg, ...retry }), onError: 'continueRegularOutput' },
  code('Parse Plays', function () {
    const unxml = (v) => String(v || '').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const attr = (tag, k) => { const m = tag.match(new RegExp('\\b' + k + '="([^"]*)"')); return m ? unxml(m[1]) : ''; };
    const plays = [];
    for (const page of $input.all()) {
      for (const p of String(page.json.data || '').match(/<play [\s\S]*?<\/play>/g) || []) {
        const head = p.match(/<play [^>]*>/)[0];
        const item = (p.match(/<item [^>]*>/) || [''])[0];
        plays.push({ id: Number(attr(head, 'id')), date: attr(head, 'date'), quantity: Number(attr(head, 'quantity')) || 1,
          minutes: Number(attr(head, 'length')) || 0, incomplete: attr(head, 'incomplete') === '1', location: attr(head, 'location'),
          bggId: Number(attr(item, 'objectid')), gameName: attr(item, 'name'), comments: unxml((p.match(/<comments>([\s\S]*?)<\/comments>/) || ['', ''])[1]).trim(),
          players: (p.match(/<player [^>]*\/?>/g) || []).map((t, i) => ({ seat: i + 1, name: attr(t, 'name') || attr(t, 'username') || 'Anonymous',
            user: attr(t, 'username'), win: attr(t, 'win') === '1', score: attr(t, 'score'), isNew: attr(t, 'new') === '1' })) });
      }
    }
    const err = (String(($input.first() || { json: {} }).json.data || '').match(/<error>\s*<message>([^<]*)<\/message>/) || [])[1];
    if (err && !plays.length) return [{ json: { ok: false, message: err } }];
    return [{ json: { ok: true, plays: plays.filter((p) => p.id && p.bggId) } }];
  }),
  ifTrue('Plays OK?', '={{ $json.ok }}'),
  pg('Save Plays', 'SELECT at.save_plays($1, $2::jsonb) AS saved', "={{ [$('Validate').first().json.email, JSON.stringify($json.plays)] }}"),
  pg('Players And Counts', 'SELECT bgc.refresh_member($1) AS r', "={{ [$('Validate').first().json.email] }}"),
  pg('Done', "SELECT bgc.set_import($1, jsonb_build_object('state', 'done', 'step', 'Done', 'plays', $2::int, 'players', $3::int, 'finished', at.iso(now()))) AS s",
    "={{ [$('Validate').first().json.email, $('Save Plays').first().json.saved.plays, $json.r.players] }}"),
  pg('Failed', "SELECT bgc.set_import($1, jsonb_build_object('state', 'error', 'message', $2::text)) AS s", "={{ [$('Validate').first().json.email, $json.message] }}"),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Start', 0], ['Valid?', 'Respond Error', 1],
  ['Start', 'Started?'], ['Started?', 'Can Start?'], ['Can Start?', 'Respond Started', 0], ['Can Start?', 'Respond Error', 1],
  ['Respond Started', 'BGG Plays'], ['BGG Plays', 'Parse Plays'], ['Parse Plays', 'Plays OK?'], ['Plays OK?', 'Save Plays', 0], ['Plays OK?', 'Failed', 1],
  ['Save Plays', 'Players And Counts'], ['Players And Counts', 'Done'],
]);
addMemberAuth(importBgg, { failTo: 'Respond Error' });

// =====================================================================
// 24b. Add To My Shelf From CSV  POST /webhook/vault/shelf-csv { rows: [{ title, bggId, year }] }  (member gate)
//      The fast way to fill a big shelf. Answers right away; progress and anything not found show on /shelf.
//      Each row -> a BGG id (id column, their own logged plays, the shared catalog, else a BGG search: most-rated exact
//      match) -> BGG details and box art -> added like Add To My Shelf (base games first, so expansions land under them).
// =====================================================================
const shelfCsv = wf(ID.shelfCsv, 'Vault — Add To My Shelf From CSV', [
  webhook('Webhook', 'POST', 'vault/shelf-csv'),
  code('Validate', function () {
    const j = $input.first().json;
    const rows = Array.isArray((j.body || {}).rows) ? j.body.rows : [];
    if (rows.length > 2000) return [{ json: { ok: false, status: 400, message: 'That’s more than 2,000 games. Split the file in two.' } }];
    const clean = rows.map((r) => ({ title: String((r && r.title) || '').trim().slice(0, 200), bggId: String((r && r.bggId) || '').replace(/\D/g, '').slice(0, 7),
      year: String((r && r.year) || '').replace(/\D/g, '').slice(0, 4) })).filter((r) => r.title || r.bggId);
    if (!clean.length) return [{ json: { ok: false, status: 400, message: 'No game names found in that file' } }];
    return [{ json: { ok: true, email: j._auth.email, rows: clean } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Start', 'SELECT bgc.start_csv($1, $2::jsonb) AS r', '={{ [$json.email, JSON.stringify($json.rows)] }}'),
  code('Started?', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Can Start?', '={{ $json.ok }}'),
  respond('Respond Started', '={{ JSON.stringify({ ok: true, started: true, matched: $json.ids.length, lookingUp: $json.search.length, alreadyHad: $json.alreadyHad }) }}'),
  pg('Progress: Looking Up', "SELECT bgc.set_import($1, jsonb_build_object('step', $2::text)) AS s",
    "={{ [$('Validate').first().json.email, $('Start').first().json.r.search.length ? 'Looking up ' + $('Start').first().json.r.search.length + ' games on BGG' : 'Getting game details and box art'] }}"),
  code('One Item Per Title', function () {
    const search = $('Start').first().json.r.search || [];
    return search.length ? search.map((t) => ({ json: { title: t.title, year: t.year || null, query: String(t.title).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim() } }))
      : [{ json: { none: true } }];
  }),
  ifTrue('Anything To Look Up?', '={{ !$json.none }}'),
  { ...node('BGG Search', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/search',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ query: '={{ $json.query }}', type: 'boardgame,boardgameexpansion' }),
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1200 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg, ...retry }), onError: 'continueRegularOutput' },
  code('Candidates', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const asked = $('One Item Per Title').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const t = normTitle(asked[i].title);
      const items = [...String(res.json.data || '').matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)]
        .map((m) => ({ id: m[2], name: decode((m[3].match(/<name type="[^"]+" value="([^"]*)"/) || [])[1] || ''), year: Number((m[3].match(/<yearpublished value="(\d+)"/) || [])[1]) || null }));
      let pool = items.filter((x) => normTitle(x.name) === t);
      if (asked[i].year && pool.some((x) => x.year === Number(asked[i].year))) pool = pool.filter((x) => x.year === Number(asked[i].year));
      return { json: { ids: [...new Set(pool.map((x) => x.id))].slice(0, 20).join(',') } };
    });
  }),
  { ...node('BGG Search Thing', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/thing',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ id: '={{ $json.ids || 0 }}', stats: '1' }),
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1200 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg, ...retry }), onError: 'continueRegularOutput' },
  code('Choose', function () {
    const asked = $('One Item Per Title').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const usersRated = (id) => Number(((String(res.json.data || '').match(new RegExp('<item type="[^"]+" id="' + id + '">[\\s\\S]*?<usersrated value="(\\d+)"')) || [])[1]) || 0);
      const things = parseThingXml(res.json.data).sort((a, b) => ((b.type === 'boardgame') - (a.type === 'boardgame')) || (usersRated(b.id) - usersRated(a.id)));
      return { json: { title: asked[i].title, id: things[0] ? Number(things[0].id) : null } };
    });
  }),
  { ...pg('Progress: Details', "SELECT bgc.set_import($1, jsonb_build_object('step', 'Getting game details and box art')) AS s",
    "={{ [$('Validate').first().json.email] }}"), executeOnce: true },
  code('Detail Batches', function () {
    const start = $('Start').first().json.r;
    let chosen = [];
    try { chosen = $('Choose').all().map((i) => i.json); } catch (e) { chosen = []; }
    const ids = [...new Set([...(start.ids || []).map(Number), ...chosen.filter((c) => c.id).map((c) => c.id)])];
    const out = [];
    for (let i = 0; i < ids.length; i += 20) out.push({ json: { ids: ids.slice(i, i + 20).join(',') } });
    return out.length ? out : [{ json: { ids: '' } }];
  }),
  { ...node('BGG Thing', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/thing',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ id: '={{ $json.ids || 0 }}', stats: '1' }),
    options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 2500 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg, ...retry }), onError: 'continueRegularOutput' },
  code('Parse Details', function () {
    const things = $input.all().flatMap((page) => parseThingXml(page.json.data));
    return things.length ? things.map((t) => ({ json: t })) : [{ json: { none: true } }];
  }),
  { ...node('BGG Image Sizes', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: '=https://api.geekdo.com/api/images/{{ $json.picId || 0 }}',
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 250 } } },
  }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }), onError: 'continueRegularOutput' },
  code('Add Covers', function () {
    const things = $('Parse Details').all().map((i) => i.json);
    const imgs = $input.all().map((i) => i.json.images || {});
    const out = things.map((t, i) => {
      const im = imgs[i] || {};
      return { ...t, coverCard: im.medium?.url || im.itempage?.url || null, coverLarge: im.itempage?.url || im.medium?.url || null };
    }).filter((t) => !t.none);
    let chosen = [];
    try { chosen = $('Choose').all().map((i) => i.json); } catch (e) { chosen = []; }
    const notFound = chosen.filter((c) => !c.id).map((c) => c.title);
    return [{ json: { things: out, notFound } }];
  }),
  pg('Add All', 'SELECT bgc.csv_add($1, $2::jsonb, $3::jsonb, $4::int) AS r',
    "={{ [$('Validate').first().json.email, JSON.stringify($json.things), JSON.stringify($json.notFound), $('Start').first().json.r.alreadyHad] }}"),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Start', 0], ['Valid?', 'Respond Error', 1],
  ['Start', 'Started?'], ['Started?', 'Can Start?'], ['Can Start?', 'Respond Started', 0], ['Can Start?', 'Respond Error', 1],
  ['Respond Started', 'Progress: Looking Up'], ['Progress: Looking Up', 'One Item Per Title'], ['One Item Per Title', 'Anything To Look Up?'],
  ['Anything To Look Up?', 'BGG Search', 0], ['Anything To Look Up?', 'Progress: Details', 1],
  ['BGG Search', 'Candidates'], ['Candidates', 'BGG Search Thing'], ['BGG Search Thing', 'Choose'], ['Choose', 'Progress: Details'],
  ['Progress: Details', 'Detail Batches'], ['Detail Batches', 'BGG Thing'], ['BGG Thing', 'Parse Details'],
  ['Parse Details', 'BGG Image Sizes'], ['BGG Image Sizes', 'Add Covers'], ['Add Covers', 'Add All'],
]);
addMemberAuth(shelfCsv, { failTo: 'Respond Error' });

// =====================================================================
// 25. Error Alert  (n8n error workflow for every Board Game Curator workflow): emails Dan when one fails.
//     At most one email per workflow per 30 minutes, so a bad night doesn't flood the inbox.
// 26. Health Check  daily: emails Dan if the nightly database backup hasn't succeeded in 26 hours.
// =====================================================================
const ALERT_FROM = 'Board Game Curator <alpha@ondorilabo.com>';
const ALERT_TO = OWNER_EMAILS[0];
const email = (name, subjectExpr, textExpr) => node(name, 'n8n-nodes-base.emailSend', 2.1, {
  fromEmail: ALERT_FROM, toEmail: ALERT_TO, subject: subjectExpr, emailFormat: 'text', text: textExpr, options: { appendAttribution: false },
}, { credentials: CRED.smtp, ...retry });
const errorAlert = wf(ID.errorAlert, 'Vault — Error Alert', [
  node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, {}),
  code('Compose', function () {
    const e = $input.first().json;
    const wfName = (e.workflow && e.workflow.name) || 'A workflow';
    const ex = e.execution || {};
    const st = $getWorkflowStaticData('global');
    const key = (e.workflow && e.workflow.id) || wfName;
    const now = Date.now();
    if (st[key] && now - st[key] < 30 * 60 * 1000) return [{ json: { send: false } }];
    st[key] = now;
    const msg = (ex.error && (ex.error.message || ex.error.description)) || 'Unknown error';
    return [{ json: { send: true,
      subject: 'Board Game Curator: "' + wfName.replace(/^Vault — /, '') + '" failed',
      text: [
        'Something went wrong in Board Game Curator.', '',
        'Workflow: ' + wfName,
        'Failed at: ' + (ex.lastNodeExecuted || 'unknown step'),
        'Error: ' + msg,
        'When: ' + new Date().toISOString(), '',
        ex.url ? 'Details: ' + ex.url : (ex.id ? 'Execution id: ' + ex.id : ''),
        '', '(More failures from this workflow in the next 30 minutes will not send another email.)',
      ].filter((l) => l !== null).join('\n') } }];
  }),
  ifTrue('Send?', '={{ $json.send }}'),
  email('Email Dan', '={{ $json.subject }}', '={{ $json.text }}'),
], [['Error Trigger', 'Compose'], ['Compose', 'Send?'], ['Send?', 'Email Dan', 0]]);

const healthCheck = wf(ID.healthCheck, 'Vault — Health Check', [
  node('Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ triggerAtHour: 9 }] } }),
  pg('Read Status', "SELECT (SELECT max(at) FROM backup_runs WHERE ok) AS last_ok, (SELECT message FROM backup_runs WHERE NOT ok ORDER BY at DESC LIMIT 1) AS last_error, (SELECT max(at) FROM backup_runs WHERE NOT ok) AS last_fail, (SELECT max(played_on) FROM plays) AS newest_play"),
  code('Check', function () {
    const s = $input.first().json;
    const problems = [];
    const lastOk = s.last_ok ? new Date(s.last_ok) : null;
    if (!lastOk || Date.now() - lastOk.getTime() > 26 * 3600 * 1000) {
      problems.push('The nightly database backup has not succeeded since ' + (lastOk ? lastOk.toISOString() : 'it was set up') + '.'
        + (s.last_error ? '\nLast error: ' + String(s.last_error).slice(-400) : ''));
    }
    if (!problems.length) return [{ json: { send: false } }];
    return [{ json: { send: true, subject: 'Board Game Curator: backups need attention',
      text: problems.join('\n\n') + '\n\nBackups go to the private GitHub repo daddo78/bgc-backups from the bgc-backup container on the Hostinger server.' } }];
  }),
  ifTrue('Send?', '={{ $json.send }}'),
  email('Email Dan', '={{ $json.subject }}', '={{ $json.text }}'),
], [['Daily', 'Read Status'], ['Read Status', 'Check'], ['Check', 'Send?'], ['Send?', 'Email Dan', 0]]);

// =====================================================================
// 27. Add To My Shelf  POST /webhook/vault/shelf-add { bggId } | { title }  (member gate)
//     A game anyone already has comes straight from the shared catalog; a new one gets its BGG details and box art.
//     An expansion of a game on the member's shelf is listed under that game.
// =====================================================================
const shelfAdd = wf(ID.shelfAdd, 'Vault — Add To My Shelf', [
  webhook('Webhook', 'POST', 'vault/shelf-add'),
  code('Validate', function () {
    const j = $input.first().json;
    const b = j.body || {};
    const bggId = Number(b.bggId) || null;
    const title = String(b.title || '').trim().slice(0, 200);
    if (!bggId && !title) return [{ json: { ok: false, status: 400, message: 'Send a bggId, or a title for a game that is not on BGG' } }];
    return [{ json: { ok: true, email: j._auth.email, bggId, title } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  ifTrue('On BGG?', '={{ !!$json.bggId }}'),
  { ...textGet('BGG Thing', 'https://boardgamegeek.com/xmlapi2/thing', qs({ id: '={{ $json.bggId }}', stats: '1' }), CRED.bgg), onError: 'continueRegularOutput' },
  code('Parse Thing', function () {
    const t = parseThingXml($input.first().json.data)[0];
    if (!t) return [{ json: { ok: false, status: 404, message: 'BGG has no game #' + $('Validate').first().json.bggId } }];
    return [{ json: { ok: true, thing: t } }];
  }),
  ifTrue('Found On BGG?', '={{ $json.ok }}'),
  { ...node('BGG Image Sizes', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: '=https://api.geekdo.com/api/images/{{ $json.thing.picId || 0 }}', options: { timeout: 20000 },
  }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }), onError: 'continueRegularOutput' },
  code('Add Cover', function () {
    const t = $('Parse Thing').first().json.thing;
    const im = $input.first().json.images || {};
    return [{ json: { thing: { ...t, coverCard: im.medium?.url || im.itempage?.url || null, coverLarge: im.itempage?.url || im.medium?.url || null } } }];
  }),
  code('Title Only', function () { return [{ json: { thing: null } }]; }),
  pg('Add', 'SELECT bgc.shelf_add($1, $2::jsonb, $3) AS r',
    "={{ [$('Validate').first().json.email, JSON.stringify($json.thing || null), $('Validate').first().json.title] }}"),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Added?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'On BGG?', 0], ['Valid?', 'Respond Error', 1],
  ['On BGG?', 'BGG Thing', 0], ['On BGG?', 'Title Only', 1], ['BGG Thing', 'Parse Thing'], ['Parse Thing', 'Found On BGG?'],
  ['Found On BGG?', 'BGG Image Sizes', 0], ['Found On BGG?', 'Respond Error', 1], ['BGG Image Sizes', 'Add Cover'],
  ['Add Cover', 'Add'], ['Title Only', 'Add'], ['Add', 'Result'], ['Result', 'Added?'], ['Added?', 'Respond OK', 0], ['Added?', 'Respond Error', 1],
]);
addMemberAuth(shelfAdd, { failTo: 'Respond Error' });

// =====================================================================
// 28. Add To My Shelf From Photo  POST /webhook/vault/shelf-identify  multipart { photo }  (member gate)
//     The member's version of the photo add: read the boxes, skip what's already on their shelf, look each new title
//     up on BGG (most-rated exact match), then add it like Add To My Shelf (expansions go under their base game).
//     The photo is deleted when the request ends and no execution data is kept.
// =====================================================================
const shelfIdentify = wf(ID.shelfIdentify, 'Vault — Add To My Shelf From Photo', [
  webhook('Webhook', 'POST', 'vault/shelf-identify'),
  node('Photo To Base64', 'n8n-nodes-base.extractFromFile', 1, {
    operation: 'binaryToPropery', binaryPropertyName: '={{ Object.keys($binary)[0] }}', destinationKey: 'photoB64', options: {},
  }),
  pg('Read Shelf', 'SELECT bgc.shelf($1) AS shelf', "={{ [$('Auth: Role').first().json._auth.email] }}"),
  code('Build Vision Request', function () {
    const bin = $('Webhook').first().binary || {};
    const key = Object.keys(bin)[0];
    if (!key) throw new Error('No photo uploaded');
    const mime = bin[key].mimeType || 'image/jpeg';
    const b64 = $('Photo To Base64').first().json.photoB64;
    const owned = (($input.first().json.shelf || {}).records || []).map(toGame).map((g) => g.title).sort();
    const instructions = [
      'Identify every board game box visible in this photo (fronts, backs or spines). Skip anything you cannot read confidently.',
      'Reply with JSON only:',
      '{"items": [{"title": "official title as printed", "kind": "game" or "expansion", "baseGame": "for an expansion, the game it expands; else null",',
      '  "owned": "if this is the same game (any edition, spelling or language) as a title in OWNED, that exact OWNED title; else null. An expansion is never the same game as its base game",',
      '  "confidence": 0.0-1.0}], "reason": "only if no boxes could be identified"}',
      '', 'OWNED:', ...owned,
    ].join('\n');
    return [{ json: { requestBody: {
      model: '__VISION_MODEL__', max_tokens: 4000, reasoning: { enabled: false }, provider: { data_collection: 'deny' },
      messages: [
        { role: 'system', content: 'You identify board games from photos for a personal collection catalog. Reply with JSON only.' },
        { role: 'user', content: [{ type: 'text', text: instructions }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] },
      ],
    } } }];
  }),
  openrouter('Ask Vision Model'),
  code('Plan', function () {
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    let r = {};
    try { r = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch (e) {}
    const found = (Array.isArray(r.items) ? r.items : []).filter((i) => i && i.title && (i.confidence == null || Number(i.confidence) >= 0.5))
      .map((i) => ({ title: String(i.title).trim(), kind: i.kind === 'expansion' ? 'expansion' : 'game', baseGame: i.baseGame ? String(i.baseGame) : null, owned: i.owned ? String(i.owned) : null }));
    if (!found.length) return [{ json: { ok: false, status: 422, message: 'Could not identify a game in that photo' + (r.reason ? ': ' + r.reason : '') } }];
    const games = (($('Read Shelf').first().json.shelf || {}).records || []).map(toGame);
    const byTitle = new Map(games.map((g) => [normTitle(g.title), g]));
    const expansionOwner = new Map();
    for (const g of games) for (const e of g.expansions) expansionOwner.set(normTitle(e), g);
    const skipped = [], todo = [], deferred = [], seen = new Set();
    for (const it of found) {
      const key = normTitle(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      const same = byTitle.get(key) || (it.owned && it.kind !== 'expansion' ? byTitle.get(normTitle(it.owned)) : null);
      if (same) { skipped.push({ title: it.title, reason: 'already on your shelf', existing: same.title }); continue; }
      const owner = expansionOwner.get(key);
      if (owner) { skipped.push({ title: it.title, reason: 'already listed as an expansion', existing: owner.title }); continue; }
      if (todo.length >= 8) { deferred.push(it.title); continue; } // keeps the request inside Cloudflare's ~100s limit
      todo.push(it);
    }
    return [{ json: { ok: true, todo, skipped, deferred } }];
  }),
  ifTrue('Identified?', '={{ $json.ok }}'),
  code('One Item Per Title', function () {
    const p = $input.first().json;
    return p.todo.length ? p.todo.map((t) => ({ json: { ...t, query: t.title.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim() } })) : [{ json: { none: true } }];
  }),
  ifTrue('Anything New?', '={{ !$json.none }}'),
  { ...node('BGG Search', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/search',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ query: '={{ $json.query }}', type: 'boardgame,boardgameexpansion' }),
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1200 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg, ...retry }), onError: 'continueRegularOutput' },
  code('Candidates', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const asked = $('One Item Per Title').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const t = normTitle(asked[i].title);
      const items = [...String(res.json.data || '').matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)]
        .map((m) => ({ id: m[2], name: decode((m[3].match(/<name type="[^"]+" value="([^"]*)"/) || [])[1] || '') }));
      let pool = items.filter((x) => normTitle(x.name) === t);
      if (!pool.length) pool = items.filter((x) => { const n = normTitle(x.name); return n && (n.startsWith(t + ' ') || t.startsWith(n + ' ')); });
      return { json: { ids: [...new Set(pool.map((x) => x.id))].slice(0, 20).join(',') } };
    });
  }),
  { ...node('BGG Thing', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/thing',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    ...qs({ id: '={{ $json.ids || 0 }}', stats: '1' }),
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 1200 } }, response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { credentials: CRED.bgg, ...retry }), onError: 'continueRegularOutput' },
  code('Choose', function () {
    const asked = $('One Item Per Title').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const want = asked[i].kind === 'expansion' ? 'boardgameexpansion' : 'boardgame';
      const usersRated = (id) => Number(((String(res.json.data || '').match(new RegExp('<item type="[^"]+" id="' + id + '">[\\s\\S]*?<usersrated value="(\\d+)"')) || [])[1]) || 0);
      const things = parseThingXml(res.json.data).sort((a, b) => ((b.type === want) - (a.type === want)) || (usersRated(b.id) - usersRated(a.id)));
      return { json: { title: asked[i].title, thing: things[0] || null } };
    });
  }),
  { ...node('BGG Image Sizes', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: '=https://api.geekdo.com/api/images/{{ ($json.thing && $json.thing.picId) || 0 }}',
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 250 } } },
  }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }), onError: 'continueRegularOutput' },
  code('Add Covers', function () {
    const chosen = $('Choose').all().map((i) => i.json);
    return $input.all().map((res, i) => {
      const c = chosen[i];
      const im = res.json.images || {};
      return { json: { title: c.title, thing: c.thing ? { ...c.thing, coverCard: im.medium?.url || im.itempage?.url || null, coverLarge: im.itempage?.url || im.medium?.url || null } : null } };
    });
  }),
  pg('Add', 'SELECT bgc.shelf_add($1, $2::jsonb, $3) AS r',
    "={{ [$('Auth: Role').first().json._auth.email, JSON.stringify($json.thing || null), $json.title] }}"),
  code('Summary', function () {
    const plan = $('Plan').first().json;
    const results = $('Add').isExecuted ? $('Add').all().map((i) => i.json.r || {}) : [];
    const added = results.flatMap((r) => r.added || []);
    const expansions = results.flatMap((r) => r.expansions || []);
    const skipped = [...plan.skipped, ...results.filter((r) => r.ok === false && r.status === 409).map((r) => ({ title: (r.message || '').replace(/^"|".*$/g, ''), reason: r.message }))];
    return [{ json: { ok: true, added, expansions, skipped, deferred: plan.deferred, title: added[0]?.title || null } }];
  }),
  deleteUploads('Delete Photo'),
  deleteUploads('Delete Photo (no match)'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Photo To Base64'], ['Photo To Base64', 'Read Shelf'], ['Read Shelf', 'Build Vision Request'],
  ['Build Vision Request', 'Ask Vision Model'], ['Ask Vision Model', 'Plan'], ['Plan', 'Identified?'],
  ['Identified?', 'One Item Per Title', 0], ['Identified?', 'Delete Photo (no match)', 1], ['Delete Photo (no match)', 'Respond Error'],
  ['One Item Per Title', 'Anything New?'], ['Anything New?', 'BGG Search', 0], ['Anything New?', 'Summary', 1],
  ['BGG Search', 'Candidates'], ['Candidates', 'BGG Thing'], ['BGG Thing', 'Choose'], ['Choose', 'BGG Image Sizes'],
  ['BGG Image Sizes', 'Add Covers'], ['Add Covers', 'Add'], ['Add', 'Summary'], ['Summary', 'Delete Photo'], ['Delete Photo', 'Respond OK'],
], { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false });
addMemberAuth(shelfIdentify, { failTo: 'Delete Photo (no match)' });

// =====================================================================
// 29. Friends  GET /webhook/vault/friends            -> { code, friends: [{ id, name, firstName, games }] }
//              GET /webhook/vault/friends?shelf=<id>  -> a friend's shelf, view only (thinning hidden)   (member gate)
// 30. Friends  POST /webhook/vault/friends { action: 'add', code } | { action: 'remove', id }      (member gate)
//     Entering someone's code connects you both right away.
// =====================================================================
const friends = wf(ID.friends, 'Vault — Friends', [
  webhook('Webhook', 'GET', 'vault/friends'),
  // substring() yields NULL (not '') when there's no shelf id, so the cast never sees an empty string
  pg('Read', "SELECT CASE WHEN $2 ~ '^\\d+$' THEN bgc.friend_shelf($1, substring($2 from '^\\d+$')::bigint) ELSE bgc.friends($1) END AS r",
    "={{ [$json._auth.email, String(($json.query || {}).shelf || '')] }}"),
  code('Shape', function () {
    const r = $input.first().json.r || {};
    if (r.ok === false) return [{ json: r }];
    if (r.records) return [{ json: { ok: true, name: r.name, items: r.records.map(toGame).sort((a, b) => (a.num || 0) - (b.num || 0)) } }];
    return [{ json: { ok: true, code: r.code, friends: r.friends || [] } }];
  }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Read'], ['Read', 'Shape'], ['Shape', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(friends, { failTo: 'Respond Error' });

const friendsChange = wf(ID.friendsChange, 'Vault — Friends (add / remove)', [
  webhook('Webhook', 'POST', 'vault/friends'),
  pg('Change', "SELECT CASE WHEN $2 = 'remove' THEN bgc.remove_friend($1, nullif($4, '')::bigint) ELSE bgc.add_friend($1, $3) END AS r",
    "={{ [$json._auth.email, String(($json.body || {}).action || 'add'), String(($json.body || {}).code || ''), String(Number(($json.body || {}).id) || '')] }}"),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Change'], ['Change', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(friendsChange, { failTo: 'Respond Error' });

// =====================================================================
// 29. Wishlist  GET /webhook/vault/wishlist[?friend=<memberId>]  (member gate): yours, or a friend's (gift ideas)
//     POST /webhook/vault/wishlist { action: add|remove, bggId, title, cover }: change your own
// =====================================================================
const wishlist = wf(ID.wishlist, 'Vault — Wishlist', [
  webhook('Webhook', 'GET', 'vault/wishlist'),
  pg('Read', "SELECT bgc.wishlist($1, nullif($2, '')::bigint) AS r",
    "={{ [$json._auth.email, String(Number(($json.query || {}).friend) || '')] }}"),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Read'], ['Read', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(wishlist, { failTo: 'Respond Error' });

const wishChange = wf(ID.wishChange, 'Vault — Wishlist (add / remove)', [
  webhook('Webhook', 'POST', 'vault/wishlist'),
  code('Validate', function () {
    const j = $input.first().json;
    const b = j.body || {};
    const bggId = Number(b.bggId) || 0;
    if (!bggId) return [{ json: { ok: false, status: 400, message: 'Pick a game from BoardGameGeek' } }];
    const cover = /^https:\/\/cf\.geekdo-images\.com\//.test(String(b.cover || '')) ? String(b.cover) : '';
    return [{ json: { ok: true, email: j._auth.email, action: b.action === 'remove' ? 'remove' : 'add', bggId, title: String(b.title || '').trim().slice(0, 200), cover } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Change', 'SELECT bgc.wish_change($1, $2, $3::int, $4, $5) AS r', '={{ [$json.email, $json.action, String($json.bggId), $json.title, $json.cover] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Change', 0], ['Valid?', 'Respond Error', 1], ['Change', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(wishChange, { failTo: 'Respond Error' });

// =====================================================================
// 30. Profile Page  GET /webhook/vault/profile[?friend=<memberId>]  (member gate): yours or a friend's
//     Their own words, Top 10 of all time, wishlist and a few numbers from their shelf.
// =====================================================================
const profilePage = wf(ID.profilePage, 'Vault — Profile Page', [
  webhook('Webhook', 'GET', 'vault/profile'),
  pg('Read', "SELECT bgc.profile_page($1, nullif($2, '')::bigint) AS r",
    "={{ [$json._auth.email, String(Number(($json.query || {}).friend) || '')] }}"),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Read'], ['Read', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(profilePage, { failTo: 'Respond Error' });

// =====================================================================
// 31. Admin  GET /webhook/vault/admin (admins): site-wide usage, the last 30 days, and every member
//     POST /webhook/vault/admin { action: invite|remove|admin|resetAsks|askLimit, target, email, name, on, value }
// =====================================================================
const admin = wf(ID.admin, 'Vault — Admin', [
  webhook('Webhook', 'GET', 'vault/admin'),
  pg('Overview', 'SELECT bgc.admin_overview($1) AS r', '={{ [$json._auth.email] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Overview'], ['Overview', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(admin, { failTo: 'Respond Error' });

const adminAction = wf(ID.adminAction, 'Vault — Admin (actions)', [
  webhook('Webhook', 'POST', 'vault/admin'),
  code('Validate', function () {
    const j = $input.first().json;
    const b = j.body || {};
    const action = String(b.action || '');
    if (!['invite', 'remove', 'admin', 'resetAsks', 'askLimit'].includes(action)) return [{ json: { ok: false, status: 400, message: 'Unknown action' } }];
    const v = { email: String(b.email || '').trim().slice(0, 200), name: String(b.name || '').trim().slice(0, 80), on: b.on === true, value: Number(b.value) || null };
    return [{ json: { ok: true, email: j._auth.email, action, target: String(Number(b.target) || ''), v } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Act', "SELECT bgc.admin_action($1, $2, nullif($3, '')::bigint, $4::jsonb) AS r", '={{ [$json.email, $json.action, $json.target, JSON.stringify($json.v)] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Act', 0], ['Valid?', 'Respond Error', 1], ['Act', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(adminAction, { failTo: 'Respond Error' });

// =====================================================================
// 32. Rulebook  POST /webhook/vault/rulebook  multipart { file (PDF), bggId, title }  (member gate)
//     Saves a game's rulebook for every member, with its text for Nathan to answer rules questions from.
//     GET /webhook/vault/rulebook?bgg=<id>            -> { has, filename, pages, uploadedBy, ... }
//     GET /webhook/vault/rulebook?bgg=<id>&download=1 -> the PDF
// =====================================================================
const rulebookUpload = wf(ID.rulebookUpload, 'Vault — Rulebook (upload)', [
  webhook('Webhook', 'POST', 'vault/rulebook'),
  code('Validate', function () {
    const item = $input.first();
    const b = item.json.body || {};
    const key = Object.keys(item.binary || {})[0];
    const err = (status, message) => [{ json: { ok: false, status, message } }];
    if (!key) return err(400, 'Choose a PDF to upload');
    const f = item.binary[key];
    if (!/pdf/i.test(f.mimeType || '') && !/\.pdf$/i.test(f.fileName || '')) return err(400, 'Rulebooks need to be PDFs');
    const bggId = Number(b.bggId) || 0;
    if (!bggId) return err(400, 'Which game is this rulebook for?');
    // Pass the file along under a fixed name for the PDF reader
    return [{ json: { ok: true, email: item.json._auth.email, bggId, title: String(b.title || '').slice(0, 200), filename: String(f.fileName || 'rulebook.pdf').slice(0, 200) },
      binary: { pdf: f } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  { ...node('Read PDF Text', 'n8n-nodes-base.extractFromFile', 1, { operation: 'pdf', binaryPropertyName: 'pdf', options: { keepSource: 'both', joinPages: true } }),
    onError: 'continueRegularOutput' },
  node('PDF To Base64', 'n8n-nodes-base.extractFromFile', 1, { operation: 'binaryToPropery', binaryPropertyName: 'pdf', destinationKey: 'b64', options: {} }),
  pg('Save', 'SELECT bgc.rulebook_save($1, $2::int, $3, $4, $5, $6, nullif($7, \'\')::int) AS r',
    "={{ [$('Validate').first().json.email, String($('Validate').first().json.bggId), $('Validate').first().json.title, $('Validate').first().json.filename, $json.b64, String($('Read PDF Text').first().json.text || '').replace(/\\u0000/g, '').slice(0, 600000), String($('Read PDF Text').first().json.numpages || '')] }}"),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('Saved?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Read PDF Text', 0], ['Valid?', 'Respond Error', 1], ['Read PDF Text', 'PDF To Base64'],
  ['PDF To Base64', 'Save'], ['Save', 'Result'], ['Result', 'Saved?'], ['Saved?', 'Respond OK', 0], ['Saved?', 'Respond Error', 1]]);
addMemberAuth(rulebookUpload, { failTo: 'Respond Error' });

const rulebookGet = wf(ID.rulebookGet, 'Vault — Rulebook (info / open)', [
  webhook('Webhook', 'GET', 'vault/rulebook'),
  ifTrue('Download?', "={{ String(($json.query || {}).download || '') === '1' }}"),
  pg('Info', 'SELECT bgc.rulebook_info($1, $2::int) AS r', "={{ [$json._auth.email, String(Number(($json.query || {}).bgg) || 0)] }}"),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  { ...pg('File', 'SELECT * FROM bgc.rulebook_file($1, $2::int)', "={{ [$json._auth.email, String(Number(($json.query || {}).bgg) || 0)] }}"), alwaysOutputData: true },
  code('Found?', function () {
    const f = $input.first().json;
    return [{ json: f && f.b64 ? { ok: true, filename: f.filename, b64: f.b64 } : { ok: false, status: 404, message: 'No rulebook for that game yet' } }];
  }),
  ifTrue('Have File?', '={{ $json.ok }}'),
  node('To File', 'n8n-nodes-base.convertToFile', 1.1, { operation: 'toBinary', sourceProperty: 'b64', binaryPropertyName: 'data',
    options: { fileName: '={{ $json.filename }}', mimeType: 'application/pdf' } }),
  node('Respond PDF', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'binary', inputDataFieldName: 'data',
    options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/pdf' }, { name: 'Content-Disposition', value: '=inline; filename="{{ $(\'Found?\').first().json.filename.replace(/"/g, \'\') }}"' }] } } }),
  respondError(),
], [['Webhook', 'Download?'], ['Download?', 'File', 0], ['Download?', 'Info', 1], ['Info', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1],
  ['File', 'Found?'], ['Found?', 'Have File?'], ['Have File?', 'To File', 0], ['Have File?', 'Respond Error', 1], ['To File', 'Respond PDF']]);
addMemberAuth(rulebookGet, { failTo: 'Respond Error' });

// =====================================================================
// 33. Dashboard  GET /webhook/vault/dashboard  (admins): everything about how people use the site, for dashboard.html
// =====================================================================
const dashboard = wf(ID.dashboard, 'Vault — Dashboard', [
  webhook('Webhook', 'GET', 'vault/dashboard'),
  pg('Read', "SELECT CASE WHEN (d ->> 'ok')::boolean THEN d || jsonb_build_object('selfTest', (SELECT value FROM settings WHERE key = 'self_test')) ELSE d END AS r FROM (SELECT bgc.dashboard($1) AS d) q", '={{ [$json._auth.email] }}'),
  code('Result', function () { return [{ json: $input.first().json.r }]; }),
  ifTrue('OK?', '={{ $json.ok }}'),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Read'], ['Read', 'Result'], ['Result', 'OK?'], ['OK?', 'Respond OK', 0], ['OK?', 'Respond Error', 1]]);
addMemberAuth(dashboard, { failTo: 'Respond Error' });

// =====================================================================
// 34. Ask (nightly self-test)  internal only, no webhook: the real Ask workflow, called by the nightly self-test as a
//     given member. It doesn't use anyone's question allowance, isn't counted on the dashboard, and doesn't log a visit.
// =====================================================================
const askTest = (() => {
  const w = JSON.parse(JSON.stringify(ask));
  w.id = ID.askTest; w.name = 'Vault — Ask (nightly self-test, internal)';
  const drop = (n) => /^Auth: (Read Token|Verify With Google|Check Token)$/.test(n) || n === 'Token Valid?';
  w.nodes = w.nodes.filter((n) => !drop(n.name));
  for (const k of Object.keys(w.connections)) if (drop(k)) delete w.connections[k];
  const start = w.nodes.find((n) => n.name === 'Webhook');
  Object.assign(start, { type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, parameters: { inputSource: 'passthrough' } });
  delete start.webhookId;
  // Who they are, without signing in (and without counting a visit)
  const who = w.nodes.find((n) => n.name === 'Auth: Find Player');
  who.parameters.query = "SELECT jsonb_build_object('member', true, 'id', m.id, 'name', m.display_name, 'isAdmin', m.is_admin, " +
    "'playerId', (SELECT legacy_id FROM players WHERE owner_id = at.admin_id() AND linked_member_id = m.id LIMIT 1), 'playerName', m.display_name) AS r FROM members m WHERE m.google_email = $1";
  who.parameters.options.queryReplacement = "={{ [$('Webhook').first().json.email] }}";
  const role = w.nodes.find((n) => n.name === 'Auth: Role');
  role.parameters.jsCode = PRELUDE + '\n' + body(function () {
    const i = $('Webhook').first().json;
    const m = $input.first().json.r || {};
    // A short pause first, so the nightly questions are spaced out for the AI service
    return [{ json: { body: { question: i.question, playerIds: [], shelf: i.shelf || 'main', previous: i.previous || null }, _authOk: true,
      _auth: { role: i.role || 'friend', email: i.email, memberId: m.id || null, admin: false, playerId: m.playerId || null, playerName: m.playerName || '' } } }];
  });
  w.connections.Webhook = { main: [[{ node: 'Pause', type: 'main', index: 0 }]] };
  w.connections.Pause = { main: [[{ node: 'Auth: Find Player', type: 'main', index: 0 }]] };
  w.nodes.push({ ...wait('Pause', 6), position: [0, 400] });
  const quiet = (name, jsCode) => { const n = w.nodes.find((x) => x.name === name); Object.assign(n, { type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode } }); delete n.credentials; delete n.webhookId; };
  quiet('Use Allowance', 'return [{ json: { questions: 0, lim: 999 } }];');
  quiet('Log Answer', 'return $input.all();');
  for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.respondToWebhook')) quiet(n.name, 'return $input.all();');
  return w;
})();

// =====================================================================
// 35. Nightly Self-Test  every night: the database checks, then Nathan's question set (n8n/tests/nathan.json).
//     Emails Dan only if something fails; the latest result shows on the dashboard.
// =====================================================================
const NATHAN_TESTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'nathan.json'), 'utf8'));
const selfTest = wf(ID.selfTest, 'Vault — Nightly Self-Test', [
  node('Nightly', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ triggerAtHour: 5, triggerAtMinute: 40 }] } }),
  node('Run Now', 'n8n-nodes-base.manualTrigger', 1, {}),
  { ...pg('Database Checks', 'SELECT bgc.self_check() AS results', null), onError: 'continueRegularOutput', alwaysOutputData: true },
  code('Questions', function () {
    const WHO = { dan: { email: '__OWNER_EMAIL__', role: 'owner', shelf: 'main' }, nathan: { email: 'nathan.schmidt@curator.invalid', role: 'friend', shelf: 'mine' } };
    return __NATHAN_TESTS__.map((t) => ({ json: { test: t, email: WHO[t.as].email, role: WHO[t.as].role, shelf: t.shelf || WHO[t.as].shelf, question: t.q, previous: t.prev || null } }));
  }),
  { ...node('Ask Nathan', 'n8n-nodes-base.executeWorkflow', 1.2, {
    source: 'database', workflowId: { __rl: true, value: ID.askTest, mode: 'id' }, mode: 'each', options: { waitForSubWorkflow: true },
  }), onError: 'continueRegularOutput' },
  code('Score', function () {
    const db = ($('Database Checks').first().json.results) || [{ what: 'the database checks didn’t run: ' + ($('Database Checks').first().json.error || 'no result'), ok: false }];
    const asked = $('Questions').all().map((i) => i.json.test);
    const answers = $input.all().map((i) => i.json);
    const textOf = (a) => [a.summary, a.note, a.message, a.error, a.pick && [a.pick.title, a.pick.why, a.pick.tableFeel], a.alternative && [a.alternative.title, a.alternative.why],
      ...(a.highlights || []).map((h) => [h.title, h.why]), a.gap && a.gap.missing,
      ...[a.pick, a.alternative, ...(a.highlights || [])].filter((x) => x && x.off && (x.off.friends || []).length).map((x) => x.off.friends.join(' & ') + ' has it')].flat(3).filter(Boolean).join(' \n ');
    const nathan = asked.map((t, i) => {
      const a = answers[i] || { error: 'no answer' };
      const low = textOf(a).toLowerCase();
      const p = [];
      if (a.error) p.push('error: ' + String(a.error).slice(0, 120));
      if (a.ok === false && a.message) p.push(String(a.message).slice(0, 120));
      for (const x of t.includes || []) if (!low.includes(x.toLowerCase())) p.push('missing "' + x + '"');
      if (t.includesAny && !t.includesAny.some((x) => low.includes(x.toLowerCase()))) p.push('none of ' + t.includesAny.join(' / '));
      for (const x of t.excludes || []) if (low.includes(x.toLowerCase())) p.push('should not say "' + x + '"');
      const n = (a.matchIds || []).length;
      if (t.matchMin != null && n < t.matchMin) p.push(n + ' games, expected at least ' + t.matchMin);
      if (t.matchMax != null && n > t.matchMax) p.push(n + ' games, expected at most ' + t.matchMax);
      if (t.intent && a.intent !== t.intent) p.push('answered as ' + a.intent + ', expected ' + t.intent);
      if (t.mode && a.mode !== t.mode) p.push('answered as ' + a.mode + ', expected ' + t.mode);
      if (t.offTopic && !a.offTopic) p.push('expected an off-topic redirect');
      return { what: t.name, ok: !p.length, problems: p };
    });
    const failed = [...db.filter((x) => !x.ok), ...nathan.filter((x) => !x.ok)];
    const summary = { at: new Date().toISOString(), dbPassed: db.filter((x) => x.ok).length, dbTotal: db.length, nathanPassed: nathan.filter((x) => x.ok).length, nathanTotal: nathan.length,
      failures: failed.map((x) => ({ what: x.what, problems: x.problems || [] })) };
    const lines = failed.map((x) => '• ' + x.what + ((x.problems || []).length ? '\n    ' + x.problems.join('; ') : ''));
    return [{ json: { summary, send: failed.length > 0, subject: 'Board Game Curator nightly check: ' + failed.length + ' problem' + (failed.length === 1 ? '' : 's'),
      text: 'The nightly self-test found ' + failed.length + ' problem' + (failed.length === 1 ? '' : 's') + '.\n\n' +
        'Database checks: ' + summary.dbPassed + ' of ' + summary.dbTotal + ' passed\nNathan questions: ' + summary.nathanPassed + ' of ' + summary.nathanTotal + ' passed\n\n' + lines.join('\n') +
        '\n\nRun it again any time from n8n (Vault — Nightly Self-Test, "Run Now"), or locally with node n8n/test-nathan.js.' } }];
  }),
  pg('Save Result', "INSERT INTO settings (key, value, updated_at) VALUES ('self_test', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    '={{ [JSON.stringify($json.summary)] }}'),
  code('Pass Along', function () { return [{ json: $('Score').first().json }]; }),
  ifTrue('Problems?', '={{ $json.send }}'),
  email('Email Dan', '={{ $json.subject }}', '={{ $json.text }}'),
], [['Nightly', 'Database Checks'], ['Run Now', 'Database Checks'], ['Database Checks', 'Questions'], ['Questions', 'Ask Nathan'], ['Ask Nathan', 'Score'],
  ['Score', 'Save Result'], ['Save Result', 'Pass Along'], ['Pass Along', 'Problems?'], ['Problems?', 'Email Dan', 0]]);

// ---------- write ----------
const all = { errorAlert, healthCheck, shelfAdd, shelfIdentify, friends, friendsChange, getCollection, update, del, identify, iconOne, iconBatch, bggOne, bggBatch, syncPlays, photoSweep, bggSearch, addByName, whoAmI, people, rate, playerSave, playersAdmin, bggUserRatings, syncPeople, ask, me, meSave, shelf, shelfUpdate, shelfRemove, importBgg, shelfCsv, wishlist, wishChange, profilePage, admin, adminAction, rulebookUpload, rulebookGet, dashboard, askTest, selfTest };
const outDir = path.join(__dirname, 'workflows');
fs.mkdirSync(outDir, { recursive: true });
for (const [k, w] of Object.entries(all)) {
  let s = JSON.stringify(w, null, 2).replace(/__ICON_MODEL__/g, ICON_MODEL).replace(/__VISION_MODEL__/g, VISION_MODEL)
    .replace(/__BGG_USERNAME__/g, BGG_USERNAME)
    .replace(/__ASK_MODEL__/g, ASK_MODEL).replace(/__ASK_DAILY_CAP__/g, String(ASK_DAILY_CAP)).replace(/__ASK_PER_MEMBER__/g, String(ASK_PER_MEMBER)).replace(/__OWNER_NAME__/g, OWNER_NAME).replace(/__OWNER_EMAIL__/g, OWNER_EMAILS[0]).replace(/__NATHAN_TESTS__/g, () => JSON.stringify(NATHAN_TESTS).replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  fs.writeFileSync(path.join(outDir, `${k}.json`), s);
  console.log(k, w.id, w.nodes.length, 'nodes');
}
