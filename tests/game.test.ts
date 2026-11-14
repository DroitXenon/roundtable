import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, createGame, faction, privateView, publicView, teamSizes } from '../server/game.ts';
import type { Actor, GameAction, GameState, OptionalRole, Role } from '../shared/protocol.ts';

const host: Actor = { kind: 'host' };
const system: Actor = { kind: 'system' };
const player = (playerId: string): Actor => ({ kind: 'player', playerId });
const act = (state: GameState, action: GameAction, actor: Actor = host) => applyAction(state, actor, action);

function lobby(count = 5, optionalRoles: OptionalRole[] = []) {
  let state = createGame('ABC123');
  for (let i = 1; i <= count; i++) {
    state = act(state, { type: 'join', player: { id: `p${i}`, name: `Player ${i}` } }, system);
  }
  return act(state, { type: 'configure', optionalRoles });
}

function started(count = 5, optionalRoles: OptionalRole[] = []) {
  return act(lobby(count, optionalRoles), { type: 'start' });
}

function ready(state: GameState) {
  for (const seat of state.players) state = act(state, { type: 'ready' }, player(seat.id));
  return state;
}

function proposal(state: GameState, requiredIds: string[] = []) {
  const size = teamSizes(state.players.length)[state.questNumber - 1];
  const rest = state.players.map((seat) => seat.id).filter((id) => !requiredIds.includes(id));
  const team = [...requiredIds, ...rest].slice(0, size);
  return act(state, { type: 'propose', team }, player(state.players[state.leaderIndex].id));
}

function vote(state: GameState, approvals: boolean | boolean[] = true) {
  for (let i = 0; i < state.players.length; i++) {
    state = act(state, { type: 'vote', approve: typeof approvals === 'boolean' ? approvals : approvals[i] }, player(state.players[i].id));
  }
  return state;
}

function playQuest(state: GameState, failingIds: string[] = []) {
  state = proposal(state, failingIds);
  state = vote(state);
  state = act(state, { type: 'continue' });
  for (const id of state.team) {
    state = act(state, { type: 'quest-card', card: failingIds.includes(id) ? 'fail' : 'success' }, player(id));
  }
  return state;
}

function fixedRoles(count = 7) {
  const state = ready(started(count));
  state.roles = Object.fromEntries(state.players.map((seat, index) => [seat.id,
    index === 0 ? 'assassin' : index <= (count <= 6 ? 1 : 2) ? 'minion' : index === 3 ? 'merlin' : 'servant']));
  return state;
}

test('classic player counts determine factions and all five team sizes', () => {
  const counts = [3, 4, 4, 5, 6, 6];
  const sizes = [[2, 3, 2, 3, 3], [2, 3, 4, 3, 4], [2, 3, 3, 4, 4],
    [3, 4, 4, 5, 5], [3, 4, 4, 5, 5], [3, 4, 4, 5, 5]];
  for (let count = 5; count <= 10; count++) {
    const state = started(count);
    const roles = Object.values(state.roles);
    assert.equal(roles.length, count);
    assert.equal(roles.filter((role) => faction(role) === 'good').length, counts[count - 5]);
    assert.equal(roles.filter((role) => role === 'merlin').length, 1);
    assert.equal(roles.filter((role) => role === 'assassin').length, 1);
    assert.deepEqual(teamSizes(count), sizes[count - 5]);
    assert.ok(state.leaderIndex >= 0 && state.leaderIndex < count);
  }
  assert.deepEqual(teamSizes(4), []);
  const sizesCopy = teamSizes(5);
  sizesCopy[0] = 99;
  assert.equal(teamSizes(5)[0], 2);
});

