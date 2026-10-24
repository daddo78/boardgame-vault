// A member-gated workflow as a given member, without Google sign-in, for test-ask.sh and run-as.sh: the sign-in nodes
// go, the Webhook becomes a manual trigger, `who` (an optional node that looks the member up) runs first, and the
// Auth: Role code node gets `roleCode`, which must return [{ json: { body|query, _authOk: true, _auth: {...} } }].
// (The nightly self-test's copy, askTest in gen.js, keeps Find Player and starts from another workflow, so it stays its own.)
module.exports = function asMember(w, { id, name, roleCode, who }) {
  w.id = id; w.name = name; delete w.settings.errorWorkflow;
  const target = w.connections['Member?'].main[0][0].node; // where a signed-in member goes next
  const drop = (n) => /^Auth: (Read Token|Verify With Google|Check Token|Find Player)$/.test(n) || n === 'Token Valid?' || n === 'Member?';
  w.nodes = w.nodes.filter((n) => !drop(n.name));
  for (const k of Object.keys(w.connections)) if (drop(k)) delete w.connections[k];
  const wh = w.nodes.find((n) => n.name === 'Webhook');
  Object.assign(wh, { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }); delete wh.webhookId;
  w.nodes.find((n) => n.name === 'Auth: Role').parameters = { jsCode: roleCode };
  const to = (n) => ({ node: n, type: 'main', index: 0 });
  if (who) { w.nodes.push(who); w.connections.Webhook = { main: [[to(who.name)]] }; w.connections[who.name] = { main: [[to('Auth: Role')]] }; }
  else w.connections.Webhook = { main: [[to('Auth: Role')]] };
  w.connections['Auth: Role'] = { main: [[to(target)]] };
  return w;
};
