# Game Garage Collection

A board game collection tracker: a static page (`index.html`) backed by n8n as the database + automation layer, with BoardGameGeek as a (currently blocked — see below) data source.

Live at **https://bg.ondorilabo.com** (GitHub Pages, custom domain via Cloudflare) and on **https://daddo78.github.io/boardgame-vault/**.

## Current status

- **The app itself: fully working.** 105 of your real games are loaded into n8n's `vault_games` Data Table, and the page reads/writes them live — collection grid, ⭐ desire-to-play rating, "mark for thinning" toggle, local caching when n8n is unreachable.
- **n8n backend: already built and published directly in your n8n instance** (`n8n.ondorilabo.com`), not just as importable JSON files — I used n8n's workflow-builder MCP connector to create the Data Table and all 6 workflows for real, with the actual table ID wired in. The `n8n/*.json` files in this repo are a **reference snapshot only** (hand-authored before I had direct n8n access) — they're close in spirit but not byte-identical to what's actually running; don't re-import them, they'd create duplicate/stale workflows.
- **BoardGameGeek integration: blocked by BGG, not by this code.** See below — this is the one real open item.

## BoardGameGeek now requires a registered app + Bearer token

This wasn't true when I started building, but as of testing just now, **every BGG XML API endpoint returns 401 Unauthorized** without one — `thing`, `collection`, and `search` alike. BGG changed their API policy (documented since mid-2025) to require registering an application and getting an approved Bearer token; community reports put approval at roughly a week.

**What's affected:**
- "⟳ Sync from BGG" (pulls your public collection)
- "Confirm & Save Game" (the BGG lookup step after photo identification)
- The BGG-search portion of "Add by Photo"

**What's not affected:** everything else. Your 105 seeded games, ratings, and thinning flags all work today with zero BGG dependency.

**To finish this once you have a token:** register at BGG, wait for approval, hand me the token (it's your own app credential, fine to paste directly — not a password), and I'll add it as an n8n credential and wire `Authorization: Bearer <token>` into the three HTTP Request nodes that call BGG (`HTTP - BGG Thing Detail` in *Vault - Confirm & Save Game*, `HTTP - BGG Collection` in *Vault - BGG Pull Sync*, and `HTTP - BGG Search` / `HTTP - BGG Thumbnails` in *Vault - Identify Game From Photo*).

## BGG has no write API at all

Separately from the above: BGG has never published a way to set `own`/`fortrade`/rating/comment on your collection via API key. "Push to BGG" is a deliberate stub (`Vault - BGG Push (STUB, not implemented)`) that returns `not_implemented`. Doing this for real means driving BGG's logged-in website with your own session cookie, stored as your own n8n credential — not something I'll do for you, since it means handling your BGG login and an endpoint I can't verify from here. The workflow's sticky note has pointers if you want to pursue it yourself later.

## Architecture

```
index.html (static page, no build step)
  → fetch()
n8n webhooks at https://n8n.ondorilabo.com/webhook/vault/*
  → n8n Data Table "vault_games" (your collection, source of truth)
  → BoardGameGeek XML API (blocked — needs a Bearer token, see above)
  → OpenRouter (vision model, for photo → title guess)
```

### n8n workflows (all published, in your personal project)

| Workflow | Webhook | Purpose |
|---|---|---|
| Vault - Get Collection | `GET /vault/collection` | Returns all games as JSON |
| Vault - Update Rating / Thinning | `POST /vault/update` | Patches `desireToPlay` / `thinningCandidate` |
| Vault - Confirm & Save Game | `POST /vault/confirm` | BGG `thing` lookup → upsert *(blocked, needs token)* |
| Vault - Identify Game From Photo | `POST /vault/identify` | Photo → OpenRouter vision → BGG search *(BGG step blocked, needs token)* |
| Vault - BGG Pull Sync | `POST /vault/bgg-pull` | Pulls your public BGG collection *(blocked, needs token)* |
| Vault - BGG Push (STUB) | `POST /vault/bgg-push` | Always returns `not_implemented` by design |

The Data Table (`vault_games`) columns: `game_id` (string, PK — `manual-g<N>` for your original seeded games, `bgg-<id>` for anything pulled/confirmed from BGG), `bgg_id`, `num`, `title`, `genre`, `type`, `desc`, `expansions` (JSON-encoded array), `desire_to_play`, `thinning_candidate`, `bgg_rating`, `photo_url`, `added_at`, `updated_at`.

One caveat carried over from the original design: seeded games (`manual-g<N>`) and BGG-pulled games (`bgg-<id>`) use different id schemes, so a game that's in both your original list and your real BGG collection will show up **twice** until you manually delete one copy — there's no automatic title-matching/merge.

## Configuring the page

The page already defaults to the live n8n URL (`https://n8n.ondorilabo.com/webhook/vault`), so it works out of the box. Click ⚙ if you ever need to point it elsewhere, or set your BGG username for when the sync is unblocked.

## Security note

The n8n webhooks have no authentication — anyone who finds the URLs could read or write your collection. Fine for now; worth adding a shared-secret header check (n8n's Webhook node supports Header Auth natively) before treating this as a real public deployment long-term.

## Hosting

- Repo: public (required for free-tier GitHub Pages).
- `CNAME` file points GitHub Pages at `bg.ondorilabo.com`; Cloudflare has a CNAME record `bg → daddo78.github.io`.
- If `bg.ondorilabo.com` ever stops resolving for you, `https://daddo78.github.io/boardgame-vault/` always works as a fallback (though it auto-redirects to the custom domain if the `CNAME` file is present in the repo).
