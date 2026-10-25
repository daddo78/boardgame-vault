// Uploading a rulebook. Ported from the n8n workflow Rulebook (upload) (n8n/gen.js section 32): the document is made
// (bgc.rule_doc_new checks the daily limit), the PDF goes to the page service (bgc-pages), which keeps it only until
// Nathan has read it, its length and fingerprint are checked (bgc.rule_doc_stored), and the reader is poked to start.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import type { Fetch } from '../http.js';
import type { JobsClient } from '../jobsClient.js';

export type UploadDeps = { pagesUrl: string; fetch: Fetch; jobs: JobsClient };

export function rulebookUploadRoutes(db: Db, d: UploadDeps) {
  return new Hono<AuthEnv>()
    // POST /vault/rulebook (multipart { file, bggId, gameTitle, kind, title, source })
    .post('/rulebook', async (c) => {
      const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
      const file = form.file;
      if (!(file instanceof File) || !file.size) throw new ApiError(400, 'Choose a PDF to upload');
      if (!/pdf/i.test(file.type || '') && !/\.pdf$/i.test(file.name || '')) throw new ApiError(400, 'Rulebooks need to be PDFs');
      const str = (k: string) => (typeof form[k] === 'string' ? String(form[k]) : '');
      const bggId = Number(str('bggId')) || 0;
      if (!bggId) throw new ApiError(400, 'Which game is this for?');
      const source = str('source').trim();
      if (source && !/^https:\/\/\S{4,}$/.test(source)) throw new ApiError(400, 'The link to the official copy should start with https://');
      const email = c.get('auth').email;
      const doc = fromDb(await db.one<Record<string, any>>('SELECT bgc.rule_doc_new($1, $2::int, $3, $4, $5, $6)',
        [email, bggId, str('gameTitle').slice(0, 200), str('kind') || 'rulebook', str('title').slice(0, 120), source]));
      const id = Number(doc.id);
      // The page service takes the PDF and says how many pages it has
      let pages = 0, sha = '', why = '';
      try {
        const r = await d.fetch(d.pagesUrl + '/doc/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(await file.arrayBuffer()), signal: AbortSignal.timeout(120_000) });
        const j: any = await r.json().catch(() => ({}));
        if (r.ok) { pages = Number(j.pages) || 0; sha = String(j.sha256 || ''); } else why = String(j.error || '');
      } catch (e) { why = 'The page service didn’t answer: ' + String((e as Error)?.message || e); }
      const q = pages > 0
        ? await db.one<Record<string, any>>('SELECT bgc.rule_doc_stored($1::bigint, $2::int, $3)', [id, pages, sha])
        : { ok: false, status: 400, message: why || 'That file couldn’t be read as a PDF.' };
      if (!q || q.ok === false) {
        // Not queued (too long, already here, not a PDF): the page service lets go of the file, and the half-made document goes too
        await d.fetch(d.pagesUrl + '/doc/' + id, { method: 'DELETE', signal: AbortSignal.timeout(20_000) }).catch(() => null);
        await db.one('SELECT bgc.rule_doc_drop($1::bigint)', [id]).catch(() => null);
        throw new ApiError((q?.status || 400) as any, q?.message || 'Something went wrong. Try again.');
      }
      const docs = fromDb(await db.one<Record<string, any>>('SELECT bgc.rule_docs_of($1, $2::int)', [email, bggId]));
      void d.jobs.run('ruleReader', {}); // start reading right away (the reader also checks the queue every two minutes)
      return c.json({ ...docs, queued: id });
    });
}
