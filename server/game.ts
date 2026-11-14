import { randomInt, randomUUID } from 'node:crypto';
import type {
  Actor, Faction, GameAction, GameState, OptionalRole, Phase, PlayerPrivateView,
  PublicGameView, Role,
} from '../shared/protocol.ts';

const OPTIONAL_ROLES: OptionalRole[] = ['percival', 'morgana', 'mordred', 'oberon'];
const EVIL_ROLES = new Set<Role>(['assassin', 'minion', 'morgana', 'mordred', 'oberon']);
const GOOD_COUNTS: Record<number, number> = { 5: 3, 6: 4, 7: 4, 8: 5, 9: 6, 10: 6 };
const QUEST_SIZES: Record<number, number[]> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hostOnly(actor: Actor) {
  requireThat(actor.kind === 'host', 'Only the host can do that.');
}

function inPhase(state: GameState, ...phases: Phase[]) {
  requireThat(phases.includes(state.phase), 'That action is not available in this phase.');
}

function playerId(state: GameState, actor: Actor): string {
  requireThat(actor.kind === 'player', 'Only a player can do that.');
  requireThat(state.players.some((player) => player.id === actor.playerId), 'This player seat no longer exists.');
  return actor.playerId;
}

function changePhase(state: GameState, phase: Phase) {
  state.phase = phase;
  state.phaseId = randomUUID();
}

function nextLeader(state: GameState) {
  state.leaderIndex = (state.leaderIndex + 1) % state.players.length;
}

function requiredFails(state: GameState) {
  return state.questNumber === 4 && state.players.length >= 7 ? 2 : 1;
}

