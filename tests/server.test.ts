import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { ClientAction, ClientToServerEvents, CommandAck, CommandEnvelope, JoinResponse, ServerSnapshot, ServerToClientEvents } from '../shared/protocol.js';
import { createRuntime } from '../server/runtime.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
interface Client { socket: ClientSocket; snapshot: ServerSnapshot }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'roundtable-server-'));
  let runtime = await createRuntime({ dataDir: directory, serveUi: false });
  let address = await runtime.listen(0, '127.0.0.1');
  const clients: Client[] = [];
  t.after(async () => { clients.forEach(client => client.socket.disconnect()); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const result = {
    directory,
    get runtime() { return runtime; },
    get url() { return `http://127.0.0.1:${address.port}`; },
    async connect(auth: { hostToken?: string; playerToken?: string } = {}): Promise<Client> {
      const socket: ClientSocket = io(result.url, { auth, forceNew: true, reconnection: false, timeout: 1500 });
      let current: ServerSnapshot;
      socket.on('snapshot', value => { current = value; });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for initial snapshot.')), 2500);
        socket.once('snapshot', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); socket.disconnect(); reject(error); });
      });
      const client: Client = { socket, get snapshot() { return current; } };
      clients.push(client);
      return client;
    },
    async join(name: string, requestId: string = randomUUID(), roomCode = runtime.state.roomCode): Promise<JoinResponse> {
      const response = await fetch(`${result.url}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, roomCode, requestId }) });
      return response.json() as Promise<JoinResponse>;
    },
    async restart() {
      clients.forEach(client => client.socket.disconnect());
      const previousPort = address.port;
      await runtime.close();
      runtime = await createRuntime({ dataDir: directory, serveUi: false });
      address = await runtime.listen(previousPort, '127.0.0.1');
    },
  };
  return result;
}

function envelope(client: Client, action: ClientAction, requestId = randomUUID()): CommandEnvelope {
  return { requestId, phaseId: client.snapshot.game.phaseId, action };
}

async function send(client: Client, command: CommandEnvelope): Promise<CommandAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Command acknowledgement timed out.')), 2500);
    client.socket.emit('command', command, result => { clearTimeout(timer); resolve(result); });
  });
}

async function command(client: Client, action: ClientAction) { return send(client, envelope(client, action)); }

async function waitFor(client: Client, predicate: (snapshot: ServerSnapshot) => boolean): Promise<void> {
  if (predicate(client.snapshot)) return;
  await new Promise<void>((resolve, reject) => {
    const listener = (snapshot: ServerSnapshot) => {
      if (predicate(snapshot)) { clearTimeout(timer); client.socket.off('snapshot', listener); resolve(); }
    };
    const timer = setTimeout(() => { client.socket.off('snapshot', listener); reject(new Error(`Snapshot wait timed out in ${client.snapshot.game.phase}.`)); }, 2500);
    client.socket.on('snapshot', listener);
  });
}

async function gameFixture(t: TestContext, count = 5) {
  const table = await fixture(t);
  const host = await table.connect({ hostToken: table.runtime.hostToken });
  const players: Client[] = [];
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) {
    const joined = await table.join(`Player ${i + 1}`);
    assert.equal(joined.ok, true);
    tokens.push(joined.token!);
    players.push(await table.connect({ playerToken: joined.token }));
  }
  await waitFor(host, value => value.game.players.length === count && value.game.players.every(player => player.connected));
  assert.equal((await command(host, { type: 'start' })).ok, true);
  await Promise.all(players.map(player => waitFor(player, value => value.game.phase === 'roles')));
  const readyResults = await Promise.all(players.map(player => command(player, { type: 'ready' })));
  assert.ok(readyResults.every(result => result.ok));
  await waitFor(host, value => value.game.phase === 'proposal');
  return { table, host, players, tokens };
}

async function propose(game: Awaited<ReturnType<typeof gameFixture>>, memberIds?: string[]) {
  const { host, players } = game;
  const leader = players.find(player => player.snapshot.player?.playerId === host.snapshot.game.leaderId)!;
  await waitFor(leader, value => value.game.phase === 'proposal');
  const team = memberIds ?? host.snapshot.game.players.slice(0, host.snapshot.game.questSizes[host.snapshot.game.questNumber - 1]).map(player => player.id);
  assert.equal((await command(leader, { type: 'propose', team })).ok, true);
  await Promise.all(players.map(player => waitFor(player, value => value.game.phase === 'voting')));
  return team;
}

async function approve(game: Awaited<ReturnType<typeof gameFixture>>) {
  const results = await Promise.all(game.players.map(player => command(player, { type: 'vote', approve: true })));
  assert.ok(results.every(result => result.ok));
  await waitFor(game.host, value => value.game.phase === 'vote-result');
  assert.equal((await command(game.host, { type: 'continue' })).ok, true);
  await Promise.all(game.players.map(player => waitFor(player, value => value.game.phase === 'quest')));
}

test('LAN API and sockets enforce sessions, command validation, origin checks, and safe views', async t => {
  const table = await fixture(t);
  assert.deepEqual(await (await fetch(`${table.url}/api/health`)).json(), { ok: true });
  const forbidden = await fetch(`${table.url}/api/join`, { method: 'POST', headers: { Origin: 'https://another-site.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const malformed = await fetch(`${table.url}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const observer = await table.connect();
  assert.equal(observer.snapshot.isHost, false);
  assert.equal(observer.snapshot.player, undefined);
  assert.equal(observer.snapshot.hostInfo, undefined);
  assert.equal((await command(observer, { type: 'start' })).ok, false);
  for (const reserved of ['__proto__', 'constructor', 'prototype']) assert.equal((await table.join('Reserved request', reserved)).ok, false);
  assert.equal(table.runtime.state.players.length, 0);
  await assert.rejects(table.connect({ playerToken: '__proto__' }), /Invalid player session/);
  await assert.rejects(table.connect({ hostToken: 'invalid' }), /Invalid host credential/);
  const joinId = randomUUID();
  const joined = await table.join('Alice', joinId);
  assert.equal(joined.ok, true);
  assert.deepEqual(await table.join('Alice', joinId), joined);
  assert.equal(table.runtime.state.players.length, 1);
  assert.equal((await table.join('Changed name', joinId)).ok, false);
  assert.equal((await table.join('Bob', randomUUID(), 'WRONG')).ok, false);
  const player = await table.connect({ playerToken: joined.token });
  assert.equal(player.snapshot.player?.role, null);
  assert.equal((await command(player, { type: 'configure', optionalRoles: ['oberon'] })).ok, false);
  const host = await table.connect({ hostToken: table.runtime.hostToken });
  assert.equal(host.snapshot.isHost, true);
  assert.ok(host.snapshot.hostInfo);
  assert.equal(host.snapshot.player, undefined);
  const removed = new Promise<void>(resolve => player.socket.once('sessionRevoked', resolve));
  assert.equal((await command(host, { type: 'remove-player', playerId: joined.playerId! })).ok, true);
  await removed;
  await assert.rejects(table.connect({ playerToken: joined.token }), /Invalid player session/);
  assert.equal((await table.join('Alice', joinId)).ok, false);
  const permissions = await stat(join(table.directory, 'game.json'));
  assert.equal(permissions.mode & 0o777, 0o600);
  assert.equal(JSON.stringify(observer.snapshot).includes(table.runtime.hostToken), false);
});

