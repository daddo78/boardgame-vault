// Clears Cloudflare's cache for the site, so a push shows up right away instead of in 10–20 minutes.
// Usage: node tools/purge-cache.js            (bg.ondorilabo.com)
//        node tools/purge-cache.js host.com   (any other host on ondorilabo.com)
// The API token lives outside the repo: ~/.bgc/cloudflare-token.txt, or the CLOUDFLARE_API_TOKEN environment variable
// (on devbox, set at run time from Infisical:
//   CLOUDFLARE_API_TOKEN="$(ssh unraid 'bash /boot/config/artoo-secrets/artoo-secret.sh get CLOUDFLARE_API_TOKEN')" node tools/purge-cache.js). Never commit it.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ZONE = 'acea8b4e639ec06509cf0ad2222bc7c1'; // ondorilabo.com
const host = process.argv[2] || 'bg.ondorilabo.com';
const file = path.join(os.homedir(), '.bgc', 'cloudflare-token.txt');
const token = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) { console.error('No Cloudflare token: put it in ' + file + ' or set CLOUDFLARE_API_TOKEN'); process.exit(1); }

fetch('https://api.cloudflare.com/client/v4/zones/' + ZONE + '/purge_cache', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ hosts: [host] }),
})
  .then((r) => r.json())
  .then((j) => {
    if (!j.success) throw new Error(JSON.stringify(j.errors));
    console.log('Cleared the cache for ' + host + '.');
  })
  .catch((e) => { console.error('Purge failed: ' + e.message); process.exit(1); });
