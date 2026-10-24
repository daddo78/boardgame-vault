// Shared by the shelf (app.js) and Admin (admin.js), loaded before either: where the servers are, the Google sign-in
// client, and the few helpers both pages had their own copy of. Anything that differs between the pages stays in them.
const N8N_BASE = 'https://n8n.ondorilabo.com/webhook/vault';
const API = 'https://api.ondorilabo.com/vault'; // the new service, taking over from n8n one area at a time (Roadmap 7)
const GOOGLE_CLIENT_ID = '91195561493-sbejlc54u0jgr6bid835k9mo8k3j5kqc.apps.googleusercontent.com';
const LS_TOKEN = 'vault_id_token'; // the Google ID token; one key for both pages, so signed in on the shelf means signed in on Admin
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The claims in a Google ID token (a JWT: its middle part is base64url JSON, UTF-8); throws on anything that isn't one
const decodeJwt = (t) => {
  const b = atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent([...b].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
};
// The new service when its area is on for you, else n8n; n8n also when the new service can't be reached.
// Each page defines apiRoutes(): the areas switched on for whoever is signed in there (e.g. 'GET /shelf', 'POST /ask').
async function routedFetch(path, o, auth = true) {
  const key = (o.method || 'GET').toUpperCase() + ' ' + path.split('?')[0];
  if (auth && (await apiRoutes()).has(key)) {
    try { const r = await fetch(API + path, o); if (r.status < 502) return r; } catch (e) {}
  }
  return fetch(N8N_BASE + path, o);
}