test('concurrent voting is private, retries are idempotent, and reconnect/restart retain the seat and ballot', async t => {
  const game = await gameFixture(t);
  const { table, host, players } = game;
  await propose(game);
  const firstVote = envelope(players[0], { type: 'vote', approve: false });
  const duplicateResults = await Promise.all([send(players[0], firstVote), send(players[0], firstVote)]);
  assert.deepEqual(duplicateResults, [{ ok: true }, { ok: true }]);
  assert.equal(Object.keys(table.runtime.state.votes).length, 1);
  const observer = await table.connect();
  assert.deepEqual(observer.snapshot.game.voteHistory, []);
  assert.equal('votes' in observer.snapshot.game, false);
  assert.equal('roles' in observer.snapshot.game, false);
  assert.equal('questCards' in observer.snapshot.game, false);
  assert.equal(observer.snapshot.game.revealedRoles, undefined);
  assert.equal(host.snapshot.player, undefined);
  assert.equal(players[1].snapshot.player?.ownVote, undefined);
  const playerId = players[0].snapshot.player!.playerId;
  players[0].socket.disconnect();
  const reconnected = await table.connect({ playerToken: game.tokens[0] });
  assert.equal(reconnected.snapshot.player?.playerId, playerId);
  assert.equal(reconnected.snapshot.player?.ownVote, false);
  assert.equal(reconnected.snapshot.game.players.length, 5);
  const savedHostToken = table.runtime.hostToken;
  await table.restart();
  assert.equal(table.runtime.hostToken, savedHostToken);
  const afterRestart = await table.connect({ playerToken: game.tokens[0] });
  assert.equal(afterRestart.snapshot.player?.playerId, playerId);
  assert.equal(afterRestart.snapshot.player?.ownVote, false);
  assert.deepEqual(await send(afterRestart, firstVote), { ok: true });
  const remaining = await Promise.all(game.tokens.slice(1).map(playerToken => table.connect({ playerToken })));
  const results = await Promise.all(remaining.map(player => command(player, { type: 'vote', approve: true })));
  assert.ok(results.every(result => result.ok));
  await waitFor(afterRestart, value => value.game.phase === 'vote-result');
  assert.equal(afterRestart.snapshot.game.voteHistory.length, 1);
  assert.equal(afterRestart.snapshot.game.voteHistory[0].votes[playerId], false);
  const stale = { ...firstVote, requestId: randomUUID() };
  assert.equal((await send(afterRestart, stale)).ok, false);
  const conflicting = { ...firstVote, action: { type: 'vote' as const, approve: true } };
  assert.equal((await send(afterRestart, conflicting)).ok, false);
});

