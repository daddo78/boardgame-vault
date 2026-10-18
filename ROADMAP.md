# Roadmap

What's next for Board Game Garage, roughly in priority order. Check items off as they land.

## 1. Real-world check on a phone
Things that pass in testing but haven't been tried for real yet:
- [ ] Sign in with the owner's Google account on the live site
- [ ] Rate a game (Your rating) and rate for someone else
- [ ] Log play → BG Stats hand-off → play shows up after a sync
- [ ] Shelf photo with spines, glare and angles (multi-box identify)
- [ ] A friend signs in (needs their Google email on their card, and adding them as a Google test user or publishing the OAuth app)

## 2. Protection against another wipe
- [ ] Nightly backup of the Games, Players and Ratings tables to a private place (GitHub or Google Drive)
- [ ] Error alerts: n8n emails when a nightly sync, photo add or other workflow fails (Resend SMTP is already set up)

## 3. Better Nathan answers
- [ ] Fill in profiles (dials, likes, dislikes) for the regulars: Dan, Brittany, Avery, Amelia, Janis, …
- [ ] Cache the collection and people data for a few minutes so answers come back in ~8-10 s instead of 12-20 s
- [ ] "What's like this?" (Ask Nathan from a game's detail view)

## 4. Data cleanup
- [x] Count plays logged under other editions: games can list extra BGG ids (`ExtraBGGIds`); Catan counts Catan: 3D Edition, and Camel Up is re-linked to the Second Edition you own. Most unmatched plays (~330) turned out to be games not in the collection.
- [ ] Decide which played-but-not-in-collection games are still owned, and add those
- [x] 4 games with no BGG data: left as they are (by choice)
- [x] Merge duplicate player cards: Keith McKimmy III merged into Keith McKimmy (now an alias)

## 5. Later ideas
- [ ] Player pages: each person's top games, win rate, favorites
- [ ] Game night log: who came and what was played
- [ ] Thinning helper: suggest what to let go using thinning flags plus play data
- [ ] Shareable filtered lists ("our party games")
