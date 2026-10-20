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
], [['Webhook', 'List All Games'], ['List All Games', 'Shape For Frontend'], ['Shape For Frontend', 'Respond']]);
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
  const findPlayer = airtable('Auth: Find Player', 'GET', '', qs({
    filterByFormula: `={{ "LOWER({GoogleEmail})='" + $json.email.replace(/'/g, '') + "'" }}`, returnFieldsByFieldId: 'true', maxRecords: '1',
  }), {}, PLAYERS_TABLE);
  const role = code('Auth: Role', function () {
    const t = $('Auth: Check Token').first().json;
    const rec = ($input.first().json.records || [])[0];
    const role = t.owner ? 'owner' : rec ? 'friend' : null;
    if (!role) return [{ json: { ok: false, status: 401, message: 'This account can view only' } }];
    const auth = { role, email: t.email, playerId: rec ? rec.id : null, playerName: rec ? (rec.fields[PF.name] || '') : null };
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
  respond('Respond OK', "={{ JSON.stringify({ ok: true, role: $json._auth.role, owner: $json._auth.role === 'owner', playerId: $json._auth.playerId, playerName: $json._auth.playerName }) }}"),
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
  pg('Shelf View', 'SELECT bgc.shelf_view($1, $2, $3) AS v',
    "={{ [$json._auth.email, /^(mine|friend:\\d+)$/.test(String(($json.query || {}).shelf || '')) ? String($json.query.shelf) : 'main', $json._auth.playerId] }}"),
  code('List Players', function () { return [{ json: { records: $input.first().json.v.players } }]; }),
  code('One Item', function () { return [{ json: {} }]; }),
  code('List Ratings', function () { return [{ json: { records: $('Shelf View').first().json.v.ratings } }]; }),
  pg('Asks Used', 'SELECT bgc.asks_used($1) AS used', "={{ [$('Auth: Role').first().json._auth.email] }}"),
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
    return [{ json: { players, ratings: best, me: sv.askerKey || null, shelf: sv.shelf, asks: { limit: __ASK_PER_MEMBER__, left: Math.max(0, __ASK_PER_MEMBER__ - used) } } }];
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
    const auth = j._auth;
    const err = (status, message) => [{ json: { ok: false, status, message } }];
    const gameId = String(b.gameId || '').trim();
    const stars = Math.round(Number(b.stars) * 2) / 2;
    if (!gameId) return err(400, 'Missing gameId');
    if (!(stars >= 0 && stars <= 5)) return err(400, 'stars must be 0-5 (0 clears your rating)');
    const target = auth.playerId;
    if (!target) return err(400, 'Link your Google email to your player card to rate games');
    if (b.playerId && String(b.playerId) !== target) return err(403, 'You can only rate games for yourself');
    const source = 'site';
    const key = `${target}|${gameId}|${source}`;
    return [{ json: { ok: true, key, playerId: target, gameId, stars, source, formula: `{Key}='${key.replace(/'/g, '')}'` } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Find Existing', 'SELECT at.find_rating($1) AS records', '={{ [$json.key] }}'),
  code('Plan Write', function () {
    const v = $('Validate').first().json;
    const existing = ($input.first().json.records || [])[0];
    if (v.stars === 0) return [{ json: { ...v, action: existing ? 'delete' : 'none', recordId: existing ? existing.id : null } }];
    return [{ json: { ...v, action: 'upsert', records: [{ fields: {
      [RF.key]: v.key, [RF.playerId]: v.playerId, [RF.gameId]: v.gameId, [RF.stars]: v.stars, [RF.source]: v.source, [RF.updatedAt]: new Date().toISOString(),
    } }] } }];
  }),
  ifTrue('Upsert?', "={{ $json.action === 'upsert' }}"),
  airtable('Upsert Rating', 'PATCH', '', jsonBody("={{ JSON.stringify({ performUpsert: { fieldsToMergeOn: ['" + 'fldSVVMwQygNrpyBm' + "'] }, records: $json.records, typecast: true }) }}"), {}, RATINGS_TABLE),
  ifTrue('Delete?', "={{ $json.action === 'delete' }}"),
  airtable('Delete Rating', 'DELETE', '/{{ $json.recordId }}', {}, {}, RATINGS_TABLE),
  code('Result', function () {
    const v = $('Validate').first().json;
    return [{ json: { ok: true, gameId: v.gameId, playerId: v.playerId, stars: v.stars, source: v.source } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Find Existing', 0], ['Valid?', 'Respond Error', 1],
  ['Find Existing', 'Plan Write'], ['Plan Write', 'Upsert?'], ['Upsert?', 'Upsert Rating', 0], ['Upsert?', 'Delete?', 1],
  ['Delete?', 'Delete Rating', 0], ['Delete?', 'Result', 1], ['Upsert Rating', 'Result'], ['Delete Rating', 'Result'],
  ['Result', 'Respond OK'],
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
    const creates = Object.values(people).filter((p) => p.total >= 3 && !known.has(p.name.toLowerCase()))
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
    } : null;
    const mentioned = Array.isArray(b.mentioned) ? b.mentioned.map(String).filter((x) => x.length < 40).slice(0, 100) : [];
    const auth = $input.first().json._auth;
    return [{ json: { ok: true, question, playerIds, previous: prev, mentioned, email: auth.email, askerId: auth.playerId || null, askerName: auth.playerName || '',
      shelf: /^friend:\d+$/.test(String(b.shelf || '')) ? String(b.shelf) : b.shelf === 'mine' ? 'mine' : 'main' } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  pg('Use Allowance', 'SELECT bgc.use_ask($1) AS questions',
    '={{ [$json.email] }}'),
  code('Allowance Left?', function () {
    const used = Number($input.first().json.questions) || 0;
    if (used > __ASK_PER_MEMBER__) return [{ json: { ok: false, status: 429, message: 'Nathan has answered your ' + __ASK_PER_MEMBER__ + ' questions for today. He’ll be back at the shelves tomorrow!' } }];
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
      '  "onTopic": true if this is about choosing or playing board games, the games on this shelf, or the people who play here (their tastes, profile, play history), else false,',
      '  "intent": "browse" if they ask what games they have, or to list, show, rank, count or sum up part of the shelf (e.g. "what sci-fi games do I have", "show me our co-ops", "my top ten most played", "do I have Azul", "games by Uwe Rosenberg"); "recommend" if they want something to play; "person" if they ask about a person rather than games (e.g. "what do you know about me", "what does Keith like", "how do I do at Catan", "who wins most"),',
      '  "personIds": [for intent "person": ids from ROSTER of who they ask about; "me", "I" and "my" mean the ASKER],',
      '  "sort": for a ranked list only: "plays" (most played), "leastPlays", "recent" (most recently played), "stale" (longest since played), "rating" (BGG rating), "rank" (BGG rank), "want" (wants-to-play stars), "weight" (heaviest), "newest" (latest added); else null,',
      '  "limit": how many games they asked for ("top ten" = 10, "my 5 heaviest" = 5), else null,',
      '  "reply": "only if onTopic is false: one friendly, lightly punny sentence from Nathan, the collection curator, steering back to board games",',
      '  "playerIds": [ids from ROSTER for people playing, named or clearly meant (first names, nicknames); when they include themselves ("for me and Brittany", "something I would like") add the ASKER id],',
      '  "unknownPeople": number of other people mentioned who are not on the roster (e.g. "and 2 friends" = 2),',
      '  "playerCount": total players if stated or implied, else null,',
      '  "maxMinutes": longest acceptable play time in minutes, else null ("quick" ~ 30, "an hour" = 60, "all evening" ~ 240),',
      '  "youngestAge": age of the youngest player if stated, else null,',
      '  "weight": {"min": 1-5, "max": 1-5} complexity if they hint at it ("light" max 2.2, "brain burner" min 3.2), else null,',
      '  "coop": true for cooperative only, false for competitive only, null if either,',
      '  "themes": ["genres, themes or mechanisms they want, as BoardGameGeek category or mechanic words plus common synonyms, e.g. sci-fi: science fiction, space exploration; dice: dice rolling; worker placement. Also any game titles or designer names they name, as written. Leave empty for a plain ranking like most played"],',
      '  "avoid": ["themes, mechanisms or titles to avoid"],',
      '  "freshness": "unplayed" | "stale" (not played in a long time) | "favorite" | null,',
      '  "mood": "a few words on the vibe",',
      '  "excludeIds": []',
      '}',
      'If PREVIOUS is given, this is a follow-up ("shorter", "something else"): start from its constraints and change only what the new message changes. Only when they want different games ("something else", "another one") put the previous picks in excludeIds; when they narrow it down ("which of those are quick") keep excludeIds empty.',
      '',
      'ROSTER (id | name):', roster || '(none)',
      askerId ? 'ASKER (the person typing): ' + askerId + ' | ' + (askerName || 'unknown') : '',
      selected.length ? `Already selected as playing: ${selected.join(', ')}` : '',
      v.previous ? 'PREVIOUS: ' + JSON.stringify(v.previous) : '',
      '',
      'REQUEST: ' + v.question,
    ].filter((l) => l !== '').join('\n');
    return [{ json: { requestBody: {
      model: '__VISION_MODEL__', max_tokens: 1500, reasoning: { enabled: false }, provider: { data_collection: 'deny' },
      messages: [{ role: 'user', content: prompt }],
    } } }];
  }),
  openrouter('Understand Request'),
  code('Shortlist', function () {
    const v = $('Validate').first().json;
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    let c = {};
    try { c = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
    if (c.onTopic === false) return [{ json: { offTopic: true, reply: String(c.reply || 'I can only help pick board games from this shelf.') } }];
    const games = $('List Games').all().flatMap((i) => i.json.records || []).map(toGame);
    const players = $('List Players').all().flatMap((i) => i.json.records || []).map(toPlayer);
    const ratings = $('List Ratings').all().flatMap((i) => i.json.records || []).map(toRating);
    const byId = Object.fromEntries(players.map((p) => [p.id, p]));
    const group = [...new Set([...(v.playerIds || []), ...(Array.isArray(c.playerIds) ? c.playerIds : [])])].map((id) => byId[id]).filter(Boolean);
    const count = c.intent === 'browse' ? (Number(c.playerCount) || null)
      : Math.max(Number(c.playerCount) || 0, group.length + (Number(c.unknownPeople) || 0)) || null;
    const ages = [Number(c.youngestAge) || null, ...group.map((p) => p.age)].filter((a) => a > 0);
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
      if (c.coop === true && !isCoop(g)) continue;
      if (c.coop === false && isCoop(g) && !/semi/i.test(g.type)) continue;
      const h = hay(g);
      if (avoid.some((w) => h.includes(w))) continue;
      let s = 0;
      if (count && g.bestPlayers.includes(count)) s += 2;
      s += want.filter((w) => h.includes(w)).length * 2.5;
      s += (g.desireToPlay || 0) * 0.4 + (g.favorite ? 1 : 0) - (g.thinningCandidate ? 0.5 : 0);
      s += ((g.bggRating || 6.5) - 6.5) * 0.5;
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
    const themed = want.length ? scored.filter((x) => want.some((w) => tags(x.g).includes(w))) : scored;
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
      want: { cmp: by('desireToPlay', 1), keep: (g) => !!g.desireToPlay, label: 'most wanted to play first' },
      weight: { cmp: by('weight', 1), keep: (g) => !!g.weight, label: 'heaviest first' },
      newest: { cmp: by('addedAt', 1), keep: () => true, label: 'latest added first' },
    };
    const sorter = browse ? SORTS[c.sort] : null;
    if (sorter) fits = fits.filter((x) => sorter.keep(x.g)).sort(sorter.cmp);
    const limit = browse ? Math.max(0, Math.min(50, Math.round(Number(c.limit) || 0))) : 0;
    if (limit) fits = fits.slice(0, limit);
    const gap = gap0 || fits.length === 0;
    const short = (gap ? loose.sort((a, b) => b.s - a.s).slice(0, 12) : fits.slice(0, 30)).map((x) => x.g);
    const matchIds = gap ? [] : fits.map((x) => x.g.id);
    // A few facts about the matching set, so a browse summary can be specific without guessing
    const tally = (list) => Object.entries(list.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + ' ' + n).join(', ');
    const set = fits.map((x) => x.g);
    const weights = set.map((g) => g.weight).filter(Boolean);
    const setFacts = gap ? '' : [
      'COUNT: ' + set.length + ' of ' + games.length + ' games on the shelf match everything asked, including any limits like time or players (say it naturally, never mention matching, e.g. "17 sci-fi games under an hour")',
      weights.length ? 'weights: ' + weights.filter((w) => w < 2).length + ' light (<2), ' + weights.filter((w) => w >= 2 && w < 3).length + ' medium, ' + weights.filter((w) => w >= 3).length + ' heavy (3+)' : '',
      'played: ' + set.filter((g) => g.playCount).length + ', never played: ' + set.filter((g) => !g.playCount).length + ', favorites: ' + set.filter((g) => g.favorite).length,
      'top categories: ' + tally(set.flatMap((g) => g.categories)),
      'top mechanics: ' + tally(set.flatMap((g) => g.mechanics)),
      sorter ? 'ORDER: the CANDIDATES are ranked, ' + sorter.label + (limit ? ', top ' + limit : '') : '',
    ].filter(Boolean).join('\n');
    const sv = $('Shelf View').first().json.v;
    const shelfOwner = sv.ownerName || '__OWNER_NAME__';
    const askerIsOwner = sv.shelf === 'mine' || $('Auth: Role').first().json._auth.role === 'owner';
    const line = (g, ppl = group) => {
      const facts = [
        g.minPlayers ? `${g.minPlayers}-${g.maxPlayers}p` + (g.bestPlayers.length ? ` best ${g.bestPlayers.join('/')}` : '') : '',
        g.minTime ? `${g.minTime === g.maxTime ? g.minTime : g.minTime + '-' + g.maxTime}min` : '',
        g.weight ? `weight ${Number(g.weight).toFixed(1)}` : '', g.minAge ? `age ${g.minAge}+` : '',
        g.bggRating ? `BGG ${g.bggRating}` : '', g.genre, g.type,
        g.mechanics.slice(0, 4).join(', '),
        `${shelfOwner} wants to play ${g.desireToPlay || 0}/5`, g.favorite ? `${shelfOwner}'s favorite` : '', g.thinningCandidate && askerIsOwner ? `${shelfOwner} may give it away` : '',
        g.playCount ? `${shelfOwner} logged ${g.playCount} plays, last ${g.lastPlayed}` : `${shelfOwner} never logged a play`,
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
      ].filter(Boolean).join('\n  ');
    };
    const asker = byId[sv.askerPerson || sv.askerKey] || null;
    // On someone else's shelf, the asker is a guest: "you" is the asker, the shelf, its plays and stars are the owner's
    const guest = asker && sv.ownerName && asker.name.split(' ')[0] !== sv.ownerName
      ? `SHELF: you are looking at ${sv.ownerName}'s shelf with ${asker.name.split(' ')[0]}. Speak to ${asker.name.split(' ')[0]} as "you" and never call them ${sv.ownerName}; the games, plays, wins, favorites and wants-to-play stars on this shelf are ${sv.ownerName}'s ("${sv.ownerName} has played it 12 times").` : '';
    if (c.intent === 'person') {
      // "What do you know about me?": their own words, their play history here, and the games that show their taste
      const who = [...new Set(Array.isArray(c.personIds) ? c.personIds : [])].map((id) => byId[id]).filter(Boolean);
      const ppl = who.length ? who : asker ? [asker] : group;
      const playsOf = (g) => ppl.reduce((n, p) => n + ((p.history[String(g.bggId)] || {}).plays || 0), 0);
      const theirs = games.filter((g) => g.bggId && playsOf(g) > 0).sort((a, b) => playsOf(b) - playsOf(a));
      const pick = (theirs.length ? theirs : [...games].sort((a, b) => (b.desireToPlay || 0) - (a.desireToPlay || 0))).slice(0, 12);
      const facts = [
        'ASKER (the person typing; call them "you"): ' + (asker ? asker.name : 'unknown'), guest,
        'ABOUT: ' + (ppl.map((p) => p.name).join(', ') || 'unknown'),
        ppl.length ? ppl.map(profile).join('\n') : '(no profile or play history found)',
        'COUNT: ' + (ppl.length === 1 ? 'they have' : 'together they have') + ' played ' + theirs.length + ' of the ' + games.length + ' games on this shelf (logged plays)',
      ].join('\n');
      return [{ json: { offTopic: false, gap: false, browse: true, person: true, matchIds: theirs.map((g) => g.id), setFacts: facts,
        understood: { players: ppl.map((p) => p.name) }, constraints: c, shortIds: pick.map((g) => g.id),
        titles: Object.fromEntries(pick.map((g) => [g.id, g.title])), gameLines: pick.map((g) => line(g, ppl)).join('\n'), profiles: '', ownerName: shelfOwner, guest } }];
    }
    const understood = { players: group.map((p) => p.name), playerCount: count, maxMinutes: maxMin, youngestAge: youngest,
      weight: c.weight || null, coop: c.coop ?? null, themes: want, avoid, freshness: c.freshness || null, mood: c.mood || '' };
    return [{ json: { offTopic: false, gap, browse, matchIds, setFacts, understood, constraints: c, shortIds: short.map((g) => g.id),
      titles: Object.fromEntries(short.map((g) => [g.id, g.title])),
      gameLines: short.map((g) => line(g)).join('\n'), profiles: group.map(profile).join('\n'),
      askerProfile: asker && !group.includes(asker) ? profile(asker) : '', askerName: asker ? asker.name : '', ownerName: shelfOwner, guest } }];
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
      '- Fit to the people comes first: each person\'s dials, likes, dislikes and notes; their plays, wins and ratings on each candidate; {SHELF_OWNER}\'s wants-to-play stars and favorites; a game {SHELF_OWNER} may give away is a good last-chance pick. Name people by first name. Be kind about people and never judge anyone\'s taste: party games and heavy economic games deserve equal respect.',
      '',
      'VOICE:',
      '- You are talking with the ASKER: always call them "you" (never by their name, never "he" or "she"). Use first names only for other people.',
      '- Warm and enthusiastically corny: wholesome dad jokes and puns about cardboard and meeples, gentle self-deprecating humor about shelf space and the shelf of shame. Humor is a light flourish and never crowds out the recommendation.',
      '- First mention: for a title NOT in ALREADY_JOKED, open its entry with a one-line dad-joke quip about that game. For titles in ALREADY_JOKED, leave quip empty.',
      '- Only if you are confident the game has an unlimited or substitutable component pool, or it supports an expanded player count, add exactly this joke in swapJoke: "The [component] can be substituted as needed, so if you ever run short, feel free to use a suitable replacement… like [funny, semi-related household item]." Otherwise null.',
      '',
      ...(s.person ? [
      'FORMAT: this is a question about a person, not a request for a game. In "summary" (3-6 sentences) tell them what you know, warmly and specifically: their own words first (likes, dislikes, dials, about), then their play history here (plays, wins, most played, rated 4+), and what that says about their taste. Speak to the ASKER as "you" when the question is about them; use first names for anyone else.',
      'Use only the facts in SET FACTS. If the profile is empty, say so kindly: when it is the ASKER\'s own, suggest filling in My profile (under their name, top left of the site) so you can do better; for anyone else, suggest nudging that person to fill in theirs. Then pick 3 to 5 highlights from CANDIDATES that best show their taste (most played or rated highest), each with one sentence of "why". gap is null.',
      ] : s.browse ? [
      'FORMAT: this is a question about what is on the shelf, not a request for one game. Sum up the matching games in "summary" (2-4 sentences): use the exact COUNT from SET FACTS, then what kinds they are (weights, lengths, mechanics, sub-themes) and any pattern in plays or favorites. Then pick 3 to 5 varied highlights from CANDIDATES that show the range (for example a favorite, a light one, a heavy one, one that is never played), each with one sentence of "why".',
      'If SET FACTS has an ORDER, it is a ranked list: in the summary name the top three in order with their numbers (e.g. "The Crew leads with 21 plays"), and make the highlights the top 3 to 5 in that same order.',
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
      s.setFacts ? (s.person ? 'SET FACTS (about the people asked about):\n' : 'SET FACTS (all games that match):\n') + s.setFacts : '',
      'ALREADY_JOKED: ' + (s.shortIds.filter((id) => mentioned.has(id)).join(', ') || '(none)'),
      s.askerName ? 'ASKER (the person typing; call them "you"): ' + s.askerName : '', s.guest || '',
      s.askerProfile ? 'ASKER PROFILE (use it when they ask for something they would like, even if they are not listed as playing):\n' + s.askerProfile : '',
      '', 'PEOPLE PLAYING:', s.profiles || '(not specified; recommend for the group described in the request)',
      '', 'CANDIDATES (id | title | facts | how each person relates to it):', s.gameLines,
    ].filter((l) => l !== '').join('\n');
    return [{ json: { ...s, requestBody: {
      model: '__ASK_MODEL__', max_tokens: 2500, reasoning: { enabled: false }, provider: { data_collection: 'deny' },
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
    const str = (v, n) => String(v || '').trim().slice(0, n);
    const entry = (x, withFeel) => {
      if (!x || !allowed.has(String(x.id)) || seen.has(String(x.id))) return null;
      seen.add(String(x.id));
      return { id: String(x.id), title: s.titles[x.id], quip: str(x.quip, 200), why: str(x.why, 700),
        ...(withFeel ? { tableFeel: str(x.tableFeel, 400) } : {}), ...(x.swapJoke ? { swapJoke: str(x.swapJoke, 300) } : {}) };
    };
    const gapOf = () => (s.gap || (a.gap && a.gap.missing)) ? { missing: str(a.gap && a.gap.missing, 300) || 'Nothing on the shelf matches every part of that.', consider: str(a.gap && a.gap.consider, 80) || null } : null;
    if (s.browse) {
      const highlights = (Array.isArray(a.highlights) ? a.highlights : []).map((x) => entry(x, false)).filter(Boolean).slice(0, 5);
      if (!highlights.length) for (const id of s.shortIds.slice(0, 3)) highlights.push({ id, title: s.titles[id], quip: '', why: '' });
      const summary = str(a.summary, 900) || (s.matchIds.length ? 'You have ' + s.matchIds.length + ' games like that on the shelf.' : '');
      return [{ json: { ok: true, intent: 'browse', understood: s.understood, constraints: s.constraints, summary, highlights, gap: gapOf(),
        matchIds: s.matchIds, signoff: str(a.signoff, 200), pickIds: highlights.map((x) => x.id), model: $input.first().json.model || null } }];
    }
    let pick = entry(a.pick, true);
    // Model failed or went off-list: fall back to the top of the scored shortlist
    if (!pick && s.shortIds.length) { const id = s.shortIds[0]; seen.add(id); pick = { id, title: s.titles[id], quip: '', why: 'The best fit on the shelf for what you described.', tableFeel: '' }; }
    const alternative = entry(a.alternative, true);
    const avoid = entry(a.avoid, false);
    const gap = gapOf();
    return [{ json: { ok: true, intent: 'recommend', matchIds: s.matchIds, understood: s.understood, constraints: s.constraints, pick, alternative, avoid, gap,
      signoff: str(a.signoff, 200), pickIds: [pick, alternative].filter(Boolean).map((x) => x.id), model: $input.first().json.model || null } }];
  }),
  code('No Candidates', function () {
    const s = $input.first().json;
    return [{ json: { ok: true, matchIds: [], understood: s.understood, constraints: s.constraints, pick: null, alternative: null, avoid: null,
      gap: { missing: 'The shelf is empty, so there is nothing to pick from yet.', consider: null }, signoff: '', pickIds: [] } }];
  }),
  code('Off Topic', function () {
    return [{ json: { ok: true, offTopic: true, pick: null, note: $input.first().json.reply } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Use Allowance', 0], ['Valid?', 'Respond Error', 1],
  ['Use Allowance', 'Allowance Left?'], ['Allowance Left?', 'Allowed?'], ['Allowed?', 'Shelf View', 0], ['Allowed?', 'Respond Error', 1], ['Shelf View', 'List Games'],
  ['List Games', 'One Item'], ['One Item', 'List Players'], ['List Players', 'One More Item'], ['One More Item', 'List Ratings'],
  ['List Ratings', 'Build Understand Request'], ['Build Understand Request', 'Understand Request'], ['Understand Request', 'Shortlist'],
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
  ifTrue('Linked?', '={{ !!$json._auth.playerId }}'),
  airtable('Get Player', 'GET', '/{{ $json._auth.playerId }}', qs({ returnFieldsByFieldId: 'true' }), {}, PLAYERS_TABLE),
  code('Shape Profile', function () { return [{ json: { ok: true, profile: ownProfile(toPlayer($input.first().json)) } }]; }),
  code('Not Linked', function () { return [{ json: { ok: true, profile: null } }]; }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Linked?'], ['Linked?', 'Get Player', 0], ['Linked?', 'Not Linked', 1], ['Get Player', 'Shape Profile'], ['Shape Profile', 'Respond OK'], ['Not Linked', 'Respond OK']]);
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
    if (!j._auth.playerId) return err(400, 'Your Google account isn’t linked to a player card yet. Ask Dan to add your email.');
    const dial = (v) => (v === null || v === '' || v === undefined) ? null : Math.min(5, Math.max(1, Math.round(Number(v))));
    const text = (v, n = 600) => String(v ?? '').trim().slice(0, n);
    const bgg = text(b.bggUsername, 60);
    if (bgg && !/^[A-Za-z0-9_ .-]+$/.test(bgg)) return err(400, 'That BGG username doesn’t look right');
    const fields = {
      [PF.bggUsername]: bgg || null,
      [PF.age]: b.age === '' || b.age == null ? null : Math.max(1, Math.min(120, Math.round(Number(b.age)))) || null,
      [PF.complexity]: dial(b.complexity), [PF.conflict]: dial(b.conflict), [PF.luck]: dial(b.luck),
      [PF.tableTalk]: dial(b.tableTalk), [PF.theme]: dial(b.theme),
      [PF.likes]: text(b.likes), [PF.dislikes]: text(b.dislikes), [PF.notes]: text(b.notes),
      [PF.updatedAt]: new Date().toISOString(),
    };
    return [{ json: { ok: true, id: j._auth.playerId, fields } }];
  }),
  ifTrue('Valid?', '={{ $json.ok }}'),
  airtable('Update Player', 'PATCH', '/{{ $json.id }}', jsonBody('={{ JSON.stringify({ fields: $json.fields, typecast: true, returnFieldsByFieldId: true }) }}'), {}, PLAYERS_TABLE),
  code('Shape Profile', function () { return [{ json: { ok: true, profile: ownProfile(toPlayer($input.first().json)) } }]; }),
  respond('Respond OK', '={{ JSON.stringify($json) }}'),
  respondError(),
], [['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Update Player', 0], ['Valid?', 'Respond Error', 1], ['Update Player', 'Shape Profile'], ['Shape Profile', 'Respond OK']]);
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
// 24. Import From BGG  POST /webhook/vault/import { bggUsername }  (member gate)
//     Answers right away ("started"); the import keeps running and reports progress on /shelf:
//     owned base games + expansions -> shared catalog and the member's shelf -> BGG details and box art for anything
//     new to the catalog -> every play from their BGG account -> their player list and play counts.
// =====================================================================
const importCollectionGet = (name, extraQuery) => node(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'GET', url: 'https://boardgamegeek.com/xmlapi2/collection',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  ...qs({ username: "={{ $('Validate').first().json.username }}", own: '1', ...extraQuery }),
  options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'data' } } },
}, { credentials: CRED.bgg });
// BGG builds a collection in the background and answers 202 "accepted" until it's ready: check, wait, ask again
const importReady = (name, fetchName) => code(name, new Function(`
  const xml = String($('${fetchName}').first().json.data || '');
  const err = (xml.match(/<error>\\s*<message>([^<]*)<\\/message>/) || [])[1];
  if (err) return [{ json: { ready: true, error: err } }];
  if ($('${fetchName}').first().json.statusCode === 200 && xml.includes('<items')) return [{ json: { ready: true } }];
  if ($runIndex >= 15) return [{ json: { ready: true, error: 'BGG is still preparing this collection; try again in a few minutes' } }];
  return [{ json: { ready: false } }];
`));
const importBgg = wf(ID.importBgg, 'Vault — Import From BGG', [
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
  importCollectionGet('BGG Base Games', { excludesubtype: 'boardgameexpansion' }),
  importReady('Base Games Ready?', 'BGG Base Games'),
  ifTrue('Base Ready?', '={{ $json.ready }}'),
  wait('Wait For BGG', 6),
  importCollectionGet('BGG Expansions', { subtype: 'boardgameexpansion' }),
  importReady('Expansions Ready?', 'BGG Expansions'),
  ifTrue('Expansions Ready', '={{ $json.ready }}'),
  wait('Wait For BGG Again', 6),
  code('Parse Collection', function () {
    const err = $('Base Games Ready?').last().json.error;
    if (err) return [{ json: { ok: false, message: err } }];
    const unxml = (v) => String(v || '').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const parse = (xml, subtype) => [...String(xml || '').matchAll(/<item [^>]*objectid="(\d+)"[^>]*>([\s\S]*?)<\/item>/g)].map((m) => ({
      bggId: Number(m[1]), subtype, name: unxml((m[2].match(/<name[^>]*>([^<]*)<\/name>/) || [])[1] || ''),
      year: Number((m[2].match(/<yearpublished>(\d+)<\/yearpublished>/) || [])[1] || 0) }));
    const base = parse($('BGG Base Games').last().json.data, 'boardgame');
    const exp = $('Expansions Ready?').last().json.error ? [] : parse($('BGG Expansions').last().json.data, 'boardgameexpansion');
    return [{ json: { ok: true, items: [...base, ...exp], base: base.length, expansions: exp.length } }];
  }),
  ifTrue('Collection OK?', '={{ $json.ok }}'),
  pg('Save Collection', 'SELECT bgc.import_collection($1, $2::jsonb) AS r', "={{ [$('Validate').first().json.email, JSON.stringify($json.items)] }}"),
  pg('Progress: Details', "SELECT bgc.set_import($1, jsonb_build_object('step', 'Getting game details and box art', 'games', $2::int, 'expansions', $3::int)) AS s",
    "={{ [$('Validate').first().json.email, $('Parse Collection').first().json.base, $('Parse Collection').first().json.expansions] }}"),
  code('Detail Batches', function () {
    const ids = $('Save Collection').first().json.r.enrich || [];
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
  // In-between image sizes from BGG's image service (the XML only has a thumbnail and the huge original)
  { ...node('BGG Image Sizes', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: '=https://api.geekdo.com/api/images/{{ $json.picId || 0 }}',
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 250 } } },
  }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }), onError: 'continueRegularOutput' },
  code('Add Covers', function () {
    const things = $('Parse Details').all().map((i) => i.json).filter((t) => !t.none);
    const imgs = $input.all().map((i) => i.json.images || {});
    const out = things.map((t, i) => {
      const im = imgs[i] || {};
      return { ...t, coverCard: im.medium?.url || im.itempage?.url || null, coverLarge: im.itempage?.url || im.medium?.url || null };
    });
    const owned = $('Parse Collection').first().json.items.filter((x) => x.subtype === 'boardgameexpansion').map((x) => x.bggId);
    return [{ json: { things: out, ownedExpansions: owned } }];
  }),
  pg('Save Details', 'SELECT bgc.enrich_games($1, $2::jsonb, $3::jsonb) AS r',
    "={{ [$('Validate').first().json.email, JSON.stringify($json.things), JSON.stringify($json.ownedExpansions)] }}"),
  pg('Progress: Plays', "SELECT bgc.set_import($1, jsonb_build_object('step', 'Reading your plays')) AS s", "={{ [$('Validate').first().json.email] }}"),
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
    return [{ json: { plays: plays.filter((p) => p.id && p.bggId) } }];
  }),
  pg('Save Plays', 'SELECT at.save_plays($1, $2::jsonb) AS saved', "={{ [$('Validate').first().json.email, JSON.stringify($json.plays)] }}"),
  pg('Players And Counts', 'SELECT bgc.refresh_member($1) AS r', "={{ [$('Validate').first().json.email] }}"),
  pg('Done', "SELECT bgc.set_import($1, jsonb_build_object('state', 'done', 'step', 'Done', 'added', $2::int, 'plays', $3::int, 'players', $4::int, 'finished', at.iso(now()))) AS s",
    "={{ [$('Validate').first().json.email, $('Save Collection').first().json.r.added, $('Save Plays').first().json.saved.plays, $json.r.players] }}"),
  pg('Failed', "SELECT bgc.set_import($1, jsonb_build_object('state', 'error', 'message', $2::text)) AS s", "={{ [$('Validate').first().json.email, $json.message] }}"),
  respondError(),
], [
  ['Webhook', 'Validate'], ['Validate', 'Valid?'], ['Valid?', 'Start', 0], ['Valid?', 'Respond Error', 1],
  ['Start', 'Started?'], ['Started?', 'Can Start?'], ['Can Start?', 'Respond Started', 0], ['Can Start?', 'Respond Error', 1],
  ['Respond Started', 'BGG Base Games'], ['BGG Base Games', 'Base Games Ready?'], ['Base Games Ready?', 'Base Ready?'],
  ['Base Ready?', 'BGG Expansions', 0], ['Base Ready?', 'Wait For BGG', 1], ['Wait For BGG', 'BGG Base Games'],
  ['BGG Expansions', 'Expansions Ready?'], ['Expansions Ready?', 'Expansions Ready'],
  ['Expansions Ready', 'Parse Collection', 0], ['Expansions Ready', 'Wait For BGG Again', 1], ['Wait For BGG Again', 'BGG Expansions'],
  ['Parse Collection', 'Collection OK?'], ['Collection OK?', 'Save Collection', 0], ['Collection OK?', 'Failed', 1],
  ['Save Collection', 'Progress: Details'], ['Progress: Details', 'Detail Batches'], ['Detail Batches', 'BGG Thing'], ['BGG Thing', 'Parse Details'],
  ['Parse Details', 'BGG Image Sizes'], ['BGG Image Sizes', 'Add Covers'], ['Add Covers', 'Save Details'], ['Save Details', 'Progress: Plays'],
  ['Progress: Plays', 'BGG Plays'], ['BGG Plays', 'Parse Plays'], ['Parse Plays', 'Save Plays'], ['Save Plays', 'Players And Counts'], ['Players And Counts', 'Done'],
]);
addMemberAuth(importBgg, { failTo: 'Respond Error' });

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

// ---------- write ----------
const all = { errorAlert, healthCheck, shelfAdd, shelfIdentify, friends, friendsChange, getCollection, update, del, identify, iconOne, iconBatch, bggOne, bggBatch, syncPlays, photoSweep, bggSearch, addByName, whoAmI, people, rate, playerSave, playersAdmin, bggUserRatings, syncPeople, ask, me, meSave, shelf, shelfUpdate, shelfRemove, importBgg };
const outDir = path.join(__dirname, 'workflows');
fs.mkdirSync(outDir, { recursive: true });
for (const [k, w] of Object.entries(all)) {
  let s = JSON.stringify(w, null, 2).replace(/__ICON_MODEL__/g, ICON_MODEL).replace(/__VISION_MODEL__/g, VISION_MODEL)
    .replace(/__BGG_USERNAME__/g, BGG_USERNAME)
    .replace(/__ASK_MODEL__/g, ASK_MODEL).replace(/__ASK_DAILY_CAP__/g, String(ASK_DAILY_CAP)).replace(/__ASK_PER_MEMBER__/g, String(ASK_PER_MEMBER)).replace(/__OWNER_NAME__/g, OWNER_NAME).replace(/__OWNER_EMAIL__/g, OWNER_EMAILS[0]);
  fs.writeFileSync(path.join(outDir, `${k}.json`), s);
  console.log(k, w.id, w.nodes.length, 'nodes');
}
