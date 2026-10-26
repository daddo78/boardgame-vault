// Sends what's waiting in bgg_outbox (schema/049) to members' BGG accounts: plays logged here (and deletions), and their collection
// (own, wishlist) and ratings as they change on the site. Every 2 minutes, and right away after a play is logged or
// BGG is linked. A collection change reads the game's BGG entry first and sends back every flag BGG keeps, changing
// only ours: for trade, want to play, a wishlist priority set on BGG stay as they were. Removing a game from the shelf
// clears "own" and marks it previously owned; the entry, its rating and comments stay on BGG.
// BGG's collection XML lags its writes (straight after a change it can answer with an older cached copy), so what we
// last sent for a game (bgg_items, kept 6 hours) wins over the XML for the fields we send: own, previously owned,
// wishlist, rating. The other flags come from the XML.
import { parsePlays } from '../bgg.js';
import { BggAccount, linkKey, NO_STATUS, openToken, parseCollectionItem, type Session, type WriteResult } from '../bggAccount.js';
import type { Job, JobCtx } from './types.js';

type Row = { id: number; memberId: number; kind: 'item' | 'play' | 'unplay'; bggId: number; tries: number; username: string; sealed: string;
  want: { own?: boolean; wishlist?: boolean; rating10?: number | null; bggPlayId?: number; edit?: boolean };
  known: { collId: number | null; own: boolean | null; prevowned: boolean | null; wishlist: boolean | null; rating10: number | null } | null;
  play: { id: number; bggPlayId: number | null; date: string; minutes: number | null; quantity: number; location: string; comments: string;
    players: { name: string; username: string; win: boolean; score: string; isNew: boolean; color?: string; position?: string; rating?: string }[] } | null };

// What to send for one game, given what BGG has now (null: not in their collection). Nothing to send: [].
export function plan(cur: ReturnType<typeof parseCollectionItem>, want: Row['want']): ('add' | 'status' | 'rating')[] {
  const steps: ('add' | 'status' | 'rating')[] = [];
  const st = cur?.status ?? NO_STATUS;
  const next = nextStatus(st, want);
  const statusChanges = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== st[k]);
  const ratingChanges = 'rating10' in want && (want.rating10 ?? null) !== (cur?.rating10 ?? null);
  if (!cur && (statusChanges || (ratingChanges && want.rating10 != null))) steps.push('add');
  if (statusChanges) steps.push('status');
  if (ratingChanges && (cur || want.rating10 != null)) steps.push('rating');
  return steps;
}
export function nextStatus(st: typeof NO_STATUS, want: Row['want']) {
  const next = { ...st };
  if ('own' in want) { next.own = !!want.own; if (!want.own && st.own) next.prevowned = true; if (want.own) next.prevowned = false; }
  if ('wishlist' in want) next.wishlist = !!want.wishlist;
  return next;
}

type Item = ReturnType<typeof parseCollectionItem>;
// The XML's entry with what we last sent laid over it (null known: nothing sent lately; an entry we made isn't missing)
export function withKnown(cur: Item, known: Row['known']): Item {
  if (!known) return cur;
  const base = cur ?? { collId: known.collId ?? 0, status: { ...NO_STATUS }, rating10: null };
  const st = { ...base.status };
  if (known.own != null) st.own = known.own;
  if (known.prevowned != null) st.prevowned = known.prevowned;
  if (known.wishlist != null) st.wishlist = known.wishlist;
  return { collId: base.collId || known.collId || 0, status: st, rating10: known.rating10 != null ? Number(known.rating10) : base.rating10 };
}

type Sent = { collId: number | null; own: boolean | null; prevowned: boolean | null; wishlist: boolean | null; rating10: number | null };
async function sendItem(ctx: JobCtx, acct: BggAccount, s: Session, r: Row): Promise<WriteResult & { sent?: Sent }> {
  const xml = await ctx.bgg.collectionItemXml(r.username, r.bggId);
  if (xml == null) return { ok: false, kind: 'error', message: 'BGG didn’t send your collection' };
  let cur = withKnown(parseCollectionItem(xml, r.bggId), r.known);
  const steps = plan(cur, r.want);
  for (const step of steps) {
    let w: WriteResult;
    if (step === 'add') {
      w = await acct.addItem(s, r.bggId);
      // BGG's own app sends the next change with the new entry's collid; the XML has it once BGG has caught up
      if (w.ok) { const again = await ctx.bgg.collectionItemXml(r.username, r.bggId); cur = (again && parseCollectionItem(again, r.bggId)) || null; }
    } else if (step === 'status') w = await acct.saveStatus(s, r.bggId, cur?.collId ?? null, nextStatus(cur?.status ?? NO_STATUS, r.want));
    else w = await acct.saveRating(s, r.bggId, cur?.collId ?? null, r.want.rating10 ?? null);
    if (!w.ok) return w;
  }
  // Remembered: only what we decided (now, or in the last few hours), never what a possibly stale XML said
  const st = nextStatus(cur?.status ?? NO_STATUS, r.want), k = r.known;
  return { ok: true, sent: { collId: cur?.collId || k?.collId || null,
    own: 'own' in r.want ? st.own : k?.own ?? null, prevowned: 'own' in r.want ? st.prevowned : k?.prevowned ?? null,
    wishlist: 'wishlist' in r.want ? st.wishlist : k?.wishlist ?? null,
    rating10: 'rating10' in r.want ? r.want.rating10 ?? null : k?.rating10 ?? null } };
}