for (const findMerlin of [true, false]) {
  test(`complete socket journey: three successes and ${findMerlin ? 'correct' : 'incorrect'} assassination`, async t => {
    const game = await gameFixture(t);
    for (let quest = 1; quest <= 3; quest++) {
      const team = await propose(game);
      await approve(game);
      const members = game.players.filter(player => team.includes(player.snapshot.player!.playerId));
      const results = await Promise.all(members.map(player => command(player, { type: 'quest-card', card: 'success' })));
      assert.ok(results.every(result => result.ok));
      await waitFor(game.host, value => value.game.phase === 'quest-result');
      assert.equal((await command(game.host, { type: 'continue' })).ok, true);
      await waitFor(game.host, value => value.game.phase === (quest === 3 ? 'assassination' : 'proposal'));
    }
    const assassin = game.players.find(player => player.snapshot.player!.role === 'assassin')!;
    await waitFor(assassin, value => value.game.phase === 'assassination');
    const target = game.players.find(player => findMerlin ? player.snapshot.player!.role === 'merlin' : player.snapshot.player!.role === 'servant')!;
    const finalCommand = envelope(assassin, { type: 'assassinate', targetId: target.snapshot.player!.playerId });
    assert.equal((await send(assassin, finalCommand)).ok, true);
    await waitFor(game.host, value => value.game.phase === 'game-over');
    assert.equal(game.host.snapshot.game.result?.winner, findMerlin ? 'evil' : 'good');
    assert.equal(Object.keys(game.host.snapshot.game.revealedRoles!).length, 5);
    await game.table.restart();
    const restoredAssassin = await game.table.connect({ playerToken: game.tokens[game.players.indexOf(assassin)] });
    assert.deepEqual(await send(restoredAssassin, finalCommand), { ok: true });
    const host = await game.table.connect({ hostToken: game.table.runtime.hostToken });
    assert.equal((await command(host, { type: 'rematch' })).ok, true);
    await waitFor(host, value => value.game.phase === 'lobby');
    assert.equal(host.snapshot.game.players.length, 5);
    assert.equal(host.snapshot.game.revealedRoles, undefined);
  });
}