test('lobby enforces seat uniqueness, capacity, authorization and role quotas', () => {
  const state = lobby();
  assert.throws(() => act(state, { type: 'start' }, player('p1')), /host/);
  assert.throws(() => act(lobby(4), { type: 'start' }), /5–10/);
  assert.throws(() => act(state, { type: 'join', player: { id: 'new', name: 'player 1' } }, system), /name.*in use/);
  assert.throws(() => act(state, { type: 'join', player: { id: 'p1', name: 'New' } }, system), /already seated/);
  assert.throws(() => act(state, { type: 'join', player: { id: '__proto__', name: 'New' } }, system), /identity/);
  assert.throws(() => act(state, { type: 'join', player: { id: 'new', name: 'New' } }, host), /join screen/);
  assert.throws(() => act(lobby(10), { type: 'join', player: { id: 'new', name: 'New' } }, system), /full/);
  assert.throws(() => act(state, { type: 'configure', optionalRoles: ['morgana', 'morgana'] }), /unique/);
  assert.throws(() => act(lobby(5, ['morgana', 'mordred']), { type: 'start' }), /Too many/);
  const all = started(10, ['percival', 'morgana', 'mordred', 'oberon']);
  for (const role of ['merlin', 'assassin', 'percival', 'morgana', 'mordred', 'oberon']) {
    assert.equal(Object.values(all.roles).filter((assigned) => assigned === role).length, 1);
  }
});

test('host can edit lobby seating, and inputs and old states stay immutable', () => {
  const state = lobby();
  const original = structuredClone(state);
  const ids = state.players.map((seat) => seat.id).reverse();
  const next = act(state, { type: 'reorder', playerIds: ids });
  assert.deepEqual(state, original);
  assert.deepEqual(next.players.map((seat) => seat.id), ids);
  assert.equal(next.phaseId, state.phaseId);
  assert.equal(next.revision, state.revision + 1);
  assert.throws(() => act(state, { type: 'reorder', playerIds: ['p1', 'p1', 'p3', 'p4', 'p5'] }), /exactly once/);
  assert.throws(() => act(state, { type: 'reorder', playerIds: ['p1', 'p2', 'p3', 'p4', 'unknown'] }), /Unknown/);
  assert.equal(act(state, { type: 'remove-player', playerId: 'p1' }).players.length, 4);
  assert.throws(() => act(started(), { type: 'remove-player', playerId: 'p1' }), /phase/);
});

test('private role knowledge follows classic Merlin, Percival, Mordred and Oberon rules', () => {
  const state = started(10, ['percival', 'morgana', 'mordred', 'oberon']);
  const assignments: Role[] = ['merlin', 'percival', 'servant', 'servant', 'servant', 'servant', 'assassin', 'morgana', 'mordred', 'oberon'];
  state.roles = Object.fromEntries(state.players.map((seat, i) => [seat.id, assignments[i]]));
  assert.deepEqual(privateView(state, 'p1').knownEvilIds, ['p7', 'p8', 'p10']);
  assert.deepEqual(privateView(state, 'p2').merlinCandidateIds, ['p1', 'p8']);
  assert.deepEqual(privateView(state, 'p7').knownEvilIds, ['p8', 'p9']);
  assert.deepEqual(privateView(state, 'p9').knownEvilIds, ['p7', 'p8']);
  assert.deepEqual(privateView(state, 'p10').knownEvilIds, []);
  assert.deepEqual(privateView(state, 'p3').knownEvilIds, []);
  assert.equal(privateView(state, 'p10').faction, 'evil');
  assert.throws(() => privateView(state, 'intruder'), /seat/);
  assert.equal(privateView(lobby(), 'p1').role, null);
});

test('every player must acknowledge their role before the leader can propose', () => {
  let state = started();
  const firstPhaseId = state.phaseId;
  const leader = state.players[state.leaderIndex].id;
  assert.throws(() => act(state, { type: 'propose', team: ['p1', 'p2'] }, player(leader)), /phase/);
  state = act(state, { type: 'ready' }, player('p1'));
  assert.equal(state.phase, 'roles');
  assert.equal(state.phaseId, firstPhaseId);
  assert.throws(() => act(state, { type: 'ready' }, player('p1')), /already/);
  assert.throws(() => act(state, { type: 'ready' }, player('unknown')), /seat/);
  for (const seat of state.players.slice(1)) state = act(state, { type: 'ready' }, player(seat.id));
  assert.equal(state.phase, 'proposal');
  assert.notEqual(state.phaseId, firstPhaseId);
  assert.throws(() => act(state, { type: 'propose', team: ['p1', 'p2'] }, player(state.players.find((seat) => seat.id !== leader)!.id)), /leader/);
  assert.throws(() => act(state, { type: 'propose', team: ['p1', 'p1'] }, player(leader)), /different/);
});