const who = (players: { name: string }[]) => players.map((x) => x.name.trim().toLowerCase()).sort().join(',');

// Before sending a play, BGG is asked for that game on that day: the same play (same people) logged in BG Stats, or sent
// before with the answer lost, is matched to it instead of posted twice. A BGG play already matched to another of ours
// (played twice that day) is left for that one.
async function sendPlay(ctx: JobCtx, acct: BggAccount, s: Session, r: Row): Promise<WriteResult> {
  const p = r.play;
  if (!p) return { ok: false, kind: 'gone', message: 'The play was removed' };
  // Already on BGG: a change made here goes there (want.edit); otherwise it's done (sent, then the answer lost)
  if (p.bggPlayId) return r.want.edit ? acct.savePlay(s, { bggId: r.bggId, date: String(p.date).slice(0, 10), minutes: p.minutes, quantity: p.quantity,
    location: p.location, comments: p.comments, players: p.players }, p.bggPlayId) : { ok: true, playId: p.bggPlayId };
  const date = String(p.date).slice(0, 10);
  const pages = await ctx.bgg.plays(r.username, { id: r.bggId, from: date, to: date, maxPages: 3 });
  if (!pages[0]) return { ok: false, kind: 'error', message: 'BGG didn’t send your plays to check against' };
  const same = parsePlays(pages).plays.filter((x) => x.date === date && x.bggId === r.bggId && who(x.players) === who(p.players)).map((x) => x.id);
  if (same.length) {
    const taken = new Set((await ctx.db.rows<{ id: string }>('SELECT bgg_play_id::text AS id FROM plays WHERE owner_id = $1 AND bgg_play_id = ANY($2::bigint[])', [r.memberId, same])).map((x) => Number(x.id)));
    const free = same.find((id) => !taken.has(id));
    if (free) return { ok: true, playId: free };
  }
  return acct.savePlay(s, { bggId: r.bggId, date, minutes: p.minutes, quantity: p.quantity, location: p.location, comments: p.comments, players: p.players });
}

export const bggOutbox: Job<{ gapMs?: number }> = {
  name: 'bggOutbox',
  schedule: { everyMinutes: 2 },
  async run(ctx, params) {
    const key = linkKey(ctx.config.bggLinkKey);
    if (!key) return { skipped: 'BGG_LINK_KEY is not set' };
    const acct = new BggAccount(ctx.fetch, params?.gapMs ?? 2000);
    const rows = (await ctx.db.one<Row[]>('SELECT bgc.bgg_out_next($1)', [40])) || [];
    const signedOut = new Set<number>();
    const tally = { sent: 0, retry: 0, signIn: 0, gone: 0 };
    for (const r of rows) {
      if (signedOut.has(r.memberId)) continue;
      const token = openToken(key, r.sealed);
      let w: WriteResult & { sent?: Sent };
      if (!token) w = { ok: false, kind: 'auth', message: 'Link BGG again' };
      else {
        const s = { username: r.username, token };
        try {
          if (r.kind === 'play') w = await sendPlay(ctx, acct, s, r);
          else if (r.kind === 'unplay') { w = await acct.deletePlay(s, Number(r.want.bggPlayId)); if (!w.ok && w.kind === 'gone') w = { ok: true }; } // already gone on BGG: done
          else w = await sendItem(ctx, acct, s, r);
        }
        catch (e) { w = { ok: false, kind: 'error', message: String((e as Error)?.message || e).slice(0, 200) }; }
      }
      const outcome = w.ok ? 'ok' : w.kind;
      await ctx.db.one('SELECT bgc.bgg_out_result($1, $2::jsonb)', [r.id, JSON.stringify({ outcome, message: w.ok ? '' : w.message, bggPlayId: w.ok ? w.playId ?? null : null, sent: w.ok ? w.sent ?? null : null })]);
      if (outcome === 'auth') signedOut.add(r.memberId);
      tally[outcome === 'ok' ? 'sent' : outcome === 'auth' ? 'signIn' : outcome === 'gone' ? 'gone' : 'retry']++;
    }
    return { waiting: rows.length, ...tally };
  },
};