function shuffled<T>(input: T[]): T[] {
  const output = [...input];
  for (let i = output.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

function finish(state: GameState, result: NonNullable<GameState['result']>) {
  state.result = result;
  changePhase(state, 'game-over');
}

function reset(state: GameState): GameState {
  const fresh = createGame(state.roomCode);
  fresh.players = structuredClone(state.players);
  fresh.optionalRoles = [...state.optionalRoles];
  fresh.revision = state.revision;
  return fresh;
}

export function faction(role: Role): Faction {
  return EVIL_ROLES.has(role) ? 'evil' : 'good';
}

export function teamSizes(playerCount: number): number[] {
  return [...(QUEST_SIZES[playerCount] ?? [])];
}

export function createGame(roomCode?: string): GameState {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = roomCode ?? Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return {
    schemaVersion: 1,
    roomCode: code,
    gameId: randomUUID(),
    revision: 0,
    phase: 'lobby',
    phaseId: randomUUID(),
    players: [],
    optionalRoles: [],
    roles: {},
    readyIds: [],
    leaderIndex: 0,
    questNumber: 1,
    rejectionCount: 0,
    team: [],
    votes: {},
    questCards: {},
    voteHistory: [],
    questHistory: [],
    result: null,
  };
}

/** All authorization and rule checks are repeated here, independent of the transport. */
export function applyAction(previous: GameState, actor: Actor, action: GameAction): GameState {
  let state = structuredClone(previous);
  switch (action.type) {
    case 'join': {
      requireThat(actor.kind === 'system', 'Players must join through the join screen.');
      inPhase(state, 'lobby');
      requireThat(state.players.length < 10, 'The table is full (10 players maximum).');
      requireThat(typeof action.player?.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(action.player.id)
        && !['__proto__', 'constructor', 'prototype'].includes(action.player.id), 'Invalid player identity.');
      requireThat(!state.players.some((player) => player.id === action.player.id), 'That player is already seated.');
      requireThat(typeof action.player.name === 'string', 'Enter a player name.');
      const name = action.player.name.trim();
      requireThat(name.length >= 1 && name.length <= 24 && !/[\u0000-\u001f\u007f]/.test(name), 'Use a name between 1 and 24 characters.');
      requireThat(!state.players.some((player) => player.name.toLowerCase() === name.toLowerCase()), 'That name is already in use.');
      state.players.push({ id: action.player.id, name });
      break;
    }
    case 'remove-player': {
      hostOnly(actor);
      inPhase(state, 'lobby');
      requireThat(state.players.some((player) => player.id === action.playerId), 'That player does not exist.');
      state.players = state.players.filter((player) => player.id !== action.playerId);
      break;
    }
    case 'reorder': {
      hostOnly(actor);
      inPhase(state, 'lobby');
      requireThat(Array.isArray(action.playerIds) && action.playerIds.length === state.players.length
        && new Set(action.playerIds).size === state.players.length, 'Include every player exactly once.');
      const reordered = action.playerIds.map((id) => state.players.find((player) => player.id === id));
      requireThat(reordered.every((player) => player !== undefined), 'Unknown player in seating order.');
      state.players = reordered;
      break;
    }
    case 'configure': {
      hostOnly(actor);
      inPhase(state, 'lobby');
      requireThat(Array.isArray(action.optionalRoles)
        && action.optionalRoles.every((role) => OPTIONAL_ROLES.includes(role))
        && new Set(action.optionalRoles).size === action.optionalRoles.length, 'Choose unique supported roles.');
      state.optionalRoles = [...action.optionalRoles];
      break;
    }
    case 'start': {
      hostOnly(actor);
      inPhase(state, 'lobby');
      const count = state.players.length;
      requireThat(count >= 5 && count <= 10, 'Avalon needs 5–10 players.');
      const selected: Role[] = ['merlin', 'assassin', ...state.optionalRoles];
      const goodCount = GOOD_COUNTS[count];
      const evilCount = count - goodCount;
      const selectedGood = selected.filter((role) => faction(role) === 'good').length;
      const selectedEvil = selected.length - selectedGood;
      requireThat(selectedGood <= goodCount && selectedEvil <= evilCount, 'Too many special roles for this player count.');
      selected.push(...Array<Role>(goodCount - selectedGood).fill('servant'));
      selected.push(...Array<Role>(evilCount - selectedEvil).fill('minion'));
      const dealt = shuffled(selected);
      state.roles = Object.fromEntries(state.players.map((player, i) => [player.id, dealt[i]]));
      state.leaderIndex = randomInt(count);
      changePhase(state, 'roles');
      break;
    }
    case 'ready': {
      const id = playerId(state, actor);
      inPhase(state, 'roles');
      requireThat(!state.readyIds.includes(id), 'You have already confirmed your role.');
      state.readyIds.push(id);
      if (state.readyIds.length === state.players.length) changePhase(state, 'proposal');
      break;
    }
    case 'propose': {
      const id = playerId(state, actor);
      inPhase(state, 'proposal');
      requireThat(state.players[state.leaderIndex].id === id, 'Only the current leader can propose a team.');
      const needed = QUEST_SIZES[state.players.length][state.questNumber - 1];
      requireThat(Array.isArray(action.team) && action.team.length === needed
        && new Set(action.team).size === needed, `Select exactly ${needed} different players.`);
      requireThat(action.team.every((memberId) => state.players.some((player) => player.id === memberId)), 'Unknown player in proposed team.');
      // Keep public team order in seating order rather than leaking selection order.
      state.team = state.players.filter((player) => action.team.includes(player.id)).map((player) => player.id);
      state.votes = {};
      state.questCards = {};
      changePhase(state, 'voting');
      break;
    }
    case 'vote': {
      const id = playerId(state, actor);
      inPhase(state, 'voting');
      requireThat(typeof action.approve === 'boolean', 'Choose Approve or Reject.');
      requireThat(!Object.hasOwn(state.votes, id), 'Your vote has already been submitted.');
      state.votes[id] = action.approve;
      if (Object.keys(state.votes).length === state.players.length) {
        const approved = Object.values(state.votes).filter(Boolean).length > state.players.length / 2;
        state.voteHistory.push({
          questNumber: state.questNumber,
          attempt: state.rejectionCount + 1,
          leaderId: state.players[state.leaderIndex].id,
          team: [...state.team],
          votes: { ...state.votes },
          approved,
        });
        state.rejectionCount = approved ? 0 : state.rejectionCount + 1;
        if (state.rejectionCount === 5) finish(state, { winner: 'evil', reason: 'five-rejections' });
        else changePhase(state, 'vote-result');
      }
      break;
    }
    case 'quest-card': {
      const id = playerId(state, actor);
      inPhase(state, 'quest');
      requireThat(state.team.includes(id), 'Only the quest team can submit a card.');
      requireThat(action.card === 'success' || action.card === 'fail', 'Choose a valid quest card.');
      requireThat(!Object.hasOwn(state.questCards, id), 'Your quest card has already been submitted.');
      requireThat(action.card !== 'fail' || faction(state.roles[id]) === 'evil', 'Good players must submit Success.');
      state.questCards[id] = action.card;
      if (Object.keys(state.questCards).length === state.team.length) {
        const fails = Object.values(state.questCards).filter((card) => card === 'fail').length;
        const threshold = requiredFails(state);
        state.questHistory.push({
          questNumber: state.questNumber,
          team: [...state.team],
          successes: state.team.length - fails,
          fails,
          requiredFails: threshold,
          passed: fails < threshold,
        });
        if (state.questHistory.filter((quest) => !quest.passed).length === 3) {
          finish(state, { winner: 'evil', reason: 'three-fails' });
        } else changePhase(state, 'quest-result');
      }
      break;
    }
    case 'continue': {
      hostOnly(actor);
      inPhase(state, 'vote-result', 'quest-result');
      if (state.phase === 'vote-result') {
        const vote = state.voteHistory.at(-1)!;
        if (vote.approved) {
          state.questCards = {};
          changePhase(state, 'quest');
        } else {
          nextLeader(state);
          state.team = [];
          state.votes = {};
          changePhase(state, 'proposal');
        }
      } else {
        nextLeader(state);
        if (state.questHistory.filter((quest) => quest.passed).length === 3) {
          changePhase(state, 'assassination');
        } else {
          state.questNumber += 1;
          state.team = [];
          state.votes = {};
          state.questCards = {};
          changePhase(state, 'proposal');
        }
      }
      break;
    }
    case 'assassinate': {
      const id = playerId(state, actor);
      inPhase(state, 'assassination');
      requireThat(state.roles[id] === 'assassin', 'Only the Assassin can choose a target.');
      requireThat(state.players.some((player) => player.id === action.targetId) && action.targetId !== id, 'Choose another player as the target.');
      const found = state.roles[action.targetId] === 'merlin';
      finish(state, { winner: found ? 'evil' : 'good', reason: found ? 'merlin-found' : 'merlin-survived', targetId: action.targetId });
      break;
    }
    case 'rematch': {
      hostOnly(actor);
      inPhase(state, 'game-over');
      state = reset(state);
      break;
    }
    case 'abandon': {
      hostOnly(actor);
      requireThat(state.phase !== 'lobby', 'The table is already in the lobby.');
      state = reset(state);
      break;
    }
    default: {
      throw new Error('Unknown game action.');
    }
  }
  state.revision = previous.revision + 1;
  return state;
}

/** Explicit whitelist, with no references into the authoritative state. */
export function publicView(state: GameState, connectedIds = new Set<string>()): PublicGameView {
  const view: PublicGameView = {
    roomCode: state.roomCode,
    gameId: state.gameId,
    revision: state.revision,
    phase: state.phase,
    phaseId: state.phaseId,
    players: state.players.map((player) => ({ ...player, connected: connectedIds.has(player.id) })),
    optionalRoles: [...state.optionalRoles],
    leaderId: state.phase === 'lobby' ? null : (state.players[state.leaderIndex]?.id ?? null),
    questNumber: state.questNumber,
    questSizes: teamSizes(state.players.length),
    requiredFails: requiredFails(state),
    rejectionCount: state.rejectionCount,
    team: [...state.team],
    readyIds: [...state.readyIds],
    submittedIds: state.phase === 'voting' ? Object.keys(state.votes)
      : state.phase === 'quest' ? Object.keys(state.questCards) : [],
    voteHistory: structuredClone(state.voteHistory),
    questHistory: structuredClone(state.questHistory),
    result: structuredClone(state.result),
  };
  if (state.phase === 'game-over') view.revealedRoles = { ...state.roles };
  return view;
}

export function privateView(state: GameState, id: string): PlayerPrivateView {
  requireThat(state.players.some((player) => player.id === id), 'This player seat no longer exists.');
  const role = state.roles[id] ?? null;
  const view: PlayerPrivateView = {
    playerId: id,
    role,
    faction: role ? faction(role) : null,
    knownEvilIds: [],
    merlinCandidateIds: [],
    ready: state.readyIds.includes(id),
  };
  if (role === 'merlin') {
    view.knownEvilIds = state.players.filter((player) => faction(state.roles[player.id]) === 'evil'
      && state.roles[player.id] !== 'mordred').map((player) => player.id);
  } else if (role && faction(role) === 'evil' && role !== 'oberon') {
    view.knownEvilIds = state.players.filter((player) => player.id !== id
      && faction(state.roles[player.id]) === 'evil' && state.roles[player.id] !== 'oberon').map((player) => player.id);
  }
  if (role === 'percival') {
    view.merlinCandidateIds = state.players.filter((player) => ['merlin', 'morgana'].includes(state.roles[player.id])).map((player) => player.id);
  }
  if (Object.hasOwn(state.votes, id)) view.ownVote = state.votes[id];
  if (Object.hasOwn(state.questCards, id)) view.ownQuestCard = state.questCards[id];
  return view;
}
