# bgc-api

The Board Game Curator API (ROADMAP section 7). TypeScript on Node with Hono, in Docker on the Hostinger VPS next to Postgres.

- **Sign-in, once for every route** (`src/auth.ts`): the Google ID token is checked here with Google's public keys (cached; no call to Google per request), then the rate limit, then `bgc.sign_in` says whether the person is a member and their role (remembered for a minute). Same outcome as `addMemberAuth` in `n8n/gen.js`. If Google's keys can't be fetched the answer is a 503 ("try again in a moment"), not "sign in again".
- **Same rules as today**: routes only call the `bgc.*` functions the n8n workflows call (`src/db.ts`); changes are checked by the workflows' own Validate nodes (`src/validate.gen.ts`, through `src/writes.ts`).
- **Inputs** are checked with zod (`src/request.ts`); **errors** are `{ ok: false, message }` with a plain message; **CORS** allows only https://bg.ondorilabo.com (plus localhost when `ALLOW_LOCALHOST=true`, which only tests and `npm run dev` set); each member has a **rate limit** (120 a minute by default); `GET /health` says whether it can reach the database.

## Routes

Everything under `/vault` needs the sign-in. One line each; the route's own comment in `src/routes/*` says more.

| Route | Was (n8n) | Database |
| --- | --- | --- |
| `GET /vault/whoami` | Who Am I | `bgc.sign_in` |
| `GET /vault/me` | My Profile | `bgc.my_profile` |
| `GET /vault/profile[?friend=id]` | Profile Page | `bgc.profile_page` |
| `GET /vault/memory[?chat=key]` | Nathan Memory | `bgc.memory_page` |
| `POST /vault/me-save` | Save My Profile | `bgc.save_profile` |
| `POST /vault/memory` `{ action: forget\|forgetAll, id }` | Nathan Forget | `bgc.memory_forget` |
| `GET /vault/shelf` | My Shelf | `bgc.shelf` |
| `GET /vault/friends[?shelf=id]` | Friends | `bgc.friends`, `bgc.friend_shelf` |
| `GET /vault/people[?shelf=mine\|friend:id]` | People | `bgc.shelf_view`, `bgc.my_ratings_on`, `bgc.asks_used` |
| `POST /vault/rate` `{ gameId, stars }` | Rate Game | `bgc.rate` |
| `POST /vault/shelf-update` `{ id, fields }` | Update My Shelf | `bgc.shelf_update` |
| `POST /vault/shelf-remove` `{ id }` | Remove From My Shelf | `bgc.shelf_remove` |
| `POST /vault/friends` `{ action: add\|remove, code \| id }` | Friends (change) | `bgc.add_friend`, `bgc.remove_friend` |
| `GET /vault/bgg-search?q=title` | Search BGG | BoardGameGeek's XML API |
| `POST /vault/shelf-add` `{ bggId \| title }` | Add To My Shelf | BGG, then `bgc.shelf_add`, then `bgc.polish_game` (blurb, icon) |
| `GET /vault/wishlist[?friend=id]` | Wishlist | `bgc.wishlist` |
| `POST /vault/wishlist` `{ action: add\|remove, bggId, title, cover }` | Wishlist (change) | `bgc.wish_change` |
| `GET /vault/rulebook?bgg=id \| ?games=1` | Rulebook (list) | `bgc.rule_docs_of`, `bgc.rule_doc_games` |
| `POST /vault/rulebook-change` `{ id, action: remove \| kind, title, source }` | Rulebook (change) | `bgc.rule_doc_change` |
| `GET /vault/admin`, `/dashboard`, `/costs` | Admin, Dashboard, Costs | `bgc.admin_overview`, `bgc.dashboard`, `bgc.costs_page` |
| `GET /vault/players-admin` (admins) | Players Admin | `bgc.players_admin` |
| `POST /vault/player-save` (admins) | Save Player | `bgc.player_save` |
| `POST /vault/shelf-identify` (multipart photo) | Add To My Shelf From Photo | vision model, BGG, `bgc.shelf_add`, `bgc.polish_game` |
| `POST /vault/import` `{ bggUsername }` | Connect BGG Plays | `bgc.start_import`, then the worker's memberPlays |
| `POST /vault/shelf-csv` `{ rows }` | Add To My Shelf From CSV | `bgc.start_csv`, then the worker's shelfCsv |
| `POST /vault/rulebook` (multipart) | Rulebook (upload) | `bgc.rule_doc_new`, bgc-pages, `bgc.rule_doc_stored`, then the worker's ruleReader |
| `POST /vault/admin` `{ action: invite\|remove\|admin\|resetAsks\|askLimit, … }` | Admin actions | `bgc.admin_action`; an invite emails the new member (Resend) |
| `POST /vault/costs` `{ fixed: [...] }` | Costs (save) | `bgc.costs_fixed_save` |
| `POST /vault/feedback` `{ kind, mood, message, page, device } \| { action: status, id, status }` | Feedback | `bgc.feedback`; Dan gets an email (Resend) |
| `POST /vault/ask` | Ask Nathan | Nathan's steps (below) |
| `POST /vault/ask/stream` | | the same, streamed as he writes (Server-Sent Events) |
| `GET /vault/routes` | | which requests the page sends here, from the area switches |
| `GET/POST /vault/api-areas` (admins) | | `settings` key `api_areas`: each area off / admins / everyone |
| `GET/POST /vault/nathan-mode` (POST: admins) | | `settings` key `nathan_api`: off / admins / everyone |
| `GET /health` | | `SELECT 1` |

