// Generates the Board Game Garage n8n workflows (Airtable-backed) into ./workflows/*.json
// Usage: node gen.js <airtableCredId> <bggCredId>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [AIRTABLE_CRED = 'AIRTABLE_CRED_ID', BGG_CRED = 'BGG_CRED_ID'] = process.argv.slice(2);
const BASE = 'appb5FKsyLareQzG4';
const TABLE = 'tblbGc0UuDxIPP2a8';
const AT_URL = `https://api.airtable.com/v0/${BASE}/${TABLE}`;
const TABLER_CSS = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.49.0/dist/tabler-icons.min.css';
const VISION_MODEL = 'anthropic/claude-sonnet-5.5';
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
  };
  const toGame = (r) => {
    const f = r.fields || {};
    let expansions = [];
    try { const v = JSON.parse(f[F.expansions] || '[]'); if (Array.isArray(v)) expansions = v.map(String); } catch (e) {}
    return {
      id: f[F.gameId] || r.id, recordId: r.id, bggId: f[F.bggId] ?? null, num: f[F.num] ?? null,
      title: f[F.title] || '', genre: f[F.genre] || '', type: f[F.type] || '', desc: f[F.desc] || '',
      expansions, desireToPlay: f[F.desireToPlay] || 0, thinningCandidate: !!f[F.thinningCandidate],
      bggRating: f[F.bggRating] ?? null, icon: f[F.icon] || 'meeple',
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
        case 'thinningCandidate': out[F.thinningCandidate] = v === true || v === 'true'; break;
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
    const id = (j.body && j.body.id) || j.id;
    if (!id) throw new Error('Missing id');
    return [{ json: { id: String(id), formula: formulaFor(String(id)) } }];
  }),
  airtableLookup('Find Record'),
  code('Prep', function () {
    const rec = ($input.first().json.records || [])[0];
    if (!rec) throw new Error('Game not found: ' + $('Normalize').first().json.id);
    return [{ json: { recordId: rec.id, game: toGame(rec) } }];
  }),
  textGet('Fetch Tabler Catalog', TABLER_CSS),
  code('Build Icon Prompt', function () {
    const names = [...String($input.first().json.data || '').matchAll(/\.ti-([a-z0-9-]+):before/g)].map((m) => m[1]);
    if (names.length < 1000) throw new Error('Tabler catalog looks wrong: only ' + names.length + ' icons');
    const g = $('Prep').first().json.game;
    const prompt = [
      `Board game: ${g.title}`,
      `Theme/genre: ${g.genre}`,
      `Mechanics: ${g.type}`,
      `Description: ${g.desc}`,
      '',
      'Suggest 8 Tabler Icons (v3) names for a small pictogram on this game\'s collection card, best first.',
      '- Use exact Tabler names: kebab-case, no "ti-" prefix (e.g. "rocket", "tree", "pyramid", "skull", "planet", "train", "fish", "crown", "building-castle").',
      '- Depict the game\'s theme, setting or central object, not its mechanics.',
      '- Avoid generic gaming icons (meeple, dice, cards, chess, puzzle, device-gamepad) unless the game is literally about them.',
      '- Never use "-off" variants.',
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
    let icon = null, match = 'fallback';
    for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off')) { icon = c; match = 'exact'; break; }
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
    return [{ json: { id: String(src.id), formula: formulaFor(String(src.id)), dryRun: flag(src.dryRun), applyFuzzy: flag(src.applyFuzzy) } }];
  }),
  airtableLookup('Find Record'),
  code('Prep', function () {
    const rec = ($input.first().json.records || [])[0];
    const n = $('Normalize').first().json;
    if (!rec) throw new Error('Game not found: ' + n.id);
    const game = toGame(rec);
    return [{ json: { recordId: rec.id, game, query: game.title.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(), dryRun: n.dryRun, applyFuzzy: n.applyFuzzy } }];
  }),
  textGet('BGG Search', 'https://boardgamegeek.com/xmlapi2/search',
    qs({ query: '={{ $json.query }}', type: 'boardgame' }), CRED.bgg),
  code('Find Candidates', function () {
    const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const xml = String($input.first().json.data || '');
    const p = $('Prep').first().json;
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
    const attr = (s, tag) => { const m = s.match(new RegExp('<' + tag + '[^>]*value="([^"]*)"')); return m ? m[1] : null; };
    const things = [...xml.matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => ({
      type: m[1], id: Number(m[2]),
      name: decode((m[3].match(/<name type="primary"[^>]*value="([^"]*)"/) || [])[1] || ''),
      year: attr(m[3], 'yearpublished'),
      usersRated: Number(attr(m[3], 'usersrated') || 0),
      average: Number(attr(m[3], 'average') || 0),
    }));
    things.sort((a, b) => ((b.type === 'boardgame') - (a.type === 'boardgame')) || (b.usersRated - a.usersRated));
    const best = things[0];
    if (!best) return [{ json: { ...c, matchType: 'none', apply: false } }];
    const bggRating = best.average > 0 ? Math.round(best.average * 10) / 10 : null;
    const fields = { [F.bggId]: best.id, [F.bggRating]: bggRating, [F.updatedAt]: new Date().toISOString() };
    const retitle = c.matchType === 'exact' && best.name && best.name !== c.game.title;
    if (retitle) fields[F.title] = best.name;
    const apply = !c.dryRun && (c.matchType === 'exact' || c.applyFuzzy);
    return [{ json: { ...c, apply, fields, bgg: { id: best.id, title: best.name, year: best.year, rating: bggRating, usersRated: best.usersRated, type: best.type },
      newTitle: retitle ? best.name : null, alternatives: things.slice(1, 4).map((t) => ({ id: t.id, title: t.name, year: t.year, usersRated: t.usersRated })) } }];
  }),
  ifTrue('Apply?', '={{ $json.apply }}'),
  airtablePatch('Save BGG Data'),
  code('Result', function () {
    const src = $('Choose Match').isExecuted ? $('Choose Match').first().json : $('Find Candidates').first().json;
    const applied = $('Save BGG Data').isExecuted;
    return [{ json: { ok: true, id: src.game.id, title: src.game.title, matchType: src.matchType, applied,
      dryRun: src.dryRun, bgg: src.bgg || null, newTitle: src.newTitle || null, alternatives: src.alternatives || [] } }];
  }),
  wait('Throttle BGG', 1.5),
], [
  ['When Called By Another Workflow', 'Normalize'], ['Webhook', 'Normalize'], ['Normalize', 'Find Record'],
  ['Find Record', 'Prep'], ['Prep', 'BGG Search'], ['BGG Search', 'Find Candidates'], ['Find Candidates', 'Any Candidates?'],
  ['Any Candidates?', 'BGG Thing', 0], ['Any Candidates?', 'Result', 1], ['BGG Thing', 'Choose Match'], ['Choose Match', 'Apply?'],
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
// =====================================================================
const identify = wf(ID.identify, 'Vault — Identify Game From Photo', [
  webhook('Webhook', 'POST', 'vault/identify'),
  node('Photo To Base64', 'n8n-nodes-base.extractFromFile', 1, {
    operation: 'binaryToPropery', binaryPropertyName: '={{ Object.keys($binary)[0] }}', destinationKey: 'photoB64', options: {},
  }),
  code('Build Vision Request', function () {
    const bin = $('Webhook').first().binary || {};
    const key = Object.keys(bin)[0];
    if (!key) throw new Error('No photo uploaded');
    const mime = bin[key].mimeType || 'image/jpeg';
    const b64 = $input.first().json.photoB64;
    const instructions = [
      'Identify the board game in this photo (usually the box front, back or spine).',
      'Reply with JSON only:',
      '{"identified": true|false, "title": "official title as on the box, e.g. \\"Dune: Imperium\\"",',
      ' "genre": "theme/setting, 1-2 short labels joined by \\" / \\", e.g. \\"Nature / Ecology\\", \\"Sci-Fi / Space\\"",',
      ' "type": "core mechanics, 1-2 labels joined by \\" / \\", e.g. \\"Engine Building / Tableau\\", \\"Deck Building\\"",',
      ' "desc": "one vivid sentence (max ~22 words) about what players do",',
      ' "expansions": ["titles of expansions visible in the photo, else empty"],',
      ' "confidence": 0.0-1.0, "reason": "only if not identified"}',
      'Style example from this collection: {"title":"Earth","genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
    ].join('\n');
    return [{ json: { requestBody: {
      model: '__VISION_MODEL__', max_tokens: 1500, temperature: 0, reasoning: { enabled: false },
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
  code('Parse Identification', function () {
    const text = $input.first().json.choices?.[0]?.message?.content || '';
    let r = {};
    try { r = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch (e) {}
    if (!r.identified || !r.title) {
      return [{ json: { ok: false, status: 422, message: 'Could not identify a game in that photo' + (r.reason ? ': ' + r.reason : '') } }];
    }
    return [{ json: { ok: true, title: String(r.title).trim(), genre: String(r.genre || ''), type: String(r.type || ''),
      desc: String(r.desc || ''), expansions: Array.isArray(r.expansions) ? r.expansions.map(String).filter(Boolean) : [],
      confidence: r.confidence ?? null } }];
  }),
  ifTrue('Identified?', '={{ $json.ok }}'),
  airtableListAll('List All Games'),
  code('Prepare New Record', function () {
    const games = $input.all().flatMap((i) => i.json.records || []).map(toGame);
    const g = $('Parse Identification').first().json;
    const dupe = games.find((x) => normTitle(x.title) === normTitle(g.title));
    if (dupe) return [{ json: { ok: false, status: 409, message: `"${dupe.title}" is already in your collection`, existing: dupe } }];
    const num = Math.max(0, ...games.map((x) => Number(x.num) || 0)) + 1;
    const now = new Date().toISOString();
    const gameId = `photo-g${num}`;
    return [{ json: { ok: true, gameId, fields: {
      [F.title]: g.title, [F.gameId]: gameId, [F.num]: num, [F.genre]: g.genre, [F.type]: g.type, [F.desc]: g.desc,
      [F.expansions]: JSON.stringify(g.expansions), [F.desireToPlay]: 0, [F.thinningCandidate]: false,
      [F.icon]: 'meeple', [F.addedAt]: now, [F.updatedAt]: now,
    } } }];
  }),
  ifTrue('New Game?', '={{ $json.ok }}'),
  airtable('Create Record', 'POST', '', jsonBody('={{ JSON.stringify({ records: [{ fields: $json.fields }], typecast: true, returnFieldsByFieldId: true }) }}')),
  code('Enrich Input', function () {
    return [{ json: { id: $('Prepare New Record').first().json.gameId } }];
  }),
  execSub('BGG Enrich', ID.bggOne),
  code('Icon Input', function () {
    return [{ json: { id: $('Prepare New Record').first().json.gameId } }];
  }),
  execSub('Assign Icon', ID.iconOne),
  airtableLookup('Reload Record', '={{ "{GameID}=\'" + $(\'Prepare New Record\').first().json.gameId + "\'" }}'),
  code('Shape Game', function () {
    const rec = ($input.first().json.records || [])[0];
    return [{ json: { game: toGame(rec) } }];
  }),
  respond('Respond OK', '={{ JSON.stringify($json.game) }}'),
  respondError(),
], [
  ['Webhook', 'Photo To Base64'], ['Photo To Base64', 'Build Vision Request'], ['Build Vision Request', 'Ask Vision Model'],
  ['Ask Vision Model', 'Parse Identification'], ['Parse Identification', 'Identified?'],
  ['Identified?', 'List All Games', 0], ['Identified?', 'Respond Error', 1],
  ['List All Games', 'Prepare New Record'], ['Prepare New Record', 'New Game?'],
  ['New Game?', 'Create Record', 0], ['New Game?', 'Respond Error', 1],
  ['Create Record', 'Enrich Input'], ['Enrich Input', 'BGG Enrich'], ['BGG Enrich', 'Icon Input'], ['Icon Input', 'Assign Icon'],
  ['Assign Icon', 'Reload Record'], ['Reload Record', 'Shape Game'], ['Shape Game', 'Respond OK'],
]);

// ---------- write ----------
const all = { getCollection, update, del, identify, iconOne, iconBatch, bggOne, bggBatch };
const outDir = path.join(__dirname, 'workflows');
fs.mkdirSync(outDir, { recursive: true });
for (const [k, w] of Object.entries(all)) {
  let s = JSON.stringify(w, null, 2).replace(/__ICON_MODEL__/g, ICON_MODEL).replace(/__VISION_MODEL__/g, VISION_MODEL);
  fs.writeFileSync(path.join(outDir, `${k}.json`), s);
  console.log(k, w.id, w.nodes.length, 'nodes');
}
