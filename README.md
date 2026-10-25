# Board Game Curator

A board game collection tracker for a small invite-only group of friends: a static page (`index.html`) backed by a Postgres database, a small API and a jobs worker on our own server (n8n stays only as the fallback while the move finishes). Each member has a shelf; friends see each other's. Each game shows its box art from BoardGameGeek (or an AI-picked [Tabler Icons](https://tabler.io/icons) glyph when BGG has none), plus BGG details and your play history.

Live at **https://bg.ondorilabo.com** (GitHub Pages, custom domain via Cloudflare) and **https://daddo78.github.io/boardgame-vault/**.

## What the page does

- **Cards** show full-bleed square box art (falling back to the icon), title, year, designers and BGG rank, BGG rating, player count (with BGG's "best with" poll), play time, weight, genre/type tags, a two-line description, your desire-to-play stars, play count and last played, and buttons to favorite (heart), flag for thinning, or remove the game (trash, with confirmation).
- **Click a card** for the full view: play stats with a **Log play** button, a stat grid, BGG mechanics and categories, owned expansions, a BoardGameGeek link, and Delete.
- **Filters**: search (title, genre, mechanics, designers, expansions), genre, desire-to-play rating, player count, length, weight, favorites-only, culling-only. **Sorts** include favorites first, most/least played, recently played, longest since played, BGG rating and weight. On phones the filters fold behind a "Filters" button.
- **Add games** (+ button): **by name** (search BGG, pick the edition, or add a game that isn't on BGG as is) or **by photo** (one box or a shelf section). Owned games are refused, expansions of owned games are attached to them, and new games are looked up on BGG and given an icon.

## Ask Nathan: what should we play?

**Ask Nathan** opens Nathan Schmidt, the collection's curator: warm, meticulous and enthusiastically corny. He recommends from this shelf for these people. Pick who is playing, then ask in plain words ("about an hour, something cozy", "a heavy game for Aaron and me, all evening"). Follow-ups refine the last answer ("shorter", "something different").

- **Step 1, understand** (Gemini 2.5 Flash Lite): turns the request into constraints: who is playing, player count, time, youngest age, complexity, co-op or competitive, themes to include or avoid, and fresh or familiar.
- **Step 2, shortlist** (code): applies the hard limits (players, time, age, weight, co-op, exclusions, and no plays in about 6 months when asked) and scores the rest by the group's ratings, best player count, theme matches and Dan's stars and favorites. The top 30 go to the next step.
- **Step 3, Nathan** (Claude Haiku 5.5): reads each person's profile dials, likes and dislikes, plus their plays, wins and ratings on the shortlisted games. He gives one headline pick and one contrasting alternative, each with a first-mention dad-joke quip, reasons that name people and cite BGG metrics (best-at poll, time, weight, mechanics), and a short "at the table" picture. He may add a maybe-not-tonight. Every answer ends with "And that's what's hitting the table!"
- **Honest gaps:** if nothing meets the limits, or the kind of game asked for isn't on the shelf, Nathan says so, picks the closest owned match, and may name one well-known game worth adding, clearly marked as not owned. He only cites the BGG data stored here, never forums or reviews.
- The page shows the spec chips from its own BGG data, so the numbers are exact. It also remembers which games Nathan has already joked about in the session.
- **Step 4, check** (code): drops anything that is not on the shortlist, so it can't invent games.

Ask is public, board games only, and capped at 200 questions a day overall (about 0.3c each).

### People and ratings

- **In the app:** each game's detail view shows everyone's ratings and the average. A signed-in member gets **Your rating** stars; tap the current rating again to clear it. Nobody rates on someone else's behalf. The shelf owner edits player cards under **Settings → Players**: name, other names (as logged in BG Stats), active, BGG username and Google email.
- **Friends signing in:** invite them from Admin → Members (their Google email); the invite emails them. While the Google OAuth consent screen is in *Testing* mode, also add them as a test user in Google Cloud (APIs & Services → OAuth consent screen → Test users), or publish the app. Basic sign-in scopes need no Google review.

- **Players** (`players` table, one set per shelf): a card per person with name, aliases (as logged in BG Stats), active flag, BGG username and Google email. Members fill in their own taste profile (five 1-5 dials: complexity, conflict, luck, table talk, theme; likes, dislikes, age, about me) under My profile; nobody writes dials or notes about someone else.
- **Sync People** (nightly, 4:20am): reads who played and who won from the BGG plays logged in BG Stats. It builds each person's history per owned game, creates a card for anyone with 3+ plays, and pulls friends' BGG ratings.
- **Ratings**: the stars on the site are each member's own rating (1-5, one per game). BGG ratings (out of 10) are kept separately and shown as BGG's, never mixed in.

## Play tracking

Plays are logged in [BG Stats](https://www.bgstatsapp.com/), which auto-posts them to BGG. BGG is the single source of truth for play counts:

1. **Log play** on a game opens BG Stats' import link (`app.bgstatsapp.com/createPlay.html?data=…`) with the game's name and BGG ID, the date, players (remembered on this device), winner and duration. You confirm in BG Stats. This only works on a phone or tablet with BG Stats installed.
2. With Auto-post on, BG Stats sends the play to BGG.
3. The **Sync Plays From BGG** workflow pulls your BGG plays daily at 4am, or on demand from **Sync plays now** in the settings (cog) dialog, and stores `PlayCount` / `LastPlayed` per game. BGG enrichment also fetches plays for the game it is enriching, so a newly added game shows its plays immediately.

## Architecture

```
index.html, admin.html (static pages, no build step; GitHub Pages behind Cloudflare)
  → fetch() with a Google ID token
  ├→ API    https://api.ondorilabo.com/vault/*      (server/bgc-api: Hono on Node, Docker on the Hostinger VPS)
  │     → bgc-jobs  (the same image as a worker: the schedules, and the slow work the API hands it; Docker network only)
  └→ n8n    https://n8n.ondorilabo.com/webhook/vault/*   (the fallback while the switches are flipped; being retired)
        → Postgres "bgc" (server/bgc-db: the source of truth; bgc.* functions hold the rules)
        → OpenRouter: Gemini 2.5 Flash Lite (understanding a question, photo → titles, reading rulebook pages),
                      Claude Haiku 5.5 (Nathan's answers, icon picks); only providers that don't store data
        → BoardGameGeek XML API2 with an app Bearer token (ratings, details, plays)
        → Resend (feedback and invite emails)
```
Everything reaches the VPS through one Cloudflare Tunnel; Postgres and the API publish no ports.

### Where each request goes

The page asks `GET /vault/routes` once and then sends each area (account, shelves, wishlist, rulebooks, admin, Nathan, …) to the API when its switch is on (Admin → New API: off / admins only / everyone), to n8n otherwise or whenever the API can't be reached. Every route the page uses is on the API now, the last three areas behind their own switches: photos (`/shelf-identify`), the imports (`/import`, `/shelf-csv`) and rulebook uploads (`/rulebook`). Dan's shelf is an ordinary shelf since Oct 25: his adds, edits, removals and play syncs go through the same routes and `bgc.*` functions as everyone's (the old `/collection`, `/add`, `/update`, `/delete`, `/identify` and `/sync-plays` routes are gone); only the visibility rule in the database (his shelf is "main", open to every friend and Nathan's default) tells it apart. A game new to the catalog gets the same polish on any shelf: BGG facts and box art, a blurb (genre, type, one-liner) and a Tabler icon, filling only what's blank (`bgc.polish_game`). `docs/architecture.html` has the per-route table (not yet updated for the worker).

**Jobs worker** (`bgc-jobs`, [`server/bgc-api/src/jobs`](server/bgc-api/src/jobs)): the API's image started as `node dist/jobs/server.js`. It runs the schedules on Michigan time (nightly play syncs at 4:00, 4:20 and 4:30, the backup and plays check at 9:00, the self-test at 5:40, cost readings hourly, Fill Catalog every 10 minutes, the rulebook reader every 2 minutes) and the slow work the API hands it over the Docker network (`POST /run/<job>`: a member's BGG plays, a spreadsheet of games, reading a freshly uploaded rulebook, "Sync plays now"). Every run is a row in `job_runs`; a failed run emails Dan, once per job per 30 minutes. Without a worker (tests, `npm run dev`) the API runs the same functions itself.

**n8n**: all 54 workflows are still generated by [`n8n/gen.js`](n8n/gen.js) into `n8n/workflows/*.json` and deployed with [`n8n/deploy.sh`](n8n/deploy.sh), but only as the fallback: its 9 schedule workflows are unpublished (the worker has them), and its webhooks go once the four new areas have run for a few days.

**API** ([`server/bgc-api`](server/bgc-api)): Hono on Node 22 in Docker beside Postgres; `check.sh` runs types and tests (78), `deploy.sh` ships the API blue/green behind a health check and recreates the worker. Nathan's steps, the input checks and the row shapers are copied word for word out of `gen.js` by `scripts/extract-nathan.cjs`, so n8n and the API can't drift while both exist; the new work (BGG client, catalog, jobs, uploads) is plain TypeScript with its own tests, since n8n's copies retire with it.

**Database** ([`server/bgc-db`](server/bgc-db)): Postgres 16 with the rules in `bgc.*` functions (membership, friends, privacy, ratings, Nathan's memory) and an `at.*` layer that still answers in Airtable's record format (`fld…` field ids), which is what the page reads. Migrations live in `schema/`; NocoDB gives a spreadsheet view; nightly plain-SQL backups go to a private repo.

### How BGG matching works

- A game that already has a `BGGId` reuses it. Pass `rematch: true` to search again, or `bggId` to pin a specific game (used for bundles like "Splendor Series").
- Otherwise it searches BGG and accepts an exact title match, ranking by number of BGG ratings so the main game wins over a same-named obscure one. Loose matches ("Anno 1800" ~ "Anno 1800: The Board Game") are only saved with `applyFuzzy: true`.
- Titles belong to the collection. BGG never renames a game; with `adoptTitle: true` it may apply a cosmetic fix only (capitalization, punctuation, e.g. "Scout" → "SCOUT"), never a rename ("Steam: Rails to Riches" never becomes "Steam").

### Covers and icons

Box art comes from BGG during enrichment: the XML API only gives a 200×150 thumbnail and the full original (often over 1 MB), so the workflow asks BGG's image endpoint (`api.geekdo.com/api/images/<picId>`) for the sizes its own site uses and stores `medium` (fits 500×500, for cards) and `itempage` (fits 700×700, for the detail view). Images are hotlinked from BGG's CDN and lazy-loaded. Games without BGG art, or whose image fails to load, show their icon instead.

### How icons are picked

Each card uses a Tabler Icons outline glyph (`<i class="ti ti-{icon}">`), loaded from the `@tabler/icons-webfont@3.49.0` CDN. Icon picks are validated against that exact stylesheet, so every saved name renders. The model suggests 8 ranked names based on what's distinctive about the game. The first one that exists (excluding crossed-out `-off` variants) is saved, and `meeple` is the fallback. A spread pass passes overused icons as `avoid`, keeping each icon to about 3 games.

### Game fields (the page's wire format)

The page still reads games in Airtable's record shape (`at.game_record` in `schema/002`), by field id; `toGame` in `gen.js`'s prelude maps the ids to these names: `Title`, `GameID` (the page's `id`: `manual-g<N>` for the original list, `photo-g<N>` and `name-g<N>` for adds before Oct 25, `rec…` keys since), `Num`, `Genre`, `Type`, `Description`, `Expansions` (JSON array), `DesireToPlay`, `ThinningCandidate`, `Favorite`, `Icon`, `BGGId`, `BGGRating`, `MinPlayers`, `MaxPlayers`, `BestPlayers` (JSON), `MinTime`, `MaxTime`, `Weight`, `Year`, `MinAge`, `Designers` (JSON), `Rank`, `Categories` (JSON), `Mechanics` (JSON), `PlayCount`, `LastPlayed`, `Favorite`, `CoverCard`, `CoverLarge`, `AddedAt`, `UpdatedAt`.

## Local preview

`.claude/launch.json` serves the repo root with a tiny Node static server (`node .claude/static-server.js . 8765`); the page talks to the live n8n, and to the live API only when it runs with `ALLOW_LOCALHOST=true` (it's off in production, so the page falls back to n8n).

## Sign-in and security

The site is invite only: a visitor sees the landing page and a Google sign-in. Everything behind it, reading included, needs a signed-in member (someone on the invite list; Dan is the admin and invites from Admin → Members).

- The page uses Google Identity Services ("Sign in with Google", public client ID in `index.html`, `server/bgc-api/src/config.ts` and `n8n/gen.js`). The Google ID token is kept in the browser and sent as `Authorization: Bearer <token>` with every request. When it expires (about hourly) the page renews it silently.
- The API checks the token itself with Google's public keys (`src/auth.ts`: signed by Google, for our client, not expired, email verified), then `bgc.sign_in(email)` says whether they're a member and their role. n8n's webhooks do the same through `addMemberAuth` in `gen.js` (Google's tokeninfo endpoint). Anything else gets a 401 before any work is done; a photo upload is deleted first. Workflows calling each other internally have no URL, so they can't be reached from outside.
- Who sees what is decided in the database (`bgc.can_see`, `bgc.are_friends`): your own shelf, Dan's, and the shelves of friends you've connected with by code. A friend never sees your culling list, or your plays with other people.
- Nathan is for members only, with a per-member daily question limit (Admin sets it); questions are never written to the metrics, and photos sent to him are never stored.

## Hosting

- Repo: public (required for free-tier GitHub Pages).
- `CNAME` points GitHub Pages at `bg.ondorilabo.com`; Cloudflare has a CNAME record `bg → daddo78.github.io`.
