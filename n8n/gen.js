// Generates the Board Game Garage n8n workflows (Airtable-backed) into ./workflows/*.json
// Usage: node gen.js <airtableCredId> <bggCredId> [bggUsername]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [AIRTABLE_CRED = 'AIRTABLE_CRED_ID', BGG_CRED = 'BGG_CRED_ID', BGG_USERNAME = ''] = process.argv.slice(2);
const BASE = 'appb5FKsyLareQzG4';
const TABLE = 'tblbGc0UuDxIPP2a8';
const AT_URL = `https://api.airtable.com/v0/${BASE}/${TABLE}`;
const TABLER_CSS = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.49.0/dist/tabler-icons.min.css';
const VISION_MODEL = 'google/gemini-2.5-flash-lite';
const ICON_MODEL = 'anthropic/claude-haiku-5.5';

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
};

const CRED = {
  airtable: { airtableTokenApi: { id: AIRTABLE_CRED, name: 'Airtable Personal Access Token account' } },
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
    playCount: 'fld9pSGve6FsTDxMN', lastPlayed: 'fldVjyyNET9JmjN8d', favorite: 'fldyfp0FG1zY0K4qu',
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
    };
  };
  const formulaFor = (id) => /^rec[A-Za-z0-9]{14}$/.test(id)
    ? `RECORD_ID()='${id}'`
    : `{GameID}='${String(id).replace(/'/g, "\\'")}'`;
  const normTitle = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();
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
const airtable = (name, method, urlSuffix, params = {}, options = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method, url: `=${AT_URL}${urlSuffix}`, authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi',
  ...params, options,
}, { credentials: CRED.airtable, ...retry });
const airtableLookup = (name, formulaExpr = '={{ $json.formula }}') =>
  airtable(name, 'GET', '', qs({ filterByFormula: formulaExpr, returnFieldsByFieldId: 'true', maxRecords: '1' }));
const airtableListAll = (name) => airtable(name, 'GET', '', qs({ returnFieldsByFieldId: 'true', pageSize: '100' }), {
  pagination: { pagination: {
    paginationMode: 'updateAParameterInEachRequest',
    parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $response.body.offset }}' }] },
    paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.offset }}',
    limitPagesFetched: true, maxRequests: 50, requestInterval: 250,
  } },
});
const jsonBody = (expr) => ({ sendBody: true, specifyBody: 'json', jsonBody: expr });
const airtablePatch = (name) => airtable(name, 'PATCH', '/{{ $json.recordId }}',
  jsonBody('={{ JSON.stringify({ fields: $json.fields, typecast: true, returnFieldsByFieldId: true }) }}'));
const openrouter = (name) => node(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
  authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendHeaders: true, headerParameters: { parameters: [
    { name: 'HTTP-Referer', value: 'https://n8n.ondorilabo.com/vault' },
    { name: 'X-Title', value: 'Board Game Garage' },
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
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner', ...extraSettings }, tags: [] };
};

// =====================================================================
// 1. Get Collection  GET /webhook/vault/collection
// =====================================================================
const getCollection = wf(ID.collection, 'Vault — Get Collection', [
  webhook('Webhook', 'GET', 'vault/collection'),
  airtableListAll('List All Games'),
  code('Shape For Frontend', function () {
    const items = $input.all().flatMap((i) => i.json.records || []).map(toGame)
      .sort((a, b) => (a.num || 0) - (b.num || 0));
    return [{ json: { items } }];
  }),
  respond('Respond', '={{ JSON.stringify($json.items) }}'),
], [['Webhook', 'List All Games'], ['List All Games', 'Shape For Frontend'], ['Shape For Frontend', 'Respond']]);

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
  airtableListAll('List All Games'),
  code('Build Updates', function () {
    const { byGame, total, gamesPlayed } = $('Tally Plays').first().json;
    const games = $input.all().flatMap((i) => i.json.records || []).map(toGame);
    const changes = [];
    for (const g of games) {
      if (!g.bggId) continue;
      const p = byGame[String(g.bggId)] || { count: 0, last: null };
      if ((g.playCount || 0) !== p.count || (g.lastPlayed || null) !== p.last) {
        changes.push({ id: g.recordId, fields: { [F.playCount]: p.count, [F.lastPlayed]: p.last } });
      }
    }
    const batches = [];
    for (let i = 0; i < changes.length; i += 10) batches.push({ json: { records: changes.slice(i, i + 10) } });
    const matched = games.filter((g) => g.bggId && byGame[String(g.bggId)]).length;
    const summary = { totalPlays: total, gamesPlayedOnBgg: gamesPlayed, matchedInCollection: matched, updated: changes.length };
    return batches.length ? batches.map((b) => ({ json: { ...b.json, summary } })) : [{ json: { records: [], summary } }];
  }),
  ifTrue('Anything To Save?', '={{ $json.records.length > 0 }}'),
  airtable('Save Play Counts', 'PATCH', '', jsonBody('={{ JSON.stringify({ records: $json.records, typecast: true }) }}')),
  code('Result', function () {
    return [{ json: { ok: true, ...$('Build Updates').first().json.summary } }];
  }),
], [
  ['Daily', 'Options'], ['Webhook', 'Options'], ['Options', 'BGG Plays'], ['BGG Plays', 'Tally Plays'],
  ['Tally Plays', 'List All Games'], ['List All Games', 'Build Updates'], ['Build Updates', 'Anything To Save?'],
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

// ---------- write ----------
const all = { getCollection, update, del, identify, iconOne, iconBatch, bggOne, bggBatch, syncPlays, photoSweep, bggSearch, addByName };
const outDir = path.join(__dirname, 'workflows');
fs.mkdirSync(outDir, { recursive: true });
for (const [k, w] of Object.entries(all)) {
  let s = JSON.stringify(w, null, 2).replace(/__ICON_MODEL__/g, ICON_MODEL).replace(/__VISION_MODEL__/g, VISION_MODEL)
    .replace(/__BGG_USERNAME__/g, BGG_USERNAME);
  fs.writeFileSync(path.join(outDir, `${k}.json`), s);
  console.log(k, w.id, w.nodes.length, 'nodes');
}