test('complete socket journey: three failed quests give Evil victory without identifying card submitters', async t => {
  const game = await gameFixture(t);
  const evil = game.players.find(player => player.snapshot.player!.faction === 'evil')!;
  const evilId = evil.snapshot.player!.playerId;
  for (let quest = 1; quest <= 3; quest++) {
    const count = game.host.snapshot.game.questSizes[quest - 1];
    const team = [evilId, ...game.host.snapshot.game.players.filter(player => player.id !== evilId).slice(0, count - 1).map(player => player.id)];
    await propose(game, team);
    await approve(game);
    const members = game.players.filter(player => team.includes(player.snapshot.player!.playerId));
    for (const player of members) {
      assert.equal((await command(player, { type: 'quest-card', card: player === evil ? 'fail' : 'success' })).ok, true);
    }
    await waitFor(game.host, value => value.game.phase === (quest === 3 ? 'game-over' : 'quest-result'));
    assert.equal(game.host.snapshot.game.questHistory.at(-1)?.fails, 1);
    assert.equal('questCards' in game.host.snapshot.game, false);
    if (quest < 3) { assert.equal((await command(game.host, { type: 'continue' })).ok, true); await waitFor(game.host, value => value.game.phase === 'proposal'); }
  }
  assert.deepEqual(game.host.snapshot.game.result, { winner: 'evil', reason: 'three-fails' });
});

test('complete socket journey: five rejected teams end the game', async t => {
  const game = await gameFixture(t);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await propose(game);
    const results = await Promise.all(game.players.map(player => command(player, { type: 'vote', approve: false })));
    assert.ok(results.every(result => result.ok));
    await waitFor(game.host, value => value.game.phase === (attempt === 5 ? 'game-over' : 'vote-result'));
    assert.equal(game.host.snapshot.game.rejectionCount, attempt);
    if (attempt < 5) { assert.equal((await command(game.host, { type: 'continue' })).ok, true); await waitFor(game.host, value => value.game.phase === 'proposal'); }
  }
  assert.deepEqual(game.host.snapshot.game.result, { winner: 'evil', reason: 'five-rejections' });
});

test('damaged snapshots are preserved and an existing runtime prevents concurrent ownership', async t => {
  const table = await fixture(t);
  await assert.rejects(createRuntime({ dataDir: table.directory, serveUi: false }), /already running/);
  const path = join(table.directory, 'game.json');
  await table.runtime.close();
  await writeFile(path, '{broken');
  await assert.rejects(createRuntime({ dataDir: table.directory, serveUi: false }), /Cannot restore/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('semantically damaged saves are rejected before they can authenticate or broadcast', async t => {
  const game = await gameFixture(t);
  const path = join(game.table.directory, 'game.json');
  const baseline = JSON.parse(await readFile(path, 'utf8'));
  await game.table.runtime.close();
  const damageCases = [
    (value: typeof baseline) => { value.sessions[Object.keys(value.sessions)[0]].playerId = 'missing-seat'; },
    (value: typeof baseline) => { delete value.game.roles[Object.keys(value.game.roles)[0]]; },
    (value: typeof baseline) => { value.game.leaderIndex = 999; },
    (value: typeof baseline) => { value.game.questNumber = 99; },
    (value: typeof baseline) => { value.game.votes['missing-seat'] = true; },
    (value: typeof baseline) => { value.game.questCards['missing-seat'] = 'fail'; },
    (value: typeof baseline) => { value.game.phase = 'quest'; },
    (value: typeof baseline) => { value.game.players[1].id = value.game.players[0].id; },
  ];
  for (const damage of damageCases) {
    const saved = structuredClone(baseline);
    damage(saved);
    const contents = JSON.stringify(saved);
    await writeFile(path, contents);
    await assert.rejects(createRuntime({ dataDir: game.table.directory, serveUi: false }), /Cannot restore/);
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('failed persistence does not acknowledge or publish a mutation and a later retry succeeds', async t => {
  const table = await fixture(t);
  const host = await table.connect({ hostToken: table.runtime.hostToken });
  const path = join(table.directory, 'game.json');
  const backup = join(table.directory, 'last-good.json');
  const mutation = envelope(host, { type: 'configure', optionalRoles: ['percival'] });
  await rename(path, backup);
  await mkdir(path);
  const failed = await send(host, mutation);
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /Unable to save/);
  assert.deepEqual(table.runtime.state.optionalRoles, []);
  assert.deepEqual(host.snapshot.game.optionalRoles, []);
  await rm(path, { recursive: true });
  await rename(backup, path);
  assert.deepEqual(await send(host, mutation), { ok: true });
  assert.deepEqual(table.runtime.state.optionalRoles, ['percival']);
});
