# The Vault — Board Game Collection Tracker

A local HTML page for your board game collection, backed by n8n (as the database + automation layer) and BoardGameGeek (as a read source for game data).

## What's here

- `index.html` — the page. Open it directly in a browser (no server needed).
- `n8n/*.json` — seven importable n8n workflows that back the page, including a one-time seed of your actual 105-game collection.

## Honest limitation up front

**BoardGameGeek has no public write API.** You can read any public collection via their XML API (no login needed), but there is no documented, key-authenticated way to set `own`/`fortrade`/rating/comment on your collection from a script. The "push rating/status to BGG" workflow (`vault-bgg-push-stub.json`) is a deliberate stub that returns `not_implemented` — it exists so your page has a stable endpoint to call, but actually wiring it up means reverse-engineering BGG's logged-in website and storing *your own* BGG session as an n8n credential, which I'm not going to do for you (I won't handle your BGG password, and I can't verify an undocumented endpoint I can't test). The sticky note inside that workflow explains how to do it yourself if you want to go further.

Everything else — collection storage, ratings, thinning flags, BGG *pull*, and photo-based add — is fully implemented.

## 1. Set up the Data Table in n8n

n8n's built-in **Data Table** feature needs a table created first (Data Tables aren't created by importing a workflow — you make the table once in the n8n UI, then point the workflow nodes at it).

Create one table, e.g. named `vault_games`, with these columns:

| Column | Type | Notes |
|---|---|---|
| `game_id` | String | Primary/unique key. `"bgg-<id>"` for BGG games. |
| `bgg_id` | Number | Nullable |
| `num` | Number | Display index, optional |
| `title` | String | |
| `genre` | String | |
| `type` | String | |
| `desc` | String | |
| `expansions` | String | JSON-encoded array, e.g. `["Expansion A"]` |
| `desire_to_play` | Number | 0–5 |
| `thinning_candidate` | Boolean | |
| `bgg_rating` | Number | Nullable |
| `photo_url` | String | Nullable |
| `added_at` | String | ISO date |
| `updated_at` | String | ISO date |

## 2. Import the workflows

In n8n: **Workflows → Import from File**, one at a time, for each file in `n8n/`:

1. `vault-get-collection.json`
2. `vault-update.json`
3. `vault-identify-photo.json`
4. `vault-confirm.json`
5. `vault-bgg-pull.json`
6. `vault-bgg-push-stub.json`
7. `vault-seed-initial-collection.json`

After each import, **every node named "Data Table - ..." needs manual attention**: click into it and pick your actual `vault_games` table from the dropdown (I set a placeholder `tableId` since that ID is unique to your instance and didn't exist until you created the table in step 1), then confirm the column mappings match the table above.

**Run `vault-seed-initial-collection.json` once**, manually, via its "Execute workflow" button (it uses a Manual Trigger, not a webhook, since it's a one-time admin action, not something the page calls). It has your actual 105 games — titles, genres, types, descriptions, expansions — embedded directly in its Code node, pulled from the collection list you originally gave me. It upserts them into the Data Table tagged `game_id: "manual-g<N>"`, so re-running it is harmless (no duplicates from re-running it specifically).

One caveat: if you also run "Sync from BGG" later, BGG-sourced rows are tagged `game_id: "bgg-<bggid>"` — a different id scheme. A game you own that's both in your seeded list *and* pulled from BGG will show up **twice** until you manually delete one copy from the Data Table (there's no automatic title-matching/merge between the two id schemes in this version).

In `vault-identify-photo.json`, open **HTTP - OpenRouter Vision** and:
- Attach your OpenRouter credential (an HTTP Header Auth credential with header `Authorization: Bearer <your OpenRouter key>`).
- Replace `REPLACE_WITH_YOUR_OPENROUTER_MODEL` in the JSON body with a vision-capable model you have access to on OpenRouter (e.g. `anthropic/claude-sonnet-4.5` or `openai/gpt-4o`).

Activate all six workflows, then copy each webhook's **Production URL** — they should all share the same base path, something like:

```
https://your-n8n.example.com/webhook/vault/collection
https://your-n8n.example.com/webhook/vault/update
https://your-n8n.example.com/webhook/vault/identify
https://your-n8n.example.com/webhook/vault/confirm
https://your-n8n.example.com/webhook/vault/bgg-pull
https://your-n8n.example.com/webhook/vault/bgg-push
```

If n8n gives you different base segments, adjust the `path` parameter in each Webhook node so they line up, or just set your base URL in the page to whatever prefix is common to all of them.

## 3. Configure the page

Open `index.html` in a browser. Click the ⚙ icon and set:
- **n8n base webhook URL** — e.g. `https://your-n8n.example.com/webhook/vault` (no trailing slash; the page appends `/collection`, `/update`, etc.)
- **Your BoardGameGeek username** — used by "Sync from BGG" (public read, no password needed).

## How each piece behaves

- **Collection grid** loads from n8n on page load, caches locally for offline viewing, and falls back to the cache if n8n is unreachable.
- **Star rating / thinning toggle** write straight to the Data Table via `/update`, with an optimistic UI update that rolls back on failure.
- **"+ " button** lets you photograph a box. The photo goes to `/identify`, which asks your OpenRouter vision model to read the title, searches BGG for matches, and shows you up to 5 candidates with thumbnails to confirm. Picking one calls `/confirm`, which pulls full details (categories, mechanics, expansions, BGG rating, thumbnail) from BGG and saves the row.
- **"⟳ Sync from BGG"** pulls your whole public collection via BGG's XML API and upserts it. BGG occasionally responds "still processing" for large collections on first request — the page will show that message; just click sync again a few seconds later.
- **"Thinning only" filter** shows just the games you've flagged as candidates to get rid of — nothing here touches BGG; it's purely local to your own tracking.

## Known rough edges to watch for

- The binary-to-base64 step in `vault-identify-photo.json` (`Code - Binary to Data URI`) uses `this.helpers.getBinaryDataBuffer`, which is correct for recent n8n versions. If your n8n version handles webhook file uploads differently, that's the one node most likely to need adjusting — check what the Webhook node actually puts on `item.binary` on your version.
- The BGG XML responses are parsed with regex in Code nodes rather than a dedicated XML parser node, to keep the workflows portable across n8n versions. It's deliberately tolerant but not bulletproof — if BGG changes their XML shape, these are the nodes to revisit.
- `vault-bgg-pull.json`'s summary always reports `added: 0` and puts the real count under `updated`/`total` — it doesn't distinguish new vs. existing rows. Easy to improve later by querying existing `game_id`s first if you want the distinction.
