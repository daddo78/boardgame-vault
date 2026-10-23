// Posts one version's release notes from CHANGELOG.md to the testers' Discord channel.
//   node tools/post-update.js v0.11            post it
//   node tools/post-update.js v0.11 --dry-run  show what would be posted
//   node tools/post-update.js v0.11 --again    post a version that was already posted
// The channel's webhook link lives outside the repo, in %USERPROFILE%\.bgc\discord-webhook.txt (never committed).
const fs = require('fs');
const os = require('os');
const path = require('path');

const [version, flag] = process.argv.slice(2);
if (!/^v\d+\.\d+(\.\d+)?$/.test(version || '')) { console.error('Which version? e.g. node tools/post-update.js v0.11'); process.exit(1); }
const dry = flag === '--dry-run';

const log = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const start = log.search(new RegExp('^## ' + version.replace(/\./g, '\\.') + '\\b', 'm'));
if (start < 0) { console.error(version + ' isn’t in CHANGELOG.md'); process.exit(1); }
const rest = log.slice(start);
const next = rest.slice(3).search(/^## /m);
const section = (next < 0 ? rest : rest.slice(0, next + 3)).trim();

// Discord's flavor of Markdown: the heading as a bold title, sub-headings bold, the rest as written
const lines = section.split('\n');
const title = lines[0].replace(/^## /, '');
const body = lines.slice(1).join('\n').trim()
  .replace(/^### (.+)$/gm, '**$1**')
  .replace(/^\*Behind the scenes: (.+)\*$/gm, '-# Behind the scenes: $1');
const text = '# 🎲 Board Game Curator ' + title + '\n' + body;
const LINK = '\n\nhttps://bg.ondorilabo.com';

// Discord allows 2,000 characters a message: split between paragraphs
const parts = [];
let cur = '';
for (const para of text.split(/\n(?=\*\*|\n)/)) {
  if ((cur + '\n' + para).length > 1900 && cur) { parts.push(cur.trim()); cur = ''; }
  cur += (cur ? '\n' : '') + para;
}
if (cur.trim()) parts.push(cur.trim());
// The site link goes with the last message
if ((parts[parts.length - 1] + LINK).length <= 1990) parts[parts.length - 1] += LINK; else parts.push(LINK.trim());

if (dry) { parts.forEach((p, i) => console.log('--- message ' + (i + 1) + ' of ' + parts.length + ' (' + p.length + ' chars) ---\n' + p + '\n')); process.exit(0); }

// Each post is noted in %USERPROFILE%\.bgc\discord-posted.txt, so a version isn't posted twice by mistake
const posted = path.join(os.homedir(), '.bgc', 'discord-posted.txt');
const already = fs.existsSync(posted) && fs.readFileSync(posted, 'utf8').split('\n').some((l) => l.split(' ')[0] === version);
if (already && flag !== '--again') { console.error(version + ' was already posted (see ' + posted + '). Add --again to post it anyway.'); process.exit(1); }

const file = path.join(os.homedir(), '.bgc', 'discord-webhook.txt');
if (!fs.existsSync(file)) { console.error('No webhook yet. Put the channel’s webhook link in ' + file); process.exit(1); }
const url = fs.readFileSync(file, 'utf8').trim();
if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) { console.error('That file doesn’t hold a Discord webhook link'); process.exit(1); }

(async () => {
  for (const content of parts) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Board Game Curator', avatar_url: 'https://bg.ondorilabo.com/assets/nathan-avatar.png', content, allowed_mentions: { parse: [] } }) });
    if (!res.ok) { console.error('Discord said ' + res.status + ': ' + (await res.text()).slice(0, 200)); process.exit(1); }
    await new Promise((r) => setTimeout(r, 800));
  }
  fs.appendFileSync(posted, version + ' ' + new Date().toISOString() + '\n');
  console.log('Posted ' + version + ' to Discord (' + parts.length + ' message' + (parts.length === 1 ? '' : 's') + ').');
})();
