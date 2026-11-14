import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientAction, ClientToServerEvents, CommandEnvelope, ServerSnapshot, ServerToClientEvents } from '../shared/protocol';

export const storage = {
  get(key: string, session = false): string | null { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  set(key: string, value: string, session = false): boolean { try { (session ? sessionStorage : localStorage).setItem(key, value); return true; } catch { return false; } },
  remove(key: string, session = false) { try { (session ? sessionStorage : localStorage).removeItem(key); } catch { /* The UI remains usable without storage. */ } },
};
let sequence = 0;
export const requestId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(++sequence).toString(36)}`;
type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export interface Credentials { hostToken?: string; playerToken?: string }

export function useConnection(credentials: Credentials, onRevoked: () => void) {
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null);
  const snapshotRef = useRef<ServerSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryEnvelope, setRetryEnvelope] = useState<CommandEnvelope | null>(null);
  const socketRef = useRef<GameSocket | null>(null);
  const busy = useRef(false);
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;

  useEffect(() => {
    setSnapshot(null); snapshotRef.current = null; setError(null); setRetryEnvelope(null); setPending(false); busy.current = false;
    const socket: GameSocket = io({ auth: credentials, autoConnect: true, reconnection: true });
    socketRef.current = socket;
    socket.on('connect', () => { setConnected(true); setError(null); });
    socket.on('disconnect', () => { setConnected(false); });
    socket.on('connect_error', (cause) => {
      setConnected(false);
      if (/invalid.*(session|credential|token)|unauthorized|expired/i.test(cause.message)) {
        setError(credentials.hostToken ? 'invalidHost' : 'invalidSession');
        if (credentials.playerToken) revokedRef.current();
      } else setError('serverUnavailable');
    });
    socket.on('snapshot', (next) => { snapshotRef.current = next; setSnapshot(next); });
    socket.on('sessionRevoked', () => { setError('sessionEnded'); revokedRef.current(); });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [credentials.hostToken, credentials.playerToken]);

  const dispatch = useCallback(async (envelope: CommandEnvelope): Promise<boolean> => {
    const socket = socketRef.current;
    if (!socket?.connected || busy.current) return false;
    busy.current = true; setPending(true); setError(null);
    return new Promise((resolve) => {
      socket.timeout(8000).volatile.emit('command', envelope, (failure, result) => {
        busy.current = false; setPending(false);
        if (failure) {
          if (snapshotRef.current?.game.phaseId !== envelope.phaseId) { setRetryEnvelope(null); resolve(true); return; }
          setRetryEnvelope(envelope); setError('uncertain'); resolve(false); return;
        }
        setRetryEnvelope(null);
        if (!result?.ok) { setError(result?.error || 'genericError'); resolve(false); return; }
        resolve(true);
      });
    });
  }, []);
  const command = useCallback((action: ClientAction): Promise<boolean> => {
    if (!snapshotRef.current || retryEnvelope) return Promise.resolve(false);
    return dispatch({ requestId: requestId(), phaseId: snapshotRef.current.game.phaseId, action });
  }, [dispatch, retryEnvelope]);
  return {
    snapshot, connected, error, pending, command,
    disabled: !connected || pending || Boolean(retryEnvelope),
    retry: retryEnvelope ? () => dispatch(retryEnvelope) : undefined,
    reconnect: () => socketRef.current?.connect(),
    clearError: () => setError(null),
  };
}
