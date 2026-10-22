// Nathan, in the same order as the n8n Ask workflow (n8n/gen.js section 18):
//   check the question → today's allowance → memory and the shelf → (a photo) → understand → which shelf → look games up
//   (BGG for ones we don't know) → shortlist → write (streamed) → check → answer → log the cost and remember the chat.
// The steps themselves are n8n's code nodes, copied word for word into steps.gen.ts; this file does what n8n's
// other nodes did (database, OpenRouter, BGG) and hands each step the same $ / $input it gets in n8n.
import type { Auth } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { complete, stream, type Completion, type Fetch } from './openrouter.js';
import { partialJson } from './partialJson.js';
import { STEPS } from './steps.gen.js';

export type NathanDeps = { db: Db; openrouterKey: string; bggToken?: string; fetch?: Fetch };
export type Stage = 'reading' | 'looking' | 'writing';
export type Events = {
  stage?: (s: Stage) => void;
  partial?: (p: any) => void; // the answer so far, while Nathan writes
  signal?: AbortSignal;       // Stop
};

type Item = { json: any };
const items = (v: any): Item[] => (Array.isArray(v) ? v : [v]).map((json) => ({ json }));

// What n8n's $('Node') gives a code node: the output of a node that already ran
function dollar(ran: Map<string, Item[]>) {
  return (name: string) => {
    const out = ran.get(name);
    return {
      isExecuted: !!out,
      first: () => { if (!out) throw new Error(`Node '${name}' hasn't been executed`); return out[0]; },
      all: () => { if (!out) throw new Error(`Node '${name}' hasn't been executed`); return out; },
    };
  };
}
const inputOf = (list: Item[]) => ({ first: () => list[0], all: () => list });

// n8n's per-workflow static data: the shared daily safety cap lives here (one container, like one n8n)
const staticData: Record<string, any> = { global: {} };

export async function askNathan(deps: NathanDeps, auth: Auth, body: unknown, ev: Events = {}) {
  const { db } = deps;
  const f = deps.fetch ?? fetch;
  const ran = new Map<string, Item[]>();
  const $ = dollar(ran);
  const step = (name: string, input: Item[]) => {
    const out = (STEPS as any)[name]($, inputOf(input), (k: string) => (staticData[k] ??= {})) as Item[];
    ran.set(name, out);
    return out;
  };
  const put = (name: string, v: any) => { const it = items(v); ran.set(name, it); return it; };
  const ai = async (name: string, requestBody: object, onPartial?: (p: any) => void) => {
    const r: Completion = onPartial
      ? await stream(deps.openrouterKey, requestBody, (soFar) => onPartial(partialJson(soFar)), f, ev.signal)
      : await complete(deps.openrouterKey, requestBody, f, ev.signal);
    return put(name, r);
  };
  const fail = (e: unknown): never => {
    if (ev.signal?.aborted) throw new ApiError(499 as any, 'Stopped');
    console.error(JSON.stringify({ level: 'error', where: 'nathan', error: String((e as Error)?.message || e) }));
    throw new ApiError(502, 'Nathan couldn’t answer just now. Try again in a moment.');
  };

  ev.stage?.('reading');
  put('Auth: Role', { _auth: auth });
  const v = step('Validate', [{ json: { body: body ?? {}, _auth: auth } }])[0].json;
  if (!v.ok) throw new ApiError(v.status, v.message);

  // Today's allowance (test runs from inside the container don't use anyone's)
  if (!v.test) {
    const used = await db.row('SELECT bgc.use_ask($1) AS questions, bgc.ask_limit() AS lim', [v.email]);
    put('Use Allowance', used);
    const left = step('Allowance Left?', items(used))[0].json;
    if (!left.ok) throw new ApiError(left.status, left.message);
  }

  // What Nathan remembers, and the shelf (both from the database, at once)
  const [mem, shelf] = await Promise.all([
    db.row("SELECT CASE WHEN $3::boolean THEN bgc.memory_for($1, $2) ELSE '{}'::jsonb END AS mem, " +
      "(SELECT coalesce(jsonb_agg(DISTINCT g.title), '[]') FROM rule_docs d JOIN games g ON g.id = d.game_id WHERE d.status = 'ready') AS rule_games",
      [v.email, v.chatKey, String(v.memory)]),
    db.row('SELECT bgc.shelf_view($1, $2, $3) AS v', [v.email, v.shelf, v.askerId]),
  ]);
  put('Memory', mem);
  put('Shelf View', shelf);
  for (const n of ['List Games', 'One Item', 'List Players', 'One More Item', 'List Ratings']) step(n, ran.get(n === 'List Games' ? 'Shelf View' : 'List Games')!);

  try {
    // A photo: the vision model says what it shows
    if (v.image) {
      const req = step('Photo Request', [])[0].json.requestBody;
      try { await ai('Look At Photo', req); } catch (e) { put('Look At Photo', { error: String((e as Error).message) }); }
      step('Photo Notes', ran.get('Look At Photo')!);
    }

    // Understand the question, then which shelf it's about
    const ureq = step('Build Understand Request', [])[0].json.requestBody;
    const understood = await ai('Understand Request', ureq);
    const scope = step('Scope', understood)[0].json;

    ev.stage?.('looking');
    put('Own Shelf', await db.row("SELECT CASE WHEN $2::boolean THEN bgc.shelf_view($1, 'mine', NULL) END AS own, bgc.friend_by_name($1, $3) AS fid, " +
      "CASE WHEN bgc.friend_by_name($1, $3) IS NOT NULL THEN bgc.shelf_view($1, 'friend:' || bgc.friend_by_name($1, $3), NULL) END AS visit",
      [v.email, String(scope.useOwn), scope.atFriend]));
    const lookup = await db.row('SELECT bgc.lookup_games($1, $2::jsonb) AS games, CASE WHEN $3::boolean THEN bgc.buy_pool($1) END AS pool, bgc.curator_card() AS curator, ' +
      'CASE WHEN $4::boolean THEN bgc.friends_pool($1) END AS fpool, bgc.asker_extras($1) AS extras, (SELECT top_games FROM members WHERE google_email = $1) AS top_games, CASE WHEN $5::boolean THEN bgc.rule_search($2::jsonb, $6) END AS rules',
      [v.email, JSON.stringify(scope.titles), String(scope.buy), String(scope.across), String(!!scope.rules), scope.terms || '']);
    put('Game Lookup', lookup);

    // Games we don't know yet: BGG's most-rated exact match
    const queries = step('Lookup Queries', items(lookup));
    if (!queries[0].json.none) {
      const search = await bggEach(f, deps.bggToken, queries.map((q) => 'https://boardgamegeek.com/xmlapi2/search?' + new URLSearchParams({ query: q.json.query, type: 'boardgame,boardgameexpansion' })));
      const cands = step('Game Candidates', search);
      const things = await bggEach(f, deps.bggToken, cands.map((c) => 'https://boardgamegeek.com/xmlapi2/thing?' + new URLSearchParams({ id: c.json.ids || '0', stats: '1' })));
      step('Game Choose', things);
    }

    const s = step('Shortlist', [])[0].json;
    let answer: any;
    if (s.offTopic) answer = step('Off Topic', items(s))[0].json;
    else if (!s.shortIds.length) answer = step('No Candidates', items(s))[0].json;
    else {
      ev.stage?.('writing');
      const rreq = step('Build Recommend Request', items(s))[0].json.requestBody;
      const written = await ai('Recommend', rreq, ev.partial ? (p) => ev.partial!(partialView(p, s)) : undefined);
      answer = step('Check Answer', written)[0].json;
    }
    return { answer, chatKey: v.chatKey as string, after: (save = true) => afterAnswer(db, v, answer, $, save) };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail(e);
  }
}

