import express from 'express';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Actor, ClientToServerEvents, CommandAck, HostInfo, JoinResponse, ServerSnapshot, ServerToClientEvents } from '../shared/protocol.js';
import { applyAction, privateView, publicView } from './game.js';
import { credential, openStore, type PersistedData } from './store.js';

const requestId = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const id = z.string().min(1).max(128);
const optionalRole = z.enum(['percival', 'morgana', 'mordred', 'oberon']);
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('remove-player'), playerId: id }).strict(),
  z.object({ type: z.literal('reorder'), playerIds: z.array(id).max(10) }).strict(),
  z.object({ type: z.literal('configure'), optionalRoles: z.array(optionalRole).max(4) }).strict(),
  ...(['start', 'ready', 'continue', 'rematch', 'abandon'] as const).map(type => z.object({ type: z.literal(type) }).strict()),
  z.object({ type: z.literal('propose'), team: z.array(id).max(5) }).strict(),
  z.object({ type: z.literal('vote'), approve: z.boolean() }).strict(),
  z.object({ type: z.literal('quest-card'), card: z.enum(['success', 'fail']) }).strict(),
  z.object({ type: z.literal('assassinate'), targetId: id }).strict(),
]);
const commandSchema = z.object({ requestId, phaseId: id, action: actionSchema }).strict();
const joinSchema = z.object({
  roomCode: z.string().trim().toUpperCase().min(1).max(16),
  name: z.string().trim().min(1).max(24).refine(value => !/\p{C}/u.test(value), 'Use a name without control characters.'),
  requestId,
}).strict();

interface SocketData { actor: Actor | null; token?: string }
export interface RuntimeOptions { dataDir: string; rootDir?: string; dev?: boolean; serveUi?: boolean }

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function interfaceAddresses(port: number): HostInfo['addresses'] {
  const addresses: HostInfo['addresses'] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push({ label: `${name} · ${entry.address}`, url: `http://${entry.address}:${port}` });
    }
  }
  return addresses.sort((a, b) => Number(!a.label.startsWith('en0')) - Number(!b.label.startsWith('en0')));
}

function knownHosts(): Set<string> {
  const machineName = hostname().toLowerCase();
  return new Set(['localhost', '127.0.0.1', '[::1]', machineName, machineName.endsWith('.local') ? machineName : `${machineName}.local`, ...Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => entry.address.toLowerCase()))]);
}

