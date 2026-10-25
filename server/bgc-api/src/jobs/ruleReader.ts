// Rulebook Reader (every 2 minutes, and right after an upload): takes the next queued document and has the vision model
// rewrite each page from its image and the page's own text: reading order, headings, icons as [words]. Each page's text
// is split into sections for search. When the document is done, the page service deletes the PDF, and a small call
// names the document from its first pages (only filling what was left blank).
import { READ_MODEL, VISION_MODEL, ask, jsonIn, type AiCost } from '../ai.js';
import type { Job, JobCtx } from './types.js';

export const READ_PROMPT = [
  'You are turning ONE page of a board game rulebook into clean text that a rules assistant will search and quote with page numbers.',
  'You get the page image and the text a PDF reader pulled from this page. That text may be out of order, split oddly, or missing words that are drawn as pictures.',
  'Rewrite this page only, as Markdown:',
  '- Keep every rule, number and example on the page. Do not add, guess or summarise anything that is not printed on this page.',
  '- Follow the reading order a person would: columns, then sidebars and boxes, each where it belongs.',
  '- Use the page\'s own headings as Markdown headings (#, ##, ###).',
  '- Replace each icon or symbol with words in square brackets. Use its meaning only when this page makes it clear (a legend, a label, or the sentence around it says what it is). Otherwise describe what it looks like, e.g. [purple hand icon], [green leaf symbol]. Never borrow names from other games, and give different-looking icons different words.',
  '- For a diagram, setup picture or worked example, write one short line: "Example (picture): ..." describing what it shows.',
  '- Skip page numbers, decorative art and flavour-only captions.',
  'Reply with the Markdown only, starting straight with the page\'s content: no remarks about the image or the extracted text.',
].join('\n');
export const NAME_PROMPT = [
  'From the pages themselves, say what it is and give its own name:',
  '- kind: "rulebook" (the base game\'s main rules), "learn" (a learn-to-play or quick-start book that comes with the full rules), "expansion" (rules for an expansion or add-on with its own box or pack), "reference" (rules reference, cheat sheet, quick reference), "aid" (a player aid or turn summary card), "appendix" (glossary, card or icon list, edge cases, almanac), "faq" (FAQ or errata), "solo" (solo rules), or "other".',
  '- name: the name printed for THIS document or expansion, without the game\'s own name, e.g. "The Norwegians", "The Edge Cases", "Quick Start". Always name an expansion. For the base game\'s main rulebook the name is "" (never a section heading such as "Overview" or "Goal of the game"). Normal capitalization, not all caps.',
  'Reply with JSON only: {"kind": "...", "name": "..."}',
].join('\n');

export type Section = { heading: string; body: string };
// A page's Markdown -> the sections Nathan searches: each heading starts one; tiny ones join the next, long ones split at paragraphs
export function splitSections(md: string): Section[] {
  const secs: { heading: string; lines: string[] }[] = [];
  let cur = { heading: '', lines: [] as string[] };
  for (const line of md.split('\n')) {
    const h = line.match(/^#{1,4}\s+(.+?)\s*#*\s*$/);
    if (h) { if (cur.lines.join('').trim()) secs.push(cur); cur = { heading: h[1].replace(/\*\*/g, '').trim(), lines: [] }; }
    else cur.lines.push(line);
  }
  if (cur.lines.join('').trim() || cur.heading) secs.push(cur);
  const out: Section[] = [];
  for (let k = 0; k < secs.length; k++) {
    let body = secs[k].lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body && !secs[k].heading) continue;
    if (body.length < 120 && k + 1 < secs.length && !secs[k + 1].lines.join('').trim().startsWith('#')) {
      secs[k + 1].lines.unshift((secs[k].heading ? secs[k].heading + ': ' : '') + body);
      if (!secs[k + 1].heading) secs[k + 1].heading = secs[k].heading;
      continue;
    }
    if (!body) body = secs[k].heading;
    while (body.length > 2400) {
      const cut = Math.max(body.lastIndexOf('\n\n', 2000), 800);
      out.push({ heading: secs[k].heading, body: body.slice(0, cut).trim() });
      body = body.slice(cut).trim();
    }
    out.push({ heading: secs[k].heading, body });
  }
  return out;
}

// What the model wrote, without a remark before the page itself ("The PDF reader pulled no text…") or code fences
export function cleanMarkdown(text: string): string {
  let md = String(text || '').trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '');
  while (/^(the (pdf|extracted|provided) (reader|text)|i will|i'll|here is|here's|below is|note:)/i.test(md.split('\n')[0] || '') && !/^#/.test(md)) md = md.split('\n').slice(1).join('\n').trim();
  return md;
}

type Claimed = { id: number; pages: number; label: string; title: string; game: string; done: number[] };

