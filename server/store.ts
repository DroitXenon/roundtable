import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { GameState } from '../shared/protocol.js';
import { createGame, faction, teamSizes } from './game.js';

const role = z.enum(['merlin', 'assassin', 'servant', 'minion', 'percival', 'morgana', 'mordred', 'oberon']);
const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value);
const gameSchema = z.object({
  schemaVersion: z.literal(1), roomCode: z.string(), gameId: z.string(), revision: z.number().int().nonnegative(),
  phase: z.enum(['lobby', 'roles', 'proposal', 'voting', 'vote-result', 'quest', 'quest-result', 'assassination', 'game-over']),
  phaseId: z.string(), players: z.array(z.object({ id: z.string(), name: z.string() })).max(10),
  optionalRoles: z.array(z.enum(['percival', 'morgana', 'mordred', 'oberon'])), roles: record(role), readyIds: z.array(z.string()),
  leaderIndex: z.number().int(), questNumber: z.number().int(), rejectionCount: z.number().int(), team: z.array(z.string()),
  votes: record(z.boolean()), questCards: record(z.enum(['success', 'fail'])),
  voteHistory: z.array(z.object({ questNumber: z.number(), attempt: z.number(), leaderId: z.string(), team: z.array(z.string()), votes: record(z.boolean()), approved: z.boolean() })),
  questHistory: z.array(z.object({ questNumber: z.number(), team: z.array(z.string()), successes: z.number(), fails: z.number(), requiredFails: z.number(), passed: z.boolean() })),
  result: z.object({ winner: z.enum(['good', 'evil']), reason: z.enum(['three-fails', 'five-rejections', 'merlin-found', 'merlin-survived']), targetId: z.string().optional() }).nullable(),
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  game: gameSchema,
  hostToken: z.string().min(32),
  sessions: record(z.object({ playerId: z.string() })),
  joinReceipts: record(z.object({ name: z.string(), roomCode: z.string(), playerId: z.string(), token: z.string() })),
  commandReceipts: record(z.object({ fingerprint: z.string() })),
});

export interface PersistedData {
  schemaVersion: 1;
  game: GameState;
  hostToken: string;
  sessions: Record<string, { playerId: string }>;
  joinReceipts: Record<string, { name: string; roomCode: string; playerId: string; token: string }>;
  commandReceipts: Record<string, { fingerprint: string }>;
}

export function credential(): string { return randomBytes(32).toString('base64url'); }