export async function createRuntime(options: RuntimeOptions) {
  const store = await openStore(options.dataDir);
  let data = store.data;
  let port = 0;
  let closing = false;
  let queue: Promise<unknown> = Promise.resolve();
  const app = express();
  const httpServer = createServer(app);
  let vite: { close(): Promise<void> } | undefined;

  function sameOrigin(request: { headers: { host?: string; origin?: string } }): boolean {
    const host = request.headers.host;
    if (!host) return false;
    try {
      if (!knownHosts().has(new URL(`http://${host}`).hostname.toLowerCase())) return false;
      if (!request.headers.origin) return true;
      const origin = new URL(request.headers.origin);
      return origin.protocol === 'http:' && origin.host.toLowerCase() === host.toLowerCase();
    } catch { return false; }
  }

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    maxHttpBufferSize: 8192,
    allowRequest: (request, callback) => callback(null, !closing && sameOrigin(request)),
  });

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function connectedPlayers(): Set<string> {
    const ids = new Set<string>();
    for (const socket of io.sockets.sockets.values()) if (socket.data.actor?.kind === 'player') ids.add(socket.data.actor.playerId);
    return ids;
  }

  function snapshot(actor: Actor | null): ServerSnapshot {
    const result: ServerSnapshot = { game: publicView(data.game, connectedPlayers()), isHost: actor?.kind === 'host' };
    if (actor?.kind === 'player') result.player = privateView(data.game, actor.playerId);
    if (actor?.kind === 'host') result.hostInfo = { port, addresses: interfaceAddresses(port) };
    return result;
  }

  function broadcast() {
    for (const socket of io.sockets.sockets.values()) {
      const token = socket.data.token;
      if (socket.data.actor?.kind === 'player' && (!token || !Object.hasOwn(data.sessions, token))) {
        socket.emit('sessionRevoked');
        socket.disconnect(true);
        continue;
      }
      socket.emit('snapshot', snapshot(socket.data.actor));
    }
  }

  async function commit(next: PersistedData) {
    await store.write(next);
    data = next;
    broadcast();
  }

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!sameOrigin(request)) { response.status(403).json({ ok: false, error: 'Open Roundtable using the Mac’s local address.' }); return; }
    next();
  });
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '8kb' }));
  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.post('/api/join', async (request, response) => {
    const parsed = joinSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ ok: false, error: 'Enter a room code and a name of 1–24 characters.' }); return; }
    const input = parsed.data;
    try {
      const result = await serialize<JoinResponse>(async () => {
        if (closing) return { ok: false, error: 'The server is shutting down. Please reconnect.' };
        const prior = Object.hasOwn(data.joinReceipts, input.requestId) ? data.joinReceipts[input.requestId] : undefined;
        if (prior) {
          if (prior.name !== input.name || prior.roomCode !== input.roomCode) return { ok: false, error: 'This request was already used. Please try joining again.' };
          if (!data.sessions[prior.token]) return { ok: false, error: 'This seat was removed. Please join again.' };
          return { ok: true, token: prior.token, playerId: prior.playerId };
        }
        if (input.roomCode !== data.game.roomCode) return { ok: false, error: 'Room code not found. Check the Mac’s screen.' };
        let game;
        const playerId = randomUUID();
        try { game = applyAction(data.game, { kind: 'system' }, { type: 'join', player: { id: playerId, name: input.name } }); }
        catch (error) { return { ok: false, error: (error as Error).message }; }
        const token = credential();
        const next = structuredClone(data);
        next.game = game;
        next.sessions[token] = { playerId };
        next.joinReceipts[input.requestId] = { name: input.name, roomCode: input.roomCode, token, playerId };
        for (const key of Object.keys(next.joinReceipts).slice(0, -256)) delete next.joinReceipts[key];
        await commit(next);
        return { ok: true, token, playerId };
      });
      response.status(result.ok ? 200 : 400).json(result);
    } catch {
      response.status(503).json({ ok: false, error: 'Unable to save the game. Please check the Mac and retry.' });
    }
  });
  app.use('/api', (_request, response) => response.status(404).json({ ok: false, error: 'Unknown API route.' }));

  io.use((socket, next) => {
    const auth = socket.handshake.auth;
    if (auth.hostToken !== undefined && auth.playerToken !== undefined) { next(new Error('Use either a host or player session.')); return; }
    if (auth.hostToken !== undefined) {
      if (typeof auth.hostToken !== 'string' || !equalSecret(auth.hostToken, data.hostToken)) { next(new Error('Invalid host credential')); return; }
      socket.data.actor = { kind: 'host' };
    } else if (auth.playerToken !== undefined) {
      if (typeof auth.playerToken !== 'string' || !Object.hasOwn(data.sessions, auth.playerToken)) { next(new Error('Invalid player session')); return; }
      socket.data.token = auth.playerToken;
      socket.data.actor = { kind: 'player', playerId: data.sessions[auth.playerToken].playerId };
    } else socket.data.actor = null;
    next();
  });

  io.on('connection', socket => {
    broadcast();
    socket.on('command', (payload, ack) => {
      if (typeof ack !== 'function') return;
      const parsed = commandSchema.safeParse(payload);
      if (!parsed.success) { ack({ ok: false, error: 'Invalid command.' }); return; }
      void serialize<CommandAck>(async () => {
        if (closing) return { ok: false, error: 'The server is shutting down. Please reconnect.' };
        const actor = socket.data.actor;
        if (!actor || (actor.kind === 'player' && (!socket.data.token || !data.sessions[socket.data.token]))) return { ok: false, error: 'Join the room before taking an action.' };
        const command = parsed.data;
        const actorKey = actor.kind === 'host' ? 'host' : actor.kind === 'player' ? actor.playerId : 'system';
        const receiptKey = `${actorKey}:${command.requestId}`;
        const fingerprint = JSON.stringify({ phaseId: command.phaseId, action: command.action });
        const receipt = data.commandReceipts[receiptKey];
        if (receipt) return receipt.fingerprint === fingerprint ? { ok: true } : { ok: false, error: 'This request was already used for another action.' };
        if (command.phaseId !== data.game.phaseId) return { ok: false, error: 'The game has moved on. Please use the current screen.' };
        if (command.action.type === 'start' && data.game.players.some(player => !connectedPlayers().has(player.id))) return { ok: false, error: 'Every player must be connected before starting.' };
        let game;
        try { game = applyAction(data.game, actor, command.action); }
        catch (error) { return { ok: false, error: (error as Error).message }; }
        const next = structuredClone(data);
        next.game = game;
        next.commandReceipts[receiptKey] = { fingerprint };
        for (const key of Object.keys(next.commandReceipts).slice(0, -2048)) delete next.commandReceipts[key];
        const remainingIds = new Set(game.players.map(player => player.id));
        for (const [token, session] of Object.entries(next.sessions)) if (!remainingIds.has(session.playerId)) delete next.sessions[token];
        await commit(next);
        return { ok: true };
      }).then(ack, () => ack({ ok: false, error: 'Unable to save the game. Please check the Mac and retry.' }));
    });
    socket.on('disconnect', () => { if (!closing) broadcast(); });
  });

  if (options.serveUi !== false) {
    const root = options.rootDir ?? process.cwd();
    if (options.dev) {
      try {
        const { createServer: createVite } = await import('vite');
        const devServer = await createVite({ root, server: { middlewareMode: true, hmr: { server: httpServer } }, appType: 'custom' });
        vite = devServer;
        app.use(devServer.middlewares);
        app.use(async (request, response, next) => {
          if (request.method !== 'GET' || !request.accepts('html')) { next(); return; }
          try { response.type('html').send(await devServer.transformIndexHtml(request.originalUrl, await readFile(resolve(root, 'index.html'), 'utf8'))); }
          catch (error) { next(error); }
        });
      } catch (error) { await io.close(); await store.release(); throw error; }
    } else {
      const dist = resolve(root, 'dist');
      app.use(express.static(dist));
      app.use((request, response, next) => {
        if (request.method !== 'GET' || !request.accepts('html')) { next(); return; }
        if (!existsSync(resolve(dist, 'index.html'))) { response.status(503).type('text').send('Roundtable has not been built. On the Mac, run npm run build and restart.'); return; }
        response.setHeader('Cache-Control', 'no-store');
        response.sendFile(resolve(dist, 'index.html'));
      });
    }
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number }).status;
    response.status(status === 413 ? 413 : 400).json({ ok: false, error: status === 413 ? 'Request is too large.' : 'Invalid request.' });
  });

  return {
    app, httpServer, io,
    get state() { return structuredClone(data.game); },
    get hostToken() { return data.hostToken; },
    async listen(listenPort = 3000, host = '0.0.0.0') {
      await new Promise<void>((resolveListen, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(listenPort, host, () => { httpServer.off('error', reject); resolveListen(); });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Could not determine the server port.');
      port = address.port;
      return { port, hostUrl: `http://localhost:${port}/host#token=${encodeURIComponent(data.hostToken)}` };
    },
    async close() {
      if (closing) return;
      closing = true;
      await queue;
      await vite?.close();
      await new Promise<void>(resolveClose => io.close(() => resolveClose()));
      if (httpServer.listening) await new Promise<void>((resolveClose, reject) => httpServer.close(error => error ? reject(error) : resolveClose()));
      await store.release();
    },
  };
}