export const ruleReader: Job<{}> = {
  name: 'ruleReader',
  schedule: { everyMinutes: 2 },
  async run(ctx) {
    const { db, fetch: f, config } = ctx;
    const d = await db.one<Claimed>('SELECT bgc.rule_doc_claim()', []);
    if (!d || !d.id) return { document: null };
    if (!config.openrouterKey) throw new Error('OPENROUTER_API_KEY is not set: can\'t read rulebooks');
    const done = new Set(d.done || []);
    let read = 0, skipped = 0;
    for (let page = 1; page <= d.pages; page++) {
      if (done.has(page)) continue;
      const got = await pageOf(ctx, d.id, page);
      // A page the page service couldn't hand over isn't read blind: it stays unread and the next pass tries again
      if (!got || !got.jpeg_b64) { skipped++; continue; }
      const text = String(got.text || '').slice(0, 9000);
      let md = '', fromPdf = false;
      const costs: AiCost[] = [];
      try {
        const a = await ask(config.openrouterKey, f, 'rulebook', {
          model: READ_MODEL, models: [READ_MODEL, VISION_MODEL], max_tokens: 6000, temperature: 0.1, reasoning: { enabled: false },
          messages: [{ role: 'user', content: [
            { type: 'text', text: READ_PROMPT + '\n\nThis is page ' + page + ' of ' + d.pages + ' of the ' + d.label + ' for ' + d.game + '.\n\nTEXT FROM THE PDF READER:\n' + (text || '(none)') },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + got.jpeg_b64 } },
          ] }],
        });
        md = cleanMarkdown(a.text);
        costs.push(a.cost);
      } catch (e) { console.error(JSON.stringify({ level: 'warn', where: 'ruleReader page', doc: d.id, page, error: String((e as Error)?.message || e) })); }
      if (!md) { md = text; fromPdf = true; } // the vision step failed: the page's own text is better than nothing
      if (!md.trim()) { skipped++; continue; }  // nothing to save: the page stays unread and is tried again
      await db.one('SELECT bgc.rule_page_save($1::bigint, $2::int, $3, $4::boolean, $5::jsonb), bgc.log_ai(NULL, $6::jsonb)',
        [d.id, page, md, fromPdf, JSON.stringify(splitSections(md)), JSON.stringify(costs)]);
      read++;
    }
    const fin = await db.one<{ status: string; pages: number; missing?: string }>('SELECT bgc.rule_doc_finish($1::bigint)', [d.id]);
    let named: unknown = null;
    if (fin && fin.status !== 'queued') {
      // The PDF isn't kept: once it's read, only Nathan's text remains
      await f(config.pagesUrl + '/doc/' + d.id, { method: 'DELETE', signal: AbortSignal.timeout(20_000) }).catch(() => null);
      named = await nameDocument(ctx, d.id).catch((e) => ({ error: String((e as Error)?.message || e) }));
    }
    return { document: d.id, game: d.game, pages: d.pages, read, skipped, status: fin?.status, missing: fin?.missing || null, named };
  },
};

async function pageOf({ fetch: f, config }: JobCtx, doc: number, page: number): Promise<{ text?: string; jpeg_b64?: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await f(config.pagesUrl + '/doc/' + doc + '/page/' + page, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) return (await r.json()) as any;
    } catch { /* once more */ }
  }
  return null;
}

// Then its type and name, when someone left the type on Rulebook or gave no name (only the gaps are filled: schema/037)
async function nameDocument({ db, fetch: f, config }: JobCtx, doc: number) {
  const n = await db.one<{ need: boolean; text: string | null; kind: string; game: string }>('SELECT bgc.rule_doc_naming($1::bigint)', [doc]);
  if (!n || !n.need || !n.text) return { needed: false };
  const label: Record<string, string> = { rulebook: 'rulebook', learn: 'learn-to-play book', expansion: 'expansion rulebook', reference: 'reference guide', aid: 'player aid', appendix: 'appendix', faq: 'FAQ', solo: 'solo rules', other: 'document' };
  const prompt = 'Below are the first pages of a rules document someone added for the board game "' + n.game + '" (they said it is a ' + (label[n.kind] || 'document') + ', but they may have left the default).\n' + NAME_PROMPT + '\n\nPAGES:\n' + n.text;
  const a = await ask(config.openrouterKey!, f, 'rulebook', { model: VISION_MODEL, max_tokens: 80, temperature: 0, reasoning: { enabled: false }, messages: [{ role: 'user', content: prompt }] });
  const o = jsonIn(a.text);
  const r = await db.one('SELECT bgc.rule_doc_autoname($1::bigint, $2, $3), bgc.log_ai(NULL, $4::jsonb)', [doc, String(o.kind || ''), String(o.name || '').trim().slice(0, 120), JSON.stringify([a.cost])]);
  return { needed: true, kind: String(o.kind || ''), name: String(o.name || ''), saved: r };
}
