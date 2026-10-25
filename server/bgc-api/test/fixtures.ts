// Stand-in BoardGameGeek XML for the tests
export const THING = (type: string, id: number, name: string, users: number, extra = '') =>
  `<item type="${type}" id="${id}"><thumbnail>https://cf.geekdo-images.com/${id}.jpg</thumbnail><image>https://cf.geekdo-images.com/pic${id}0.jpg</image>` +
  `<name type="primary" sortindex="1" value="${name}"/><name type="alternate" value="Other ${name}"/><description>Trade &amp; build.&#10;Settle the island.</description><yearpublished value="1995"/><minplayers value="3"/><maxplayers value="4"/><minplaytime value="60"/><maxplaytime value="120"/><minage value="10"/>` +
  `<link type="boardgamecategory" id="1" value="Negotiation"/><link type="boardgamemechanic" id="2" value="Dice Rolling"/><link type="boardgamedesigner" id="3" value="Klaus Teuber"/><link type="boardgamedesigner" id="4" value="(Uncredited)"/>${extra}` +
  `<poll name="suggested_numplayers"><results numplayers="3"><result value="Best" numvotes="10"/><result value="Recommended" numvotes="20"/><result value="Not Recommended" numvotes="1"/></results>` +
  `<results numplayers="4"><result value="Best" numvotes="50"/><result value="Recommended" numvotes="10"/><result value="Not Recommended" numvotes="1"/></results></poll>` +
  `<statistics><ratings><usersrated value="${users}"/><average value="7.14"/><averageweight value="2.345"/><ranks><rank type="subtype" id="1" name="boardgame" value="500"/></ranks></ratings></statistics></item>`;

// What BGG's /search answers for those things: type, id, primary name and year (search items carry no stats)
export const searchItemsOf = (things: Record<string, string>) => '<items>' + Object.values(things).map((t) => {
  const m = t.match(/<item type="([^"]+)" id="(\d+)">/)!, n = t.match(/<name type="primary"[^>]*value="([^"]*)"/)!, y = t.match(/<yearpublished value="(\d+)"/);
  return '<item type="' + m[1] + '" id="' + m[2] + '"><name type="primary" value="' + n[1] + '"/>' + (y ? '<yearpublished value="' + y[1] + '"/>' : '') + '</item>';
}).join('') + '</items>';
