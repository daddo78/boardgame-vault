// Feedback and Admin's member actions, with a stand-in Resend: what's saved, and the emails they send
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, fakeDb, makeAppWith, OWNER, token } from './helpers.js';

const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });

function resend(opts: { fail?: boolean } = {}) {
  const sent: any[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.resend.com/')) return new Response('?', { status: 404 });
    sent.push({ auth: (init?.headers as any)?.Authorization, ...JSON.parse(String(init?.body)) });
    return opts.fail ? new Response('{"message":"bad"}', { status: 422 }) : Response.json({ id: 'msg_1' });
  }) as typeof fetch;
  return { f, sent };
}
const post = async (app: any, path: string, b: unknown, email = 'amy@example.com') =>
  app.request(path, { method: 'POST', headers: { ...bearer(await token({ email })), 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

test('POST /vault/feedback: saved, then Dan gets an email he can reply to; a status change sends nothing', async () => {
  const { f, sent } = resend();
  const db = fakeDb({ 'bgc.feedback': ([, b]) => (JSON.parse(b as string).action === 'status' ? { ok: true, status: 'done' }
    : { ok: true, id: 5, kind: 'idea', mood: 4, message: 'More dice!', name: 'Amy Example', from: 'amy@example.com' }) });
  const app = makeAppWith({ db, fetch: f, env: { RESEND_API_KEY: 're_test' } });
  assert.deepEqual((await json(await post(app, '/vault/feedback', { kind: 'idea', mood: 4, message: 'More dice!', page: 'shelf' }))).body, { ok: true, message: 'Thanks! Dan reads every one.' });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].auth, sent[0].to, sent[0].reply_to, sent[0].subject], ['Bearer re_test', [OWNER], 'amy@example.com', 'Feedback from Amy: an idea · 4/5']);
  assert.match(sent[0].text, /"More dice!"/);
  assert.match(sent[0].text, /Page: shelf/);
  assert.deepEqual((await json(await post(app, '/vault/feedback', { action: 'status', id: 5, status: 'done' }))).body, { ok: true, status: 'done' });
  assert.equal(sent.length, 1);
});

test('feedback: the email failing (or no key) doesn’t lose the feedback', async () => {
  const db = fakeDb({ 'bgc.feedback': () => ({ ok: true, id: 6, kind: 'problem', name: 'Amy', from: 'amy@example.com' }) });
  const down = resend({ fail: true });
  const app = makeAppWith({ db, fetch: down.f, env: { RESEND_API_KEY: 're_test' } });
  assert.equal((await post(app, '/vault/feedback', { kind: 'problem' })).status, 200);
  const noKey = resend();
  const app2 = makeAppWith({ db, fetch: noKey.f });
  assert.equal((await post(app2, '/vault/feedback', { kind: 'problem' })).status, 200);
  assert.equal(noKey.sent.length, 0);
});

test('POST /vault/admin: an invite emails the new member, replying to the admin; other actions send nothing', async () => {
  const { f, sent } = resend();
  const db = fakeDb({ 'bgc.admin_action': ([e, action]) => (e !== OWNER ? { ok: false, status: 403, message: 'Admins only' } : { ok: true, message: action === 'invite' ? 'Invited Bo' : 'Done' }) });
  const app = makeAppWith({ db, fetch: f, env: { RESEND_API_KEY: 're_test' } });
  const r = await json(await post(app, '/vault/admin', { action: 'invite', email: 'bo@example.com', name: 'Bo Smith' }, OWNER));
  assert.equal(r.body.message, 'Invited Bo. We emailed them how to get started.');
  assert.equal(r.body.emailed, true);
  assert.deepEqual([sent[0].to, sent[0].reply_to, sent[0].subject], [['bo@example.com'], OWNER, 'Dan invited you to Board Game Curator']);
  assert.match(sent[0].html, /Hi Bo,/);
  assert.equal((await json(await post(app, '/vault/admin', { action: 'resetAsks', target: 7 }, OWNER))).body.message, 'Done');
  assert.equal(sent.length, 1);
  assert.deepEqual(await json(await post(app, '/vault/admin', { action: 'invite', email: 'x@example.com', name: 'X' })), { status: 403, body: { ok: false, message: 'Admins only' } });
  assert.deepEqual(await json(await post(app, '/vault/admin', { action: 'nuke' }, OWNER)), { status: 400, body: { ok: false, message: 'Unknown action' } });
  assert.equal(sent.length, 1);
});

test('POST /vault/admin: an invite whose email didn’t go out says so', async () => {
  const { f } = resend({ fail: true });
  const db = fakeDb({ 'bgc.admin_action': () => ({ ok: true, message: 'Invited Bo' }) });
  const app = makeAppWith({ db, fetch: f, env: { RESEND_API_KEY: 're_test' } });
  const r = await json(await post(app, '/vault/admin', { action: 'invite', email: 'bo@example.com', name: 'Bo' }, OWNER));
  assert.deepEqual([r.body.emailed, r.body.message], [false, 'Invited Bo. (The welcome email didn’t go out, so let them know yourself.)']);
});

test('POST /vault/ask-vote: a thumb on a reply reaches bgc.ask_vote as sent; a bad vote or no reply is a 400', async () => {
  const db = fakeDb({ 'bgc.ask_vote': ([e, b]) => ({ ok: true, id: 3, vote: JSON.parse(b as string).vote, note: JSON.parse(b as string).note || '', from: e }) });
  const app = makeAppWith({ db, fetch: resend().f });
  assert.deepEqual((await json(await post(app, '/vault/ask-vote', { chatKey: 'c1', question: 'Something for two?', vote: 'down', note: ' Too long ' }))).body,
    { ok: true, id: 3, vote: 'down', note: ' Too long ', from: 'amy@example.com' });
  assert.deepEqual(JSON.parse(db.calls.find((c) => c.sql.includes('bgc.ask_vote'))!.params[1] as string), { chatKey: 'c1', question: 'Something for two?', vote: 'down', note: ' Too long ' });
  assert.deepEqual((await json(await post(app, '/vault/ask-vote', { chatKey: 'c1', question: 'Something for two?', vote: '' }))).body.vote, '');
  for (const bad of [{ chatKey: 'c1', question: 'x', vote: 'meh' }, { chatKey: '', question: 'x', vote: 'up' }, { chatKey: 'c1', vote: 'up' }, 'nope']) {
    assert.deepEqual(await json(await post(app, '/vault/ask-vote', bad)), { status: 400, body: { ok: false, message: 'Which reply was that?' } }, JSON.stringify(bad));
  }
  assert.equal(db.calls.filter((c) => c.sql.includes('bgc.ask_vote')).length, 2);
});
