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
| `GET /health` | | `SELECT 1` |

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