## Moving the site over, one area at a time

`src/routes/areas.ts` groups the routes into areas (account, shelves, wishlist, rulebooks, admin, and one per kind of change). Admin → Dashboard → New API runs every read against this service and n8n with your sign-in and shows where answers differ; each area then has its own switch (off / admins only / everyone). The page asks `GET /vault/routes` once per sign-in and sends only those requests here, anything else (and anything this service can't answer) to n8n.

Games and people are shaped by n8n's own code: `src/shape.gen.ts` is `prelude()` from `n8n/gen.js`, and `src/nodes.gen.ts` the code nodes of the ported workflows (BGG search, feedback and invite emails, admin actions), copied by the same script as Nathan's steps.

## Nathan

`src/nathan/steps.gen.ts` is Nathan's steps copied word for word from the Ask workflow in `n8n/gen.js`, so both give the same answers while both exist. Change Nathan in `gen.js`, then:

```bash
node scripts/extract-nathan.cjs
```

`src/nathan/ask.ts` runs the steps in n8n's order and does what n8n's other nodes did (database, OpenRouter, BGG). Only the last step (writing the answer) streams. Admin → Nathan chooses who gets this service; the page falls back to n8n if it can't be reached.

The question set against the API (from `n8n/`): `TARGET=api node test-nathan.js`. It runs `node dist/tools/askAs.js` inside the container, which asks as a member without a web sign-in.

## On this computer

```bash
./check.sh                       # types (src and test), tests, build
ALLOW_LOCALHOST=true npm run dev   # the API on :8787 for the page served from localhost (PowerShell: $env:ALLOW_LOCALHOST='true'; npm run dev)
```

The repo is on Google Drive, where npm can't write `node_modules`, so `check.sh` works in a copy under `%LOCALAPPDATA%\bgc-api-work`.
Tests use a stand-in Google key and a stand-in database (`test/helpers.ts`), so they need neither the internet nor Postgres. `tsconfig.test.json` type-checks the tests too; `tsconfig.json` (the build) covers `src` alone.

## On the server

```bash
./deploy.sh    # check, ship to ~/bgc-api, build, start the new container beside the old, switch once healthy
./deploy.sh --trial    # ship and build only; nothing starts and members still get the running one
API_TAG=<tag> TARGET=api node ../../n8n/test-nathan.js    # the question set against that build, in throwaway containers
```

Secrets come from `~/bgc-db/.env`: `POSTGRES_PASSWORD`, `OPENROUTER_API_KEY` (Nathan), `BGG_TOKEN` (BoardGameGeek) and `RESEND_API_KEY` (email), read by `docker-compose.yml`. The container has no published ports; the Cloudflare tunnel reaches it as `http://bgc-api:8787` on the n8n network.
