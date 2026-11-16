// Shared by the shelf (app.js) and Admin (admin.js), loaded before either: where the servers are, the Google sign-in
// client, and the few helpers both pages had their own copy of. Anything that differs between the pages stays in them.
const API = 'https://api.ondorilabo.com/vault'; // server/bgc-api: every request the pages make goes here
const GOOGLE_CLIENT_ID = '91195561493-sbejlc54u0jgr6bid835k9mo8k3j5kqc.apps.googleusercontent.com';
const LS_TOKEN = 'vault_id_token'; // the Google ID token; one key for both pages, so signed in on the shelf means signed in on Admin
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The claims in a Google ID token (a JWT: its middle part is base64url JSON, UTF-8); throws on anything that isn't one
const decodeJwt = (t) => {
  const b = atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent([...b].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
};