test('votes remain private until everyone submits; ties reject and leadership rotates', () => {
  let state = proposal(ready(started(6)));
  const phaseId = state.phaseId;
  const leaderIndex = state.leaderIndex;
  for (let i = 0; i < 5; i++) state = act(state, { type: 'vote', approve: i < 3 }, player(state.players[i].id));
  const publicData = publicView(state);
  assert.equal(publicData.voteHistory.length, 0);
  assert.deepEqual(publicData.submittedIds, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal('votes' in publicData, false);
  assert.equal(privateView(state, 'p1').ownVote, true);
  assert.equal(privateView(state, 'p6').ownVote, undefined);
  assert.equal(state.phaseId, phaseId);
  assert.throws(() => act(state, { type: 'vote', approve: false }, player('p1')), /already/);
  state = act(state, { type: 'vote', approve: false }, player('p6'));
  assert.equal(state.phase, 'vote-result');
  assert.equal(state.voteHistory[0].approved, false);
  assert.equal(Object.keys(publicView(state).voteHistory[0].votes).length, 6);
  assert.equal(state.rejectionCount, 1);
  assert.throws(() => act(state, { type: 'continue' }, player('p1')), /host/);
  state = act(state, { type: 'continue' });
  assert.equal(state.phase, 'proposal');
  assert.equal(state.leaderIndex, (leaderIndex + 1) % 6);
  assert.deepEqual(state.team, []);
});

test('five consecutive rejections immediately award Evil the game', () => {
  let state = ready(started());
  for (let attempt = 1; attempt <= 5; attempt++) {
    state = vote(proposal(state), false);
    assert.equal(state.rejectionCount, attempt);
    assert.equal(state.voteHistory.at(-1)!.attempt, attempt);
    if (attempt < 5) state = act(state, { type: 'continue' });
  }
  assert.equal(state.phase, 'game-over');
  assert.deepEqual(state.result, { winner: 'evil', reason: 'five-rejections' });
  assert.deepEqual(publicView(state).revealedRoles, state.roles);
});

test('approval resets the rejection tracker and quest cards cannot expose their authors', () => {
  let state = fixedRoles(5);
  state = act(vote(proposal(state), false), { type: 'continue' });
  state = vote(proposal(state, ['p1', 'p4']));
  assert.equal(state.rejectionCount, 0);
  assert.equal(state.voteHistory.at(-1)!.attempt, 2);
  state = act(state, { type: 'continue' });
  assert.throws(() => act(state, { type: 'quest-card', card: 'fail' }, player('p4')), /Good/);
  assert.throws(() => act(state, { type: 'quest-card', card: 'success' }, player('p3')), /quest team/);
  state = act(state, { type: 'quest-card', card: 'fail' }, player('p1'));
  assert.equal(publicView(state).questHistory.length, 0);
  assert.equal('questCards' in publicView(state), false);
  assert.equal(privateView(state, 'p4').ownQuestCard, undefined);
  assert.throws(() => act(state, { type: 'quest-card', card: 'success' }, player('p1')), /already/);
  state = act(state, { type: 'quest-card', card: 'success' }, player('p4'));
  assert.equal(state.phase, 'quest-result');
  assert.deepEqual(state.questHistory[0], { questNumber: 1, team: ['p1', 'p4'], successes: 1, fails: 1, requiredFails: 1, passed: false });
  assert.equal('questCards' in publicView(state), false);
  assert.equal('roles' in publicView(state), false);
});

test('quest four needs two fails for seven players, but only one for six', () => {
  let beforeFourth = fixedRoles(7);
  beforeFourth = act(playQuest(beforeFourth), { type: 'continue' });
  beforeFourth = act(playQuest(beforeFourth, ['p1']), { type: 'continue' });
  beforeFourth = act(playQuest(beforeFourth), { type: 'continue' });
  assert.equal(beforeFourth.questNumber, 4);
  assert.equal(publicView(beforeFourth).requiredFails, 2);
  const oneFail = playQuest(beforeFourth, ['p1']);
  assert.equal(oneFail.questHistory.at(-1)!.passed, true);
  assert.equal(oneFail.questHistory.at(-1)!.requiredFails, 2);
  assert.equal(act(oneFail, { type: 'continue' }).phase, 'assassination');
  const twoFails = playQuest(beforeFourth, ['p1', 'p2']);
  assert.equal(twoFails.questHistory.at(-1)!.passed, false);
  assert.equal(act(twoFails, { type: 'continue' }).questNumber, 5);
  let six = fixedRoles(6);
  six = act(playQuest(six), { type: 'continue' });
  six = act(playQuest(six, ['p1']), { type: 'continue' });
  six = act(playQuest(six), { type: 'continue' });
  assert.equal(playQuest(six, ['p1']).questHistory.at(-1)!.passed, false);
});

test('three failed quests immediately award Evil the game', () => {
  let state = fixedRoles(5);
  for (let quest = 1; quest <= 3; quest++) {
    state = playQuest(state, ['p1']);
    if (quest < 3) state = act(state, { type: 'continue' });
  }
  assert.equal(state.phase, 'game-over');
  assert.deepEqual(state.result, { winner: 'evil', reason: 'three-fails' });
});

test('three successes wait for the host then permit only Assassin to make the final guess', () => {
  let state = fixedRoles(5);
  for (let quest = 1; quest <= 3; quest++) {
    state = playQuest(state);
    assert.equal(state.phase, 'quest-result');
    state = act(state, { type: 'continue' });
  }
  assert.equal(state.phase, 'assassination');
  assert.equal(publicView(state).revealedRoles, undefined);
  assert.throws(() => act(state, { type: 'assassinate', targetId: 'p4' }, player('p2')), /Assassin/);
  assert.throws(() => act(state, { type: 'assassinate', targetId: 'p1' }, player('p1')), /another player/);
  const evilWins = act(state, { type: 'assassinate', targetId: 'p4' }, player('p1'));
  assert.deepEqual(evilWins.result, { winner: 'evil', reason: 'merlin-found', targetId: 'p4' });
  const goodWins = act(state, { type: 'assassinate', targetId: 'p5' }, player('p1'));
  assert.deepEqual(goodWins.result, { winner: 'good', reason: 'merlin-survived', targetId: 'p5' });
  assert.throws(() => act(goodWins, { type: 'assassinate', targetId: 'p4' }, player('p1')), /phase/);
});

test('rematches preserve seats and configuration but clear all prior secrets and submissions', () => {
  let state = ready(started(5, ['percival', 'morgana']));
  state = vote(proposal(state), false);
  const abandoned = act(state, { type: 'abandon' });
  assert.equal(abandoned.phase, 'lobby');
  assert.notEqual(abandoned.gameId, state.gameId);
  assert.notEqual(abandoned.phaseId, state.phaseId);
  assert.deepEqual(abandoned.players, state.players);
  assert.deepEqual(abandoned.optionalRoles, state.optionalRoles);
  assert.deepEqual(abandoned.roles, {});
  assert.deepEqual(abandoned.votes, {});
  assert.deepEqual(abandoned.voteHistory, []);
  assert.equal(privateView(abandoned, 'p1').role, null);
  assert.throws(() => act(state, { type: 'rematch' }), /phase/);
  for (let attempt = 2; attempt <= 5; attempt++) {
    state = vote(proposal(act(state, { type: 'continue' })), false);
  }
  assert.equal(act(state, { type: 'rematch' }).phase, 'lobby');
});

test('public and private projections cannot mutate secrets or subsequent state', () => {
  let state = proposal(fixedRoles(5));
  state = act(state, { type: 'vote', approve: true }, player('p1'));
  const before = structuredClone(state);
  const view = publicView(state, new Set(['p1']));
  assert.equal(view.players[0].connected, true);
  assert.equal(view.players[1].connected, false);
  assert.equal(JSON.stringify(view).includes('assassin'), false);
  view.players[0].name = 'changed';
  view.team.push('changed');
  view.readyIds.push('changed');
  assert.deepEqual(state, before);
  const mine = privateView(state, 'p1');
  assert.equal('roles' in mine, false);
  assert.equal('votes' in mine, false);
  mine.knownEvilIds.push('changed');
  assert.deepEqual(state, before);
  assert.throws(() => act(state, { type: 'nonsense' } as unknown as GameAction), /Unknown/);
});