// After the answer has gone out: the dashboard's log line, Nathan's memory of the chat, and what each AI call cost.
// Same order and data as n8n's Log Answer → Save Turn → Log Cost. Never fails the answer.
async function afterAnswer(db: Db, v: any, a: any, $: ReturnType<typeof dollar>, save: boolean) {
  const quiet = (p: Promise<unknown>) => p.catch((e) => console.error(JSON.stringify({ level: 'error', where: 'nathan after', error: String(e?.message || e) })));
  const kind = a.offTopic ? 'off-topic' : (a.mode || (a.person ? 'person' : a.intent) || 'other');
  if (save) await quiet(db.one('SELECT bgc.log_ask($1, $2, $3::int, $4::boolean, $5)', [v.email, kind, String(Date.now() - v.t0), String(a.ok !== false), a.social || '']));
  if (save) await quiet(db.one('SELECT bgc.chat_save($1, $2, $3, $4::jsonb, $5::jsonb)',
    [v.email, v.chatKey, v.question + (v.image ? ' (photo)' : ''), JSON.stringify({ ...a, learn: undefined }), JSON.stringify(a.learn || [])]));
  const costs = ['Understand Request', 'Look At Photo', 'Recommend'].filter((n) => $(n).isExecuted).map((n) => {
    const j = $(n).first().json || {}; const u = j.usage || {};
    return { feature: v.test ? 'tests' : n === 'Look At Photo' ? 'photo' : 'nathan', model: j.model || null, cost: u.cost, in: u.prompt_tokens, out: u.completion_tokens };
  });
  await quiet(db.one('SELECT bgc.log_ai($1, $2::jsonb)', [v.email, JSON.stringify(costs)]));
}

// BGG one request at a time, 0.6 s apart (as n8n's batching). A failure is an empty answer, as n8n's "continue on error".
async function bggEach(f: Fetch, token: string | undefined, urls: string[]): Promise<Item[]> {
  const out: Item[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 600));
    try {
      if (!token) throw new Error('no BGG token');
      const r = await f(urls[i], { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20_000) });
      out.push({ json: { data: r.ok ? await r.text() : '' } });
    } catch (e) { out.push({ json: { error: String((e as Error).message), data: '' } }); }
  }
  return out;
}

// What the page may show while Nathan writes: only the words, and only for games on the shortlist (an id is shown once it's whole)
function partialView(p: any, s: any) {
  if (!p || typeof p !== 'object') return null;
  const t = (x: unknown) => (typeof x === 'string' ? x : '');
  const entry = (x: any) => (x && s.shortIds.includes(String(x.id)) ? { id: String(x.id), title: s.titles[x.id], quip: t(x.quip), why: t(x.why), tableFeel: t(x.tableFeel) } : null);
  return s.browse
    ? { summary: t(p.summary), highlights: (Array.isArray(p.highlights) ? p.highlights : []).map(entry).filter(Boolean) }
    : { pick: entry(p.pick), alternative: entry(p.alternative) };
}

// The answer as n8n's Respond OK sends it
export const respondBody = (answer: any, chatKey: string) => ({ ...answer, learn: undefined, chatKey });
