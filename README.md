# Game Garage Collection

A board game collection tracker: a static page (`index.html`) backed by n8n as the database + automation layer. BoardGameGeek integration is disabled for now (see below) — cover art comes from an AI web-search agent instead.

Live at **https://bg.ondorilabo.com** (GitHub Pages, custom domain via Cloudflare) and on **https://daddo78.github.io/boardgame-vault/**.

## Current status

- **Fully working:** your 105 real games, star ratings, thinning flags, delete (with confirmation), and adding new games by photo — all live against your actual n8n at `n8n.ondorilabo.com`.
- **Cover art:** 71 of 105 games (68%) have real box art, found by an n8n workflow that uses an OpenRouter web-search-grounded model, preferring GameNerdz product pages, then falling back to Wikipedia/publisher/BGG pages. It's best-effort — some games just don't turn up a usable image, and it correctly leaves those blank rather than guessing wrong.
- **n8n backend: built directly in your n8n instance** via n8n's own MCP connector (not hand-imported JSON). The `n8n/*.json` files in this repo are a stale reference snapshot from before I had direct n8n access — don't re-import them, they don't match what's actually running.
- **BoardGameGeek: disabled on purpose**, not broken. See below.

## Why BoardGameGeek is disabled

BGG changed their API policy (documented since mid-2025): every XML API call now needs a registered application and an approved Bearer token — confirmed by live 401s on `thing`, `collection`, and `search` alike, with no token-free path. Approval reportedly takes about a week. Rather than leave three half-working, always-failing workflows wired into the page, we removed BGG entirely:

- Photo-identify no longer searches BGG for candidates — the vision model guesses title/genre/type directly and saves immediately.
- Cover art comes from a general web-search agent instead of BGG's image library.
- "Sync from BGG" and the BGG username setting are removed from the page.
- The three BGG-dependent n8n workflows (`Vault - BGG Pull Sync`, `Vault - Confirm & Save Game`, `Vault - BGG Push`) are **unpublished, not deleted** — if you register for BGG API access later, they can be reactivated and wired back in.

## Architecture

```
index.html (static page, no build step)
  → fetch()
n8n webhooks at https://n8n.ondorilabo.com/webhook/vault/*
  → n8n Data Table "vault_games" (your collection, source of truth)
  → OpenRouter (vision model for photo→title; web-search model for cover art)
```

### n8n workflows (all published, in your personal project)

| Workflow | Webhook | Purpose |
|---|---|---|
| Vault - Get Collection | `GET /vault/collection` | Returns all games as JSON |
| Vault - Update Rating / Thinning | `POST /vault/update` | Patches `desireToPlay` / `thinningCandidate` |
| Vault - Delete Game | `POST /vault/delete` | Removes a game by id |
| Vault - Identify Game From Photo | `POST /vault/identify` | Photo → OpenRouter vision guesses title/genre/type → saves directly → triggers cover-art lookup |
| Vault - Find Cover Art | `POST /vault/find-cover-art` | OpenRouter web search finds a likely source page (GameNerdz preferred), extracts its `og:image` tag, validates it's a real image, saves it |
| Vault - Backfill Cover Art (run once) | manual trigger only | One-time batch: finds cover art for every game currently missing a photo |

Unpublished (BGG-dependent, inactive): `Vault - BGG Pull Sync`, `Vault - Confirm & Save Game`, `Vault - BGG Push (STUB)`.

The Data Table (`vault_games`) columns: `game_id` (string, PK — `manual-g<N>` for the original seeded games, `manual-<slug>-<timestamp>` for photo-added games, `bgg-<id>` reserved for any future BGG data), `bgg_id`, `num`, `title`, `genre`, `type`, `desc`, `expansions` (JSON-encoded array), `desire_to_play`, `thinning_candidate`, `bgg_rating`, `photo_url`, `added_at`, `updated_at`.

## How the cover-art agent works

Asking an LLM to directly output an image URL is unreliable — it tends to hallucinate plausible-looking but nonexistent asset paths (tested this; got 404s). The working approach instead:

1. Ask an OpenRouter `:online` (web-search-grounded) model for a *webpage* likely to carry good box art — preferring a GameNerdz product page, then publisher/retailer, then Wikipedia, then BGG — and only accept a URL that genuinely appeared in its search results.
2. Fetch that page's HTML directly (deterministic, no LLM involved) and extract its `og:image` meta tag — the same tag virtually every product/wiki page uses for link-preview thumbnails.
3. Validate the extracted URL actually returns `image/*` content before saving it.

This took the hit rate from ~25% (asking the model to guess an image URL directly) to **68%** (page-then-extract, with GameNerdz preferred).

## Configuring the page

The page already defaults to the live n8n URL (`https://n8n.ondorilabo.com/webhook/vault`), so it works out of the box. Click ⚙ if you ever need to point it elsewhere.

## Security note

The n8n webhooks have no authentication — anyone who finds the URLs could read, write, or delete from your collection. Fine for personal use; worth adding a shared-secret header check (n8n's Webhook node supports Header Auth natively) before treating this as a real public deployment long-term.

## Hosting

- Repo: public (required for free-tier GitHub Pages).
- `CNAME` file points GitHub Pages at `bg.ondorilabo.com`; Cloudflare has a CNAME record `bg → daddo78.github.io`.
- If `bg.ondorilabo.com` ever stops resolving for you, `https://daddo78.github.io/boardgame-vault/` always works as a fallback (though it auto-redirects to the custom domain if the `CNAME` file is present in the repo).
