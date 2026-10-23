# Roadmap

What's next for Board Game Curator, roughly in priority order. Check items off as they land.

## 1. Real-world check on a phone
Things that pass in testing but haven't been tried for real yet:
- [ ] Sign in with the owner's Google account on the live site
- [ ] Rate a game (Your rating) while signed in
- [ ] Log play → BG Stats hand-off → play shows up after a sync
- [ ] Shelf photo with spines, glare and angles (multi-box identify)
- [ ] A friend signs in (needs their Google email on their card, and adding them as a Google test user)

## 2. Friends & shelves (5-10 people, invite only)
Friends sign in, build their own shelf, and see their friends' shelves. Runs on our own server: Postgres + NocoDB on the Hostinger VPS (`server/bgc-db/`), with n8n doing the work.

**Agreed decisions**
- Shared game catalog: one row per game with the BGG facts; each person's shelf row holds everything personal (favorite, wants-to-play, culling, plays, notes, expansions owned, extra BGG ids)
- Friend connections by code: each member has a code to share; entering someone's code connects you both right away (no browsing the member list). You see a member's shelf only if you are friends; Dan's collection is visible to every member
- BGC stars are each person's own rating; BGG ratings are kept separate, out of 10; nobody rates for someone else
- People speak for themselves: each member sets their own taste profile (complexity, conflict, luck, table talk, theme, likes, dislikes); nobody writes notes or dials about someone else. People who never join are known only from play history
- Friend takes: you can fill in the same card (dials, likes, dislikes) about a friend. Takes are private to the writer: the friend never sees them, and Nathan uses a take only when its writer is the one asking. Nathan weighs a person's own words above a friend's take, and both above plays
- Private to the owner: the culling list, and plays with people other than the viewer
- Friends see: shelf, favorites, wants-to-play, BGC ratings, play counts, and full details of plays they were part of
- Dan is the admin: invites and removes members (Google test users, under Google's 100-user limit). A removed member's shelf and ratings are kept, in case they come back
- Nathan: 30 questions per person per day
- Played-but-not-owned games stay in the data: every play is stored, and games you played but don't own sit in the catalog without a shelf row (useful for Nathan and a "played, not owned" list)
- Airtable becomes a frozen, read-only archive after the move (kept, not deleted)
- Nathan knows people from your own play history (plays are a hint, not a verdict); a friend's own ratings, plays and shelf add to that

**Tables**: members (with their own taste profile), games (catalog), shelves, friendships, ratings (BGC), bgg_ratings, players (each member's BG Stats names and aliases, optionally linked to a member; no notes), plays (real play records from BGG)

**Phases**
- [x] Server: Postgres + NocoDB (`db.ondorilabo.com`, behind Cloudflare Access) + nightly backups to the private repo `daddo78/bgc-backups`
- [x] Phase 1a: tables created (server/bgc-db/schema); copied 220 games + 113 played-not-owned, 40 players, and all 651 BGG plays (2,289 seats); play counts match the live site exactly
- [x] Phase 1b: all workflows run on Postgres through an Airtable-compatible adapter (schema/002); collection identical to Airtable (0 differences); the nightly sync now stores every play. Airtable is the frozen archive (STORE=airtable ./deploy.sh rolls back)
- [ ] Replace the adapter with direct queries as each area is rebuilt for friends (Phases 2-3)
- [x] Phase 2: members: a friend signs in, opens My shelf, enters their BGG username; their owned games, expansions (attached to base games) and every play import in the background (tested end to end: 267 games, 61 expansions, 651 plays in ~2 min). Their own copy gets heart, stars, thinning and remove; Dan's shelf stays view-only for them
- [x] Phase 2b: friends add games by name or photo to their own shelf (shared catalog first, BGG for anything new, expansions under their base game); Nathan, the @ list and "Your rating" follow the shelf being viewed
- [ ] Per-shelf game names: a shelf can call a game something else (today names live in the shared catalog, so "Splendor Series" shows for everyone)
- [x] Phase 3: friends by code: entering a friend's code connects you both right away (no request step); the Friends panel shows your code, adds and removes friends; friends' shelves sit in the shelf switcher, view only with thinning hidden; Nathan and the @ list follow the shelf
- [x] My profile: signed-in members fill in their own card (dials, likes, dislikes, about me, BGG username) from the account menu; the Players screen keeps only names, aliases, email and BGG username
- [x] Friend profile pages: their words, dials, all-time Top 10, most played and wishlist (Friends > Profile)
- [ ] Phase 4: friend takes (private); BG Stats players link to members
- [x] Phase 5: social Nathan: "what can we play at Keith's?", "who has a co-op for 2?", "which of my friends would love Brass?"
- First testers: Aaron Wiesinger and Matt Kruse (emails on their cards, added as Google test users), Keith McKimmy (still need his email); BGG usernames for all three

- [x] Tip jar: ☕ in the top bar opens a thank-you panel linking to ko-fi.com/dandehaan
- [x] Friends icon in the top bar (members only); a "coming soon" panel until Phase 3 makes it real

## 2b. Admin
- [x] Settings > Admin: usage tiles and 30-day charts, per-member usage, invite, remove, admin rights, daily question limit, reset someone's questions
- [x] Sign-in by membership (the invite list), so invitees who aren't in Dan's plays can get in

## 3. Protection against another wipe
- [x] Nightly backup of the new database to a private GitHub repo (restore tested)
- [x] Error alerts: any workflow failure emails Dan (one per workflow per 30 min); a daily health check emails if backups stop

## 4. Better Nathan answers
- [ ] Regulars fill in their own taste profiles once they join (see Friends & shelves)
- [x] Faster answers: about 6.5 s (was 10-20). Data is under a second on Postgres; "thinking" is off for both AI steps
- [x] Nathan knows who is asking, and answers questions about people ("what do you know about me?")
- [ ] "Games like this" with embeddings (pgvector on our own Postgres), alongside "What's like this?"
- [ ] "What's like this?" (Ask Nathan from a game's detail view)
- [x] Nathan answers "my …" questions from your own shelf, wherever you're looking; answers the whole question in his paragraph
- [x] Games beyond the shelf: facts about any game (our catalog, else BGG), "would I like it?", and buy ideas from games you don't own. Who owns a game is only mentioned for your friends
- [ ] Buy ideas beyond our catalog: Nathan proposes titles from his own knowledge, checked against BGG before he mentions them
- [x] Wishlists: add from Nathan's ideas or a friend's library; friends see each other's; Nathan skips wishlisted games in buy ideas; "Got it!" moves a game onto the shelf
- [x] Rules: members upload a game's rulebook PDF once; Nathan answers from it ("per the rulebook"), or from memory (labelled) with a link to BGG's files
- [ ] Rules from memory are often wrong on details: consider a stronger model for those, or nudging people to add the rulebook
- [x] Variety: the page remembers games Nathan recommended you in the last two weeks; he prefers fresh picks, and near-equal fits shuffle
- [x] Nathan gets to know you (v0.12): chats saved in Postgres (`chat_turns`, kept 6 months; a refresh starts a clean panel, by Dan's choice); he sees how the chat started plus the latest 5 turns. While answering he notes up to 2 lasting facts (`member_notes`, max 30 each, "skip" games he won't suggest), shown as "I'll remember…"; My profile lists them with delete and "Forget everything". Chat text stays out of the admin metrics
- [ ] Memory follow-ups: a few multi-turn memory questions in the nightly test set (it runs with memory off today); watch for notes that are really one-off moods
- [x] Rulebook answers with page numbers (v0.13): several documents per game (rulebook, reference guide, appendix, FAQ, solo rules), one shared copy per game. A side-by-side on 4 real rulebooks showed the vision model (Gemini 2.5 Flash, each page's image plus its own text) beats Docling on icons, columns and text-less PDFs, so Docling was dropped. A small page service (bgc-pages) holds the PDF only while it's read, then deletes it: we keep Nathan's text and a link to the official copy, never the file (nothing to back up). Sections are found with Postgres full-text search on words the reading step writes; Nathan cites "(Rulebook, p. 9)" and the page links to the official PDF at that page. Limits: 60 pages, 5 uploads a day. One document is read at a time; unread pages are retried
- [x] Rulebooks for other editions: a deluxe or second edition, or an expansion (its own BGG entry), uses the base game's documents ("X: Deluxe Edition", "X – Second Edition")
- [x] Nathan full screen: pop the chat out to fill the screen (phones especially)
- [x] Photos in the chat: attach a picture to a question ("what does this icon mean?", "what game is this?"); the vision model reads it with the game's rulebook
- [ ] Search by meaning (pgvector) if full-text search misses questions phrased very differently from the rulebook
- [ ] Move Nathan off n8n into his own service: planned, see section 7

## 7. Next: Nathan's own service and one API (starting Sunday, Oct 25)
Why: the 53 n8n workflows are mostly thin API endpoints. One small service is how this is normally built: one sign-in check for every route, one deploy, one place for errors, and Nathan can stream his answers. n8n keeps what it's best at, schedules and background jobs. Start in a fresh Claude session (this one got very long and costly).

**Before we start (Dan, 5 minutes)**
- [x] A Cloudflare tunnel hostname for the service, `api.ondorilabo.com` → `http://bgc-api:8787` on the n8n tunnel, plus its DNS record (Oct 22; the token now has Cloudflare Tunnel: Edit)
- [x] The OpenRouter key in `~/bgc-db/.env` on the server (placed Oct 22; never in the repo)

**Phase 1: the service (`server/bgc-api`)**
Live at https://api.ondorilabo.com since Oct 22 (14 tests, three routes ported: whoami, me, profile; ~20 MB of memory). The page doesn't use it yet, except Admin → Dashboard → New API check, which asks it and n8n the same with your sign-in: whoami, me and profile all gave the same answers as n8n (Oct 22).
- [x] TypeScript on Node in Docker on the same VPS, with Hono (small, fast, standard routing) next to Postgres. No new hosting cost
- [x] One sign-in check for every route: the Google ID token is verified on the server with Google's public keys (no extra call per request), then `bgc.sign_in` for membership and role
- [x] Every input checked (zod), every error a plain message, only the site's address allowed (CORS), per-member rate limits, a health check
- [x] The same database functions as today. They already hold the rules, so what members can see doesn't change
- [x] Deploys never take the site down: the new container starts, passes its health check, then takes over (`server/bgc-api/deploy.sh`; a redeploy under steady requests answered 43 of 43)

**Phase 2: Nathan moves in (the biggest win for members)**
On for everyone since Oct 22. Admin → Nathan keeps an Off switch as an undo until about Nov 6; then the switch and n8n's Ask workflow go, the API's copy of Nathan becomes the one that's edited (no more copying from gen.js), and the nightly self-test asks the API.
- [x] The same steps as today (understand, firm rules, look things up, shortlist, write, check, save) with OpenRouter. His steps are copied word for word from `n8n/gen.js` (`server/bgc-api/scripts/extract-nathan.cjs`), so old and new can't drift apart; plain OpenRouter calls instead of the Vercel AI SDK, so the requests are exactly n8n's
- [x] Answers stream: his first words in about 2 seconds, the rest appearing as he writes, instead of a 6-second wait *(Oct 23: median first words 2.6 → 2.2 s on the live service. Understanding the question no longer waits for the whole shelf, writes its JSON on one line, and Haiku goes to Google Vertex first. Fast enough; we stopped here on purpose. The 3–5 s outliers (about 1 question in 3) are flash-lite being rate-limited on OpenRouter's shared Google quota, so Haiku understands the question instead: slower, same answer. If that ever matters, add our own Google AI Studio key in OpenRouter)*
- [x] A Stop button while he writes, Retry ("Ask again") when something fails, and a partial answer is kept rather than lost
- [x] The 24-question test set runs against the service, old and new compared on the same questions (`TARGET=api node test-nathan.js`: 25/25 on Oct 22 and 23). A build can be tried before it serves anyone (`deploy.sh --trial`, then `API_TAG=<tag>`). Memory follow-ups still to add
- [x] Each call's cost and time still logged for Admin → Costs and the dashboard; question text still never in the metrics (same database calls as n8n, checked in the API tests)
- [x] A switch: Admin → Nathan → Off / Admins only / Everyone (Off for now). If the new service can't be reached, the page asks n8n instead
- [x] Done when: first words in about 2 s (was "under 1.5 s"; 2.2 s is plenty while the words stream), full answers no slower than today (5.1 → 4.8 s), 24/24 tests (25/25), cost per question no higher (writing $0.00073 → $0.00072). Met Oct 23

**Phase 3: the other endpoints**
- [x] One switch point: the page (and Admin) send a request to the API only when its area is on (`GET /vault/routes`), n8n otherwise and whenever the API can't be reached. Areas: account, shelves, wishlist, rulebooks, admin; each off / admins only / everyone (Admin → Dashboard → New API). Nathan's switch now comes through the same list *(Oct 23)*
- [x] The check: New API asks the API and n8n every read with your sign-in (20 of them, friend and rulebook ones filled from n8n's answers) and shows where answers differ *(Oct 23)*
- [x] Reads ported, one file per area: whoami, me, profile, memory; collection, shelf, people, friends; wishlist; rulebook; admin, dashboard, costs, players-admin. Games and people are shaped by n8n's own code (`shape.gen.ts`, copied from gen.js). 29 API tests; every read answered against the real database as Dan and as a member (the slowest: a friend's people, 3.9 s, the same query n8n runs) *(Oct 23; no area switched on yet)*
- [x] Dan: ran the New API check (all the same as n8n, the API 2-4x faster), turned the areas on for admins, then for everyone *(Oct 23)*. The n8n read webhooks can go about Oct 30
- [x] First changes ported, each area with its own switch (off until Dan turns it on): profile save and memory forget (account changes), wishlist add/remove (wishlist changes), rulebook edit/remove (rulebook changes). Their input checks are n8n's own Validate nodes, copied word for word (`validate.gen.ts`). 34 API tests; each one run on the real database as Dan inside a transaction that was rolled back *(Oct 23)*
- [x] More changes ported, each behind its own switch (off): stars, your shelf's favorite / want-to-play / thinning and removing (shelf changes; also Dan's own collection edits and deletes), adding and removing friends (friend changes), player cards and fixed costs (admin changes). 39 API tests; each one run on the real database as Dan and as a member inside a transaction that was rolled back *(Oct 23)*
- [ ] Feedback and admin invites send email (needs mail in the API)
- [ ] Writes that call BGG or AI: bgg-search, add, identify, rulebook upload (bulk BGG and CSV imports may stay in n8n)
- [ ] The page opens with one request for everything it needs (shelf, people, friends, your profile) instead of several, so it loads faster
- [ ] Each area switches over only after its checks pass; the old webhooks are retired a week later

**Phase 4: what stays in n8n**
- [ ] Schedules and background work: nightly play sync, Fill Catalog, the rulebook reader, cost readings, the backup check, failure alerts. They're fine where they are; revisit later

**Small things waiting**
- [ ] Release notes: add "pages no longer jump sideways when a popup opens" to the next version
- [ ] Email Dan when the OpenRouter balance or key runs low (under $2)

## 5. Data cleanup
- [x] Count plays logged under other editions: games can list extra BGG ids (`ExtraBGGIds`); Catan counts Catan: 3D Edition, and Camel Up is re-linked to the Second Edition you own. Most unmatched plays (~330) turned out to be games not in the collection.
- [ ] Decide which played-but-not-in-collection games are still owned, and add those
- [x] 4 games with no BGG data: left as they are (by choice)
- [x] Merge duplicate player cards: Keith McKimmy III merged into Keith McKimmy (now an alias)

## 6. Later ideas
- [ ] Move to boardgamecurator.com (on hold; bought through Cloudflare, nameservers already Cloudflare, no DNS records yet). Dan: two CNAMEs (`@` and `www` → `daddo78.github.io`, DNS only) and the Google OAuth client's origins/redirect (`https://boardgamecurator.com`, `www`, and `/`). Claude: `CNAME` file, links in tools/post-update.js, docs/architecture.html and README, test sign-in, then Enforce HTTPS and a 301 redirect rule from bg.ondorilabo.com. Testers sign in once more; the server stays n8n.ondorilabo.com
- [ ] Player pages: each person's top games, win rate, favorites
- [ ] Game night log: who came and what was played
- [ ] Culling helper: suggest what to let go using culling flags plus play data
- [ ] Shareable filtered lists ("our party games")
