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
- Shared game catalog: one row per game with the BGG facts; each person's shelf row holds everything personal (favorite, wants-to-play, thinning, plays, notes, expansions owned, extra BGG ids)
- Real friend connections by friend code: each member has a code to share; entering someone's code sends a request they accept (no browsing the member list). You see a shelf only if you are friends with its owner
- BGC stars are each person's own rating; BGG ratings are kept separate, out of 10; nobody rates for someone else
- People speak for themselves: each member sets their own taste profile (complexity, conflict, luck, table talk, theme, likes, dislikes); nobody writes notes or dials about someone else. People who never join are known only from play history
- Private to the owner: the thinning list, and plays with people other than the viewer
- Friends see: shelf, favorites, wants-to-play, BGC ratings, play counts, and full details of plays they were part of
- Dan is the admin: invites and removes members (Google test users, under Google's 100-user limit). A removed member's shelf and ratings are kept, in case they come back
- Nathan: 30 questions per person per day
- Played-but-not-owned games stay in the data: every play is stored, and games you played but don't own sit in the catalog without a shelf row (useful for Nathan and a "played, not owned" list)
- Airtable becomes a frozen, read-only archive after the move (kept, not deleted)
- Nathan knows people from your own play history (plays are a hint, not a verdict); a friend's own ratings, plays and shelf add to that

**Tables**: members (with their own taste profile), games (catalog), shelves, friendships, ratings (BGC), bgg_ratings, players (each member's BG Stats names and aliases, optionally linked to a member; no notes), plays (real play records from BGG)

**Phases**
- [x] Server: Postgres + NocoDB (`db.ondorilabo.com`, behind Cloudflare Access) + nightly backups to the private repo `daddo78/bgc-backups`
- [ ] Phase 1: create the tables; copy the 220 games, 40 players and play history from Airtable; switch the n8n workflows over one by one (Airtable stays as a fallback until everything checks out)
- [ ] Phase 2: members: a friend signs in, enters their BGG username, and their collection and plays import
- [ ] Phase 3: friends: requests, a Friends page, a shelf switcher, visibility rules on every read
- [ ] Phase 4: profiles: each member fills in their own taste profile; BG Stats players link to members; friend profile pages; the dials and notes come off the owner's Players screen
- [ ] Phase 5: social Nathan: "what can we play at Keith's?", "who owns Spirit Island?"
- First testers: Aaron Wiesinger (email on his card), Keith McKimmy, Matt Kruse (still need emails); BGG usernames for all three

## 3. Protection against another wipe
- [x] Nightly backup of the new database to a private GitHub repo (restore tested)
- [ ] Error alerts: n8n emails when a nightly sync, photo add, backup or other workflow fails (Resend SMTP is already set up)

## 4. Better Nathan answers
- [ ] Regulars fill in their own taste profiles once they join (see Friends & shelves)
- [ ] Cache the collection and people data for a few minutes so answers come back in ~8-10 s instead of 12-20 s
- [ ] "What's like this?" (Ask Nathan from a game's detail view)

## 5. Data cleanup
- [x] Count plays logged under other editions: games can list extra BGG ids (`ExtraBGGIds`); Catan counts Catan: 3D Edition, and Camel Up is re-linked to the Second Edition you own. Most unmatched plays (~330) turned out to be games not in the collection.
- [ ] Decide which played-but-not-in-collection games are still owned, and add those
- [x] 4 games with no BGG data: left as they are (by choice)
- [x] Merge duplicate player cards: Keith McKimmy III merged into Keith McKimmy (now an alias)

## 6. Later ideas
- [ ] Player pages: each person's top games, win rate, favorites
- [ ] Game night log: who came and what was played
- [ ] Thinning helper: suggest what to let go using thinning flags plus play data
- [ ] Shareable filtered lists ("our party games")
