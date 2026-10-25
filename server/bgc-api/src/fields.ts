// The Airtable field ids the page still reads games, people and ratings by (at.game_record and friends in
// server/bgc-db/schema/002). The same map as F / PF / RF in n8n/gen.js's prelude; shape.gen.ts carries that copy for
// the row shapers, this one is for code written here.
export const GAMES_TABLE = 'tblbGc0UuDxIPP2a8';
export const PLAYERS_TABLE = 'tblNahVdHDueJJ0w4';
export const RATINGS_TABLE = 'tbllInOWIokikEiQH';

export const F = {
  title: 'fldOSxvCDWJdYbUZe', gameId: 'fldJ1g6gtxWDwlWsI', num: 'fldMTwTBzGdIl5juS',
  genre: 'fldiVlY0CFWH4HMmy', type: 'fldAz2n321hbVgQyN', desc: 'fldUvT2Ek81fKIIDG',
  expansions: 'fldVITaI4eagPe9tS', desireToPlay: 'fldV5vlwouSyJcPjY', thinningCandidate: 'fldskzh1rq9uchgYI',
  icon: 'fldAeaCX58kL3EtaF', bggId: 'fldbWi7hhf2VGYzZl', bggRating: 'fld39CpmejKlyRSU9',
  addedAt: 'fldH3CEdj0SibBeMJ', updatedAt: 'fldFQIX0PXXyas2V7',
  minPlayers: 'fldzXSHLRYoKjn9YY', maxPlayers: 'fldwlQj31eoBIgF32', bestPlayers: 'fldGj8TR8Qgr3awAe',
  minTime: 'fldmxVhDKLpxevVS4', maxTime: 'fldAAPDFVAH2lOax5', weight: 'flduy1oWFgwMcu3my',
  year: 'fldt0ihrGswaVysGs', minAge: 'fldyGkN5wNmeMWY1Z', designers: 'fldv2Eza3ozH8eFTy',
  rank: 'fldydnO9FCaM9K4Bx', categories: 'fldDiWapezN3rdwyH', mechanics: 'fldBe9528dZEr70ez',
  playCount: 'fld9pSGve6FsTDxMN', lastPlayed: 'fldVjyyNET9JmjN8d', favorite: 'fldyfp0FG1zY0K4qu', extraBggIds: 'fldzltyZj2UE9Mj67',
  coverCard: 'fldjYYhunnxlv1OI3', coverLarge: 'flduJBzJRHtHfFR44',
} as const;

export const PF = {
  name: 'fldWVws64FVcdtuSJ', aliases: 'fldbPxy87tXFVHtm1', active: 'fldCTgjMOoTTokadR', googleEmail: 'fldnwPL9Z33JcXoj2',
  bggUsername: 'fldDfHIAzk1AyaJEd', complexity: 'fldobSISLYhxr2nb5', conflict: 'fldslaw9Fv5cxiICf', luck: 'fldzLybJ5l8ALWyPz',
  tableTalk: 'fldVkKcUgFxkxTNfi', theme: 'fldk6X4H1FHJ7Uugm', likes: 'fld7R2WFALqZ2gkR7', dislikes: 'fld6ynTKz3kfM6QHx',
  age: 'fldZvY4FJ2QQDCyyh', notes: 'fldcgwd6wvrgnTSdW', playHistory: 'fldGI1Kr6p107QdZp', updatedAt: 'fldyIFTgzcvEqKaGK',
  member: 'fldMbrLinked00001',
} as const;

export const RF = { key: 'fldSVVMwQygNrpyBm', playerId: 'fldB2cw5ie4ypHPGl', gameId: 'fldhrJoBfiLAg1E8q', stars: 'fldSM283jOPAOs2YP', source: 'fldaPLq2gL3UP6zon', updatedAt: 'fldqI4c09b3iHt3um' } as const;

// An Airtable-style record as the adapter answers it
export type AtRecord = { id: string; createdTime?: string; fields: Record<string, any> };
