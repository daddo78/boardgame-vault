# bgc-api

The Board Game Curator API (ROADMAP section 7). TypeScript on Node with Hono, in Docker on the Hostinger VPS next to Postgres.

- **Sign-in, once for every route** (`src/auth.ts`): the Google ID token is checked here with Google's public keys (cached; no call to Google per request), then `bgc.sign_in` says whether the person is a member and their role. Same outcome as `addMemberAuth` in `n8n/gen.js`.
- **Same rules as today**: routes only call the `bgc.*` functions the n8n workflows call (`src/db.ts`).
- **Inputs** are checked with zod; **errors** are `{ ok: false, message }` with a plain message; **CORS** allows only https://bg.ondorilabo.com (and localhost while testing); each member has a **rate limit** (120 a minute by default); `GET /health` says whether it can reach the database.

## Routes so far

| Route | Was (n8n) | Database |
| --- | --- | --- |
| `GET /vault/whoami` | Who Am I | `bgc.sign_in` |
| `GET /vault/me` | My Profile | `bgc.my_profile` |
| `GET /vault/profile[?friend=id]` | Profile Page | `bgc.profile_page` |
| `POST /vault/ask` | Ask Nathan | Nathan's steps (below) |
| `POST /vault/ask/stream` | | the same, streamed as he writes (Server-Sent Events) |
| `GET/POST /vault/nathan-mode` | | `settings` key `nathan_api`: off / admins / everyone |
| `GET /health` | | `SELECT 1` |

## Nathan

`src/nathan/steps.gen.ts` is Nathan's steps copied word for word from the Ask workflow in `n8n/gen.js`, so both give the same answers while both exist. Change Nathan in `gen.js`, then:

```bash
node scripts/extract-nathan.cjs
```

`src/nathan/ask.ts` runs the steps in n8n's order and does what n8n's other nodes did (database, OpenRouter, BGG). Only the last step (writing the answer) streams. Admin → Nathan chooses who gets this service; the page falls back to n8n if it can't be reached.

The question set against the API (from `n8n/`): `TARGET=api node test-nathan.js`. It runs `node dist/tools/askAs.js` inside the container, which asks as a member without a web sign-in.

## On this computer

```bash
./check.sh     # types, tests, build
```

The repo is on Google Drive, where npm can't write `node_modules`, so `check.sh` works in a copy under `%LOCALAPPDATA%\bgc-api-work`.
Tests use a stand-in Google key and a stand-in database (`test/helpers.ts`), so they need neither the internet nor Postgres.

## On the server

```bash
./deploy.sh    # check, ship to ~/bgc-api, build, start the new container beside the old, switch once healthy
```

Secrets come from `~/bgc-db/.env` (`POSTGRES_PASSWORD`; later `OPENROUTER_API_KEY`). The container has no published ports; the Cloudflare tunnel reaches it as `http://bgc-api:8787` on the n8n network.