/** Validate references as well as JSON shape before a saved game reaches projections. */
function validateReferences(data: PersistedData) {
  const game = data.game;
  const ids = new Set(game.players.map(player => player.id));
  const count = game.players.length;
  const validCredential = (token: string) => /^[a-zA-Z0-9_-]{43}$/.test(token);
  const validList = (values: string[], allowed = ids) => new Set(values).size === values.length && values.every(value => allowed.has(value));
  const validKeys = (value: object, allowed = ids) => Object.keys(value).every(key => allowed.has(key));
  const insist = (condition: unknown) => { if (!condition) throw new Error('Invalid references in saved game.'); };
  insist(ids.size === count && new Set(game.players.map(player => player.name.toLowerCase())).size === count);
  insist(game.players.every(player => /^[a-zA-Z0-9_-]{1,80}$/.test(player.id) && !['__proto__', 'constructor', 'prototype'].includes(player.id) && player.name.trim().length > 0 && player.name.length <= 24));
  insist(game.roomCode.length >= 1 && game.roomCode.length <= 16 && game.phaseId.length > 0 && game.gameId.length > 0);
  insist(game.questNumber >= 1 && game.questNumber <= 5 && game.rejectionCount >= 0 && game.rejectionCount <= 5);
  insist(game.leaderIndex >= 0 && game.leaderIndex < Math.max(count, 1));
  insist(new Set(game.optionalRoles).size === game.optionalRoles.length);
  insist(validList(game.readyIds) && validList(game.team) && validKeys(game.roles) && validKeys(game.votes) && validKeys(game.questCards, new Set(game.team)));
  const sessionIds = Object.values(data.sessions).map(session => session.playerId);
  insist(sessionIds.length === count && validList(sessionIds));
  insist(validCredential(data.hostToken) && Object.keys(data.sessions).every(validCredential));
  insist(Object.entries(data.joinReceipts).every(([key, receipt]) => /^[a-zA-Z0-9_-]{8,128}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && validCredential(receipt.token) && receipt.roomCode === game.roomCode && (!Object.hasOwn(data.sessions, receipt.token) || data.sessions[receipt.token].playerId === receipt.playerId)));

  if (game.phase === 'lobby') {
    insist(Object.keys(game.roles).length === 0 && game.readyIds.length === 0 && game.team.length === 0 && Object.keys(game.votes).length === 0 && Object.keys(game.questCards).length === 0);
    insist(game.questHistory.length === 0 && game.voteHistory.length === 0 && game.result === null && game.questNumber === 1 && game.rejectionCount === 0 && game.leaderIndex === 0);
    return;
  }

  insist(count >= 5 && count <= 10 && Object.keys(game.roles).length === count);
  const assigned = Object.values(game.roles);
  const goodCounts: Record<number, number> = { 5: 3, 6: 4, 7: 4, 8: 5, 9: 6, 10: 6 };
  insist(assigned.filter(role => faction(role) === 'good').length === goodCounts[count]);
  insist(assigned.filter(role => role === 'merlin').length === 1 && assigned.filter(role => role === 'assassin').length === 1);
  for (const role of ['percival', 'morgana', 'mordred', 'oberon'] as const) insist(assigned.filter(value => value === role).length === (game.optionalRoles.includes(role) ? 1 : 0));
  insist(game.phase === 'roles' ? game.readyIds.length < count : game.readyIds.length === count);
  const sizes = teamSizes(count);
  const threshold = (questNumber: number) => questNumber === 4 && count >= 7 ? 2 : 1;
  const fullTeam = (team: string[], questNumber: number) => validList(team) && team.length === sizes[questNumber - 1];
  insist(game.team.length === 0 || fullTeam(game.team, game.questNumber));
  insist(['roles', 'proposal'].includes(game.phase) ? game.team.length === 0 : fullTeam(game.team, game.questNumber));
  insist(Object.entries(game.questCards).every(([playerId, card]) => card !== 'fail' || faction(game.roles[playerId]) === 'evil'));
  insist(game.voteHistory.length <= 25 && game.questHistory.length <= 5);
  insist(game.voteHistory.every(vote => Number.isInteger(vote.questNumber) && vote.questNumber >= 1 && vote.questNumber <= game.questNumber && Number.isInteger(vote.attempt) && vote.attempt >= 1 && vote.attempt <= 5 && ids.has(vote.leaderId) && fullTeam(vote.team, vote.questNumber) && validKeys(vote.votes) && Object.keys(vote.votes).length === count && vote.approved === (Object.values(vote.votes).filter(Boolean).length > count / 2)));
  insist(game.questHistory.every((quest, index) => quest.questNumber === index + 1 && fullTeam(quest.team, quest.questNumber) && Number.isInteger(quest.successes) && quest.successes >= 0 && Number.isInteger(quest.fails) && quest.fails >= 0 && quest.successes + quest.fails === quest.team.length && quest.requiredFails === threshold(quest.questNumber) && quest.passed === (quest.fails < quest.requiredFails)));
  insist(game.questHistory.length <= game.questNumber);
  if (game.phase === 'roles') insist(game.questNumber === 1 && game.rejectionCount === 0 && game.voteHistory.length === 0 && game.questHistory.length === 0 && Object.keys(game.votes).length === 0 && Object.keys(game.questCards).length === 0);
  if (game.phase === 'proposal') insist(Object.keys(game.votes).length === 0 && Object.keys(game.questCards).length === 0);
  if (game.phase === 'voting') insist(Object.keys(game.votes).length < count && Object.keys(game.questCards).length === 0);
  if (['vote-result', 'quest', 'quest-result', 'assassination', 'game-over'].includes(game.phase)) {
    const latestVote = game.voteHistory.at(-1);
    insist(latestVote && latestVote.questNumber === game.questNumber && Object.keys(game.votes).length === count && game.players.every(player => game.votes[player.id] === latestVote.votes[player.id]));
    if (game.phase === 'vote-result') insist(Object.keys(game.questCards).length === 0);
    if (['quest', 'quest-result', 'assassination'].includes(game.phase) || (game.result && game.result.reason !== 'five-rejections')) insist(latestVote!.approved);
  }
  if (game.phase === 'quest') insist(Object.keys(game.questCards).length < game.team.length);
  const questFinished = ['quest-result', 'assassination'].includes(game.phase) || (game.result !== null && game.result.reason !== 'five-rejections');
  if (questFinished) insist(Object.keys(game.questCards).length === game.team.length && game.questHistory.length === game.questNumber);
  else if (game.phase !== 'roles') insist(game.questHistory.length === game.questNumber - 1);
  insist((game.phase === 'game-over') === (game.result !== null));
  if (game.result) {
    const { reason, winner, targetId } = game.result;
    if (reason === 'five-rejections') insist(winner === 'evil' && game.rejectionCount === 5 && targetId === undefined);
    else if (reason === 'three-fails') insist(winner === 'evil' && game.questHistory.filter(quest => !quest.passed).length === 3 && targetId === undefined);
    else {
      insist(game.questHistory.filter(quest => quest.passed).length === 3 && targetId !== undefined && ids.has(targetId));
      insist(reason === 'merlin-found' ? winner === 'evil' && game.roles[targetId!] === 'merlin' : winner === 'good' && game.roles[targetId!] !== 'merlin');
    }
  }
}

/** A single-process store. A mutation is visible only after its snapshot is saved. */
export async function openStore(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'server.lock');
  const snapshotPath = join(directory, 'game.json');
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { pid = Number(await readFile(lockPath, 'utf8')); } catch { throw new Error('Cannot read the game lock. Check the .roundtable folder permissions.'); }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The game lock is invalid. With Roundtable stopped, remove .roundtable/server.lock and try again.');
      try {
        process.kill(pid, 0);
        throw new Error('Roundtable is already running for this folder. Use its existing host window.');
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        await unlink(lockPath);
      }
    }
  }
  if (!lock) throw new Error('Could not acquire the game lock.');

  async function write(data: PersistedData) {
    validateReferences(data);
    const temporaryPath = join(directory, `game.${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporaryPath, 'wx', 0o600);
      await file.writeFile(JSON.stringify(data));
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, snapshotPath);
    } finally {
      await file?.close();
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function release() {
    await lock?.close();
    lock = undefined;
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  try {
    let data: PersistedData;
    try {
      const contents = await readFile(snapshotPath, 'utf8');
      const parsed = snapshotSchema.safeParse(JSON.parse(contents));
      if (!parsed.success) throw new Error('Unsupported or damaged saved game.');
      data = parsed.data;
      validateReferences(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot restore the saved game at ${snapshotPath}. Keep the file for recovery; it has not been overwritten.`, { cause: error });
      }
      data = { schemaVersion: 1, game: createGame(), hostToken: credential(), sessions: {}, joinReceipts: {}, commandReceipts: {} };
      await write(data);
    }
    return { data, write, release };
  } catch (error) {
    await release();
    throw error;
  }
}
