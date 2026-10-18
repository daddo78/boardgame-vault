# Board Game Garage

A board game collection tracker: a static page (`index.html`) backed by n8n workflows and an Airtable base. Each game shows its box art from BoardGameGeek (or an AI-picked [Tabler Icons](https://tabler.io/icons) glyph when BGG has none), plus BGG details and your play history.

Live at **https://bg.ondorilabo.com** (GitHub Pages, custom domain via Cloudflare) and **https://daddo78.github.io/boardgame-vault/**.

## What the page does

- **Cards** show full-bleed square box art (falling back to the icon), title, year, designers and BGG rank, BGG rating, player count (with BGG's "best with" poll), play time, weight, genre/type tags, a two-line description, your desire-to-play stars, play count and last played, and buttons to favorite (heart), flag for thinning, or remove the game (trash, with confirmation).
- **Click a card** for the full view: play stats with a **Log play** button, a stat grid, BGG mechanics and categories, owned expansions, a BoardGameGeek link, and Delete.
- **Filters**: search (title, genre, mechanics, designers, expansions), genre, desire-to-play rating, player count, length, weight, favorites-only, thinning-only. **Sorts** include favorites first, most/least played, recently played, longest since played, BGG rating and weight. On phones the filters fold behind a "Filters" button.
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

- **Players** (Airtable): a card per person with five 1-5 dials (complexity, conflict, luck, table talk, theme), likes, dislikes, age and notes. Optional: a Google email, which lets that friend sign in and rate games for themselves, and a BGG username.
- **Sync People** (nightly, 4:20am): reads who played and who won from the BGG plays logged in BG Stats. It builds each person's history per owned game, creates a card for anyone with 3+ plays, and pulls BG Stats per-play ratings and friends' BGG ratings.
- **Ratings** come from four sources on a 1-5 scale: the friend on the site, the owner on their behalf, their BGG account, and BG Stats. When a person has several ratings for a game, the first one in that order wins.

## Play tracking

Plays are logged in [BG Stats](https://www.bgstatsapp.com/), which auto-posts them to BGG. BGG is the single source of truth for play counts:

1. **Log play** on a game opens BG Stats' import link (`app.bgstatsapp.com/createPlay.html?data=…`) with the game's name and BGG ID, the date, players (remembered on this device), winner and duration. You confirm in BG Stats. This only works on a phone or tablet with BG Stats installed.
2. With Auto-post on, BG Stats sends the play to BGG.
3. The **Sync Plays From BGG** workflow pulls your BGG plays daily at 4am, or on demand from **Sync plays now** in the settings (cog) dialog, and stores `PlayCount` / `LastPlayed` per game. BGG enrichment also fetches plays for the game it is enriching, so a newly added game shows its plays immediately.

## Architecture

```
index.html (static page, no build step)
  → fetch()
n8n webhooks at https://n8n.ondorilabo.com/webhook/vault/*   (Hostinger VPS, Cloudflare Tunnel)
  → Airtable base "Board Game Garage Collection", table "Games"   (source of truth)
  → OpenRouter: Gemini 2.5 Flash Lite (photo → titles), Claude Haiku 5.5 (icon picks); only providers that don't store data
  → BoardGameGeek XML API2 with an app Bearer token (ratings, details, plays)
```

### Workflows

All workflows are generated by [`n8n/gen.js`](n8n/gen.js) into `n8n/workflows/*.json`. Deploy with [`n8n/deploy.sh`](n8n/deploy.sh), which regenerates, imports, publishes and restarts n8n (a few seconds of downtime). Pass names to deploy a subset, e.g. `./n8n/deploy.sh bggOne iconOne`.

| Workflow | Trigger | Purpose |
|---|---|---|
| Vault — Get Collection | `GET /vault/collection` | All games, shaped for the page |
| Vault — Update Game | `POST /vault/update {id, fields}` | Allow-listed fields only (desireToPlay, thinningCandidate, favorite, icon, title, …) |
| Vault — Delete Game | `POST /vault/delete {id}` | Removes one record |
| Vault — Identify Games From Photo | `POST /vault/identify` (multipart `photo`) | Vision → duplicate checks → create / attach expansion → BGG enrich → icon |
| Vault — Search BGG | `GET /vault/bgg-search?q=` | BGG candidates (title, year, game/expansion and base, thumbnail, rating, rank) for add by name |
| Vault — Add Game By Name | `POST /vault/add {bggId}` or `{title}` | Same duplicate rules as photos; AI writes genre/type/one-liner from BGG's description |
| Vault — Assign Icon (single) | `POST /vault/assign-icon {id, avoid?}` | AI suggests 8 Tabler names; first valid one in the catalog wins, skipping anything in `avoid` |
| Vault — Assign Icons (batch) | manual | Runs the above for every game still on `meeple` |
| Vault — BGG Enrich (single) | `POST /vault/bgg-enrich {id, dryRun?, bggId?, rematch?, adoptTitle?, applyFuzzy?}` | Finds the game on BGG and stores its details |
| Vault — BGG Enrich (batch) | manual | Runs the above for games without a BGG ID |
| Vault — Sync Plays From BGG | daily 4am + `POST /vault/sync-plays` | Play counts from your BGG plays |

### How BGG matching works

- A game that already has a `BGGId` reuses it. Pass `rematch: true` to search again, or `bggId` to pin a specific game (used for bundles like "Splendor Series").
- Otherwise it searches BGG and accepts an exact title match, ranking by number of BGG ratings so the main game wins over a same-named obscure one. Loose matches ("Anno 1800" ~ "Anno 1800: The Board Game") are only saved with `applyFuzzy: true`.
- Titles belong to the collection. BGG never renames a game; with `adoptTitle: true` it may apply a cosmetic fix only (capitalization, punctuation, e.g. "Scout" → "SCOUT"), never a rename ("Steam: Rails to Riches" never becomes "Steam").

### Covers and icons

Box art comes from BGG during enrichment: the XML API only gives a 200×150 thumbnail and the full original (often over 1 MB), so the workflow asks BGG's image endpoint (`api.geekdo.com/api/images/<picId>`) for the sizes its own site uses and stores `medium` (fits 500×500, for cards) and `itempage` (fits 700×700, for the detail view). Images are hotlinked from BGG's CDN and lazy-loaded. Games without BGG art, or whose image fails to load, show their icon instead.

### How icons are picked

Each card uses a Tabler Icons outline glyph (`<i class="ti ti-{icon}">`), loaded from the `@tabler/icons-webfont@3.49.0` CDN. Icon picks are validated against that exact stylesheet, so every saved name renders. The model suggests 8 ranked names based on what's distinctive about the game. The first one that exists (excluding crossed-out `-off` variants) is saved, and `meeple` is the fallback. A spread pass passes overused icons as `avoid`, keeping each icon to about 3 games.

### Airtable fields (table "Games")

`Title`, `GameID` (the page's `id`: `manual-g<N>` for the original list, `photo-g<N>` for photo adds), `Num`, `Genre`, `Type`, `Description`, `Expansions` (JSON array), `DesireToPlay`, `ThinningCandidate`, `Favorite`, `Icon`, `BGGId`, `BGGRating`, `MinPlayers`, `MaxPlayers`, `BestPlayers` (JSON), `MinTime`, `MaxTime`, `Weight`, `Year`, `MinAge`, `Designers` (JSON), `Rank`, `Categories` (JSON), `Mechanics` (JSON), `PlayCount`, `LastPlayed`, `Favorite`, `CoverCard`, `CoverLarge`, `AddedAt`, `UpdatedAt`.

## Local preview

`.claude/launch.json` serves the repo root with a tiny Node static server (`node .claude/static-server.js . 8765`); the page talks to the live n8n.

## Sign-in and security

Anyone can browse the collection. Changing it (ratings, favorites, thinning, adding or deleting games, photo and name lookups, icon and BGG refreshes, play syncs) requires signing in with Google as the owner.

- The page uses Google Identity Services ("Sign in with Google", client ID in `index.html` and `n8n/gen.js`). The Google ID token is kept in the browser and sent as `Authorization: Bearer <token>` with every change. When it expires (about hourly) the page renews it silently.
- Every change webhook starts with a sign-in gate (`addAuth` in `gen.js`): Google's tokeninfo endpoint verifies the token, then n8n requires this client ID, a verified email, and an address in `OWNER_EMAILS`. Anything else gets a 401 before any work is done. A photo upload is deleted first.
- Reading the collection (`GET /vault/collection`) stays public. Workflows calling each other internally skip the gate.
- Right after Google sign-in the page calls `GET /vault/whoami` (behind the same gate). Only if n8n confirms the owner does the page show editing controls; any other account is signed straight back out as view-only. The owner's email lives only in the n8n workflows, not in the public page.

## Hosting

- Repo: public (required for free-tier GitHub Pages).
- `CNAME` points GitHub Pages at `bg.ondorilabo.com`; Cloudflare has a CNAME record `bg → daddo78.github.io`.
