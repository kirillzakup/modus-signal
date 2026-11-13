'use strict';
const assert = require('node:assert/strict');
const core = require('../public/core.js');
function schedule(now = Date.now()) {
  return { collectUntil: new Date(now + 3600000).toISOString(), voteUntil: new Date(now + 7200000).toISOString() };
}
function completeTeam(state, ticket, now = Date.now()) {
  assert.equal(ticket.team.phase, 'collect');
  const ids = ticket.team.participants.filter(id => { const u = state.users.find(x => x.id === id); return u && !u.disabled && u.active !== false && !u.absent; });
  if (!ticket.options.length) core.proposeOption(state, ids[0], ticket.id, { text: 'Inspect the equipment and replace the faulty component' }, now);
  for (const id of ids) if (!ticket.team.responses[id]) core.teamPass(state, id, ticket.id, 'Reviewed the proposed solution', now);
  assert.equal(ticket.team.phase, 'vote');
  const optionId = ticket.options[0].id;
  for (const id of ids) core.voteOption(state, id, ticket.id, optionId, now);
  assert.equal(ticket.team.phase, 'ready');
  assert.equal(ticket.decision.optionId, optionId);
  assert.equal(ticket.status, 'review');
  return ticket;
}
module.exports = { schedule, completeTeam };
