# Board Game Garage Collection

A board game collection tracker: a static page (`index.html`) backed by n8n as the database + automation layer. BoardGameGeek integration is disabled for now (see below). Each game shows an AI-picked [Tabler Icons](https://tablericons.com/) glyph instead of box-art photos — see "How game icons are picked" below.

Live at **https://bg.ondorilabo.com** (GitHub Pages, custom domain via Cloudflare) and on **https://daddo78.github.io/boardgame-vault/**.

## Current status

- **Fully working:** your full 216-game collection (matching your authoritative list, base games and standalone expansions each tracked separately), star ratings with an exact-rating filter, thinning flags, delete (with confirmation), and adding new games by photo — all live against your actual n8n at `n8n.ondorilabo.com`.
- **Icons, not photos:** every game shows a Tabler Icons glyph picked by an AI model from the real ~5,200-icon catalog (not a hand-made genre mapping) — see "How game icons are picked" below. Cover-art photo fetching is retired (workflow unpublished, not deleted).
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
  → OpenRouter (vision model for photo→title; chat model for icon picking)
```

### n8n workflows (all published, in your personal project)

| Workflow | Webhook | Purpose |
|---|---|---|
| Vault - Get Collection | `GET /vault/collection` | Returns all games as JSON |
| Vault - Update Rating / Thinning | `POST /vault/update` | Patches `desireToPlay` / `thinningCandidate` |
| Vault - Delete Game | `POST /vault/delete` | Removes a game by id |
| Vault - Identify Game From Photo | `POST /vault/identify` | Photo → OpenRouter vision guesses title/genre/type → saves directly → assigns an icon |
| Vault - Assign Icon For Game | `POST /vault/assign-icon` | Fetches the live Tabler Icons catalog, asks OpenRouter to pick one icon for a single game, validates the pick against the catalog, saves it |
| Vault - Assign Game Icons (run once) | manual trigger only | Batch version of the above — assigns (or re-assigns anything still on the generic "meeple" fallback) icons for every game in one run |

Unpublished (retired, inactive): `Vault - Find Cover Art`, `Vault - Backfill Cover Art (run once)` (superseded by the icon system), and the BGG-dependent `Vault - BGG Pull Sync`, `Vault - Confirm & Save Game`, `Vault - BGG Push (STUB)`.

The Data Table (`vault_games`) columns: `game_id` (string, PK — `manual-g<N>` for the original seeded games, `manual-<slug>-<timestamp>` for photo-added games, `bgg-<id>` reserved for any future BGG data), `bgg_id`, `num`, `title`, `genre`, `type`, `desc`, `expansions` (JSON-encoded array), `desire_to_play`, `thinning_candidate`, `bgg_rating`, `photo_url` (unused now, kept for potential future revert), `icon`, `added_at`, `updated_at`.

## How game icons are picked

Each game gets a [Tabler Icons](https://tablericons.com/) outline glyph instead of a cover photo, rendered via the `@tabler/icons-webfont` CDN (`<i class="ti ti-{icon}">`). The picking process, learning from the same hallucination problem the old cover-art agent hit:

1. Fetch the **live** Tabler Icons catalog JSON (`unpkg.com/@tabler/icons/icons.json`, ~5,200 names) at workflow run time — never a hardcoded list that could drift out of date.
2. Ask an OpenRouter chat model (`openai/gpt-4o-mini`) to pick the single best-fitting icon name for each game from that real list, based on title/genre/type/description.
3. Validate the model's pick against the fetched name set before saving — an invented or slightly-off name (e.g. a plausible-sounding `"zombie"` that doesn't actually exist in the catalog) falls back to `"meeple"` rather than rendering a broken icon.

The batch workflow is idempotent: re-running it only re-processes games still on the `"meeple"` fallback, so it can be re-run with a stronger prompt to keep chipping away at the hard cases. Starting from a first pass (33% fell back to meeple), two more passes with progressively more specific prompting (concrete examples like "trading euro game → coin", "tile-laying → layout-grid") brought that down to 4%.

## Configuring the page

The page already defaults to the live n8n URL (`https://n8n.ondorilabo.com/webhook/vault`), so it works out of the box. Click the gear icon if you ever need to point it elsewhere.

## Security note

The n8n webhooks have no authentication — anyone who finds the URLs could read, write, or delete from your collection. Fine for personal use; worth adding a shared-secret header check (n8n's Webhook node supports Header Auth natively) before treating this as a real public deployment long-term.

## Hosting

- Repo: public (required for free-tier GitHub Pages).
- `CNAME` file points GitHub Pages at `bg.ondorilabo.com`; Cloudflare has a CNAME record `bg → daddo78.github.io`.
- If `bg.ondorilabo.com` ever stops resolving for you, `https://daddo78.github.io/boardgame-vault/` always works as a fallback (though it auto-redirects to the custom domain if the `CNAME` file is present in the repo).
