// Shared by the shelf (app.js) and Admin (admin.js), loaded before either: where the servers are, the Google sign-in
// client, and the few helpers both pages had their own copy of. Anything that differs between the pages stays in them.
const API = 'https://api.ondorilabo.com/vault'; // server/bgc-api: every request the pages make goes here
const GOOGLE_CLIENT_ID = '91195561493-sbejlc54u0jgr6bid835k9mo8k3j5kqc.apps.googleusercontent.com';
const LS_TOKEN = 'vault_id_token'; // where the pages kept Google's ID token before sessions (Nov 24); only read once, to move to a session
const LS_PROFILE = 'vault_profile'; // the signed-in Google account's name, email and picture, for the top bar (not a credential)
// Sign-in: Google is asked once, and the API answers with the site's own session, an HttpOnly cookie for api.ondorilabo.com
// that lasts 60 days without use (server/bgc-api/src/sessions.ts). Every request sends it (credentials) along with the
// X-BGC header, which a page on another site can't add. One cookie for both pages: signed in on the shelf is signed in on Admin.
const withSession = (opts = {}) => ({ ...opts, credentials: 'include', headers: { ...(opts.headers || {}), 'X-BGC': '1' } });
// A Google ID token for a session; the answer is /whoami's ({ role, admin, playerId, playerName }), or 401 for someone not invited
const startSession = (googleToken) => fetch(API + '/session', withSession({ method: 'POST', headers: { Authorization: 'Bearer ' + googleToken } }));
// What the pages keep of a Google account (LS_PROFILE): enough for the top bar and Admin's "who"
const profileOf = (c) => ({ sub: c.sub, email: c.email, name: c.name, given_name: c.given_name, picture: c.picture });
const savedProfile = () => { try { return JSON.parse(localStorage.getItem(LS_PROFILE) || 'null'); } catch (e) { return null; } };
const endSession = () => fetch(API + '/session/end', withSession({ method: 'POST' })).catch(() => {});
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The claims in a Google ID token (a JWT: its middle part is base64url JSON, UTF-8); throws on anything that isn't one
const decodeJwt = (t) => {
  const b = atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent([...b].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
};
