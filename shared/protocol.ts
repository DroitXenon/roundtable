/** Wire types only. The complete game state is never sent to a client. */
export type Role = 'merlin' | 'assassin' | 'servant' | 'minion' | 'percival' | 'morgana' | 'mordred' | 'oberon';
export type OptionalRole = 'percival' | 'morgana' | 'mordred' | 'oberon';
export type Faction = 'good' | 'evil';
export type Phase = 'lobby' | 'roles' | 'proposal' | 'voting' | 'vote-result' | 'quest' | 'quest-result' | 'assassination' | 'game-over';
export type QuestCard = 'success' | 'fail';
export interface Player { id: string; name: string }
export interface PublicPlayer extends Player { connected: boolean }
export interface VoteRecord { questNumber: number; attempt: number; leaderId: string; team: string[]; votes: Record<string, boolean>; approved: boolean }
export interface QuestRecord { questNumber: number; team: string[]; successes: number; fails: number; requiredFails: number; passed: boolean }
export interface GameResult { winner: Faction; reason: 'three-fails' | 'five-rejections' | 'merlin-found' | 'merlin-survived'; targetId?: string }

/** Server-only data, persisted locally. Never import this into a UI component. */
export interface GameState {
  schemaVersion: 1;
  roomCode: string;
  gameId: string;
  revision: number;
  phase: Phase;
  phaseId: string;
  players: Player[];
  optionalRoles: OptionalRole[];
  roles: Record<string, Role>;
  readyIds: string[];
  leaderIndex: number;
  questNumber: number;
  rejectionCount: number;
  team: string[];
  votes: Record<string, boolean>;
  questCards: Record<string, QuestCard>;
  voteHistory: VoteRecord[];
  questHistory: QuestRecord[];
  result: GameResult | null;
}
export interface PublicGameView {
  roomCode: string;
  gameId: string;
  revision: number;
  phase: Phase;
  phaseId: string;
  players: PublicPlayer[];
  optionalRoles: OptionalRole[];
  leaderId: string | null;
  questNumber: number;
  questSizes: number[];
  requiredFails: number;
  rejectionCount: number;
  team: string[];
  readyIds: string[];
  submittedIds: string[];
  voteHistory: VoteRecord[];
  questHistory: QuestRecord[];
  result: GameResult | null;
  revealedRoles?: Record<string, Role>;
}
export interface PlayerPrivateView {
  playerId: string;
  role: Role | null;
  faction: Faction | null;
  knownEvilIds: string[];
  merlinCandidateIds: string[];
  ready: boolean;
  ownVote?: boolean;
  ownQuestCard?: QuestCard;
}
export interface NetworkAddress { label: string; url: string }
export interface HostInfo { addresses: NetworkAddress[]; port: number }
export interface ServerSnapshot { game: PublicGameView; player?: PlayerPrivateView; isHost: boolean; hostInfo?: HostInfo }

export type GameAction =
  | { type: 'join'; player: Player }
  | { type: 'remove-player'; playerId: string }
  | { type: 'reorder'; playerIds: string[] }
  | { type: 'configure'; optionalRoles: OptionalRole[] }
  | { type: 'start' }
  | { type: 'ready' }
  | { type: 'propose'; team: string[] }
  | { type: 'vote'; approve: boolean }
  | { type: 'quest-card'; card: QuestCard }
  | { type: 'continue' }
  | { type: 'assassinate'; targetId: string }
  | { type: 'rematch' }
  | { type: 'abandon' };
export type ClientAction = Exclude<GameAction, { type: 'join' }>;
export type Actor = { kind: 'host' } | { kind: 'player'; playerId: string } | { kind: 'system' };
export interface CommandEnvelope { requestId: string; phaseId: string; action: ClientAction }
export interface CommandAck { ok: boolean; error?: string }
export interface JoinRequest { roomCode: string; name: string; requestId: string }
export interface JoinResponse extends CommandAck { token?: string; playerId?: string }
export interface ClientToServerEvents { command: (command: CommandEnvelope, ack: (result: CommandAck) => void) => void }
export interface ServerToClientEvents { snapshot: (snapshot: ServerSnapshot) => void; sessionRevoked: () => void }
