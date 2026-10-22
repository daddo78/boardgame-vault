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
- [ ] Move Nathan off n8n into his own small service (`server/bgc-api`, TypeScript + Vercel AI SDK, free) in Docker on the same Hostinger VPS, reached through the existing Cloudflare tunnel (e.g. api.ondorilabo.com). Same prompts, firm rules, SQL functions and 18-question test set. Gains: answers stream in as he writes, tests run locally in seconds, deploys don't restart n8n. Run old and new side by side behind a switch before moving everyone. Needs from Dan: the tunnel hostname, and the OpenRouter key in `~/bgc-db/.env`. Do it when one of these happens: dozens of users, streaming wanted, Nathan gets tools (add to wishlist, etc.), or deploy/test friction slows work

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
