import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { ClientAction, JoinResponse, OptionalRole, PlayerPrivateView, PublicGameView, Role, ServerSnapshot } from '../shared/protocol';
import { requestId, storage, useConnection } from './connection';
import { dictionary, phaseText, roleText, type Language, type Text, type TextKey } from './i18n';

type UI = { language: Language; t: Text };
type Connection = ReturnType<typeof useConnection>;
type Actions = { command: (action: ClientAction) => Promise<boolean>; disabled: boolean; pending: boolean };
const PLAYER_KEY = 'roundtable.player.v1';
const HOST_KEY = 'roundtable.host.v1';
const optionalRoles: OptionalRole[] = ['percival', 'morgana', 'mordred', 'oberon'];
const evilRoles: Role[] = ['assassin', 'minion', 'morgana', 'mordred', 'oberon'];

function TableMark({ className = '' }: { className?: string }) {
  return <svg className={className} width="32" height="32" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="12" stroke="currentColor"/><circle cx="20" cy="20" r="6" stroke="currentColor"/><path d="M20 2v7m0 22v7M2 20h7m22 0h7M7 7l5 5m16 16 5 5M7 33l5-5m16-16 5-5" stroke="currentColor"/></svg>;
}
function Arrow({ down = false }: { down?: boolean }) { return <span aria-hidden="true">{down ? '↓' : '↗'}</span>; }
function Label({ children }: { children: ReactNode }) { return <p className="eyebrow">{children}</p>; }
function safeSession() {
  try {
    const stored: unknown = JSON.parse(storage.get(PLAYER_KEY) || 'null');
    if (!stored || typeof stored !== 'object' || !('token' in stored) || !('roomCode' in stored) || typeof stored.token !== 'string' || !stored.token || typeof stored.roomCode !== 'string' || !stored.roomCode) return null;
    return { token: stored.token, roomCode: stored.roomCode };
  } catch { return null; }
}
function initialHostToken() {
  if (location.pathname !== '/host') return undefined;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  return token || storage.get(HOST_KEY, true) || undefined;
}
const serverErrorKeys: Record<string, TextKey> = {
  'Room code not found. Check the Mac’s screen.': 'wrongRoom',
  'That name is already in use.': 'nameTaken',
  'The table is full (10 players maximum).': 'tableFull',
  'Use a name between 1 and 24 characters.': 'nameError',
  'Enter a room code and a name of 1–24 characters.': 'nameError',
  'That action is not available in this phase.': 'staleAction',
  'The game has moved on. Please use the current screen.': 'staleAction',
  'Every player must be connected before starting.': 'missingPlayers',
  'Unable to save the game. Please check the Mac and retry.': 'saveError',
  'The server is shutting down. Please reconnect.': 'serverClosing',
  'This request was already used. Please try joining again.': 'requestReused',
  'This seat was removed. Please join again.': 'requestReused',
};

export default function App() {
  const [language, setLanguage] = useState<Language>(() => storage.get('roundtable.language') === 'zh' || (!storage.get('roundtable.language') && navigator.language.startsWith('zh')) ? 'zh' : 'en');
  const t: Text = (key) => dictionary[language][key];
  const ui = { language, t };
  const phone = location.pathname === '/join' || location.pathname === '/play';
  const hostRoute = location.pathname === '/host';
  const [hostToken] = useState(initialHostToken);
  const roomQuery = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
  const [session, setSession] = useState(() => { const stored = safeSession(); return phone && stored && (!roomQuery || roomQuery === stored.roomCode) ? stored : null; });
  const [notice, setNotice] = useState<TextKey | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const connection = useConnection(hostRoute ? { hostToken } : phone && session ? { playerToken: session.token } : {}, () => {
    storage.remove(PLAYER_KEY); setSession(null); setNotice('sessionEnded');
  });
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; storage.set('roundtable.language', language); }, [language]);
  useEffect(() => { if (hostRoute && hostToken) { storage.set(HOST_KEY, hostToken, true); if (location.hash) history.replaceState(null, '', location.pathname + location.search); } }, [hostRoute, hostToken]);
  const joinSession = (token: string, roomCode: string) => {
    if (!storage.set(PLAYER_KEY, JSON.stringify({ token, roomCode }))) setNotice('storageWarning');
    setSession({ token, roomCode });
  };
  return <div className={`app ${phone ? 'phone-app' : 'board-app'}`}>
    <header className="site-header">
      <a className="brand" href="/" aria-label="Roundtable"><TableMark/><span>ROUNDTABLE<span className="brand-sub">AVALON</span></span></a>
      <div className="header-actions">
        {(hostRoute || session) && <span className={`connection-pill ${connection.connected ? '' : 'connection-lost'}`}><i/>{t(connection.connected ? 'connected' : 'reconnecting')}</span>}
        <button className="text-button rules-trigger" onClick={() => setRulesOpen(true)}>{t('rules')}</button>
        <button className="language-button" aria-label={language === 'en' ? '切换至简体中文' : 'Switch to English'} onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')}>{language === 'en' ? '中文' : 'EN'}</button>
      </div>
    </header>
    {notice && <div className="notice" role="status">{t(notice)}<button aria-label={t('close')} onClick={() => setNotice(null)}>×</button></div>}
    {(hostRoute || session) && <ConnectionNotice connection={connection} {...ui}/>}
    {!hostRoute && !phone ? <Landing {...ui}/> : phone && !session ? <JoinScreen roomCode={roomQuery} onJoin={joinSession} {...ui}/> : !connection.snapshot ? <main className="loading-screen"><TableMark/><p>{t('loading')}</p>{!connection.connected && <p className="muted">{t('serverUnavailable')}</p>}<button className="button secondary" onClick={connection.reconnect}>{t('retry')}</button></main> : phone && connection.snapshot.player ? <PlayerScreen key={connection.snapshot.game.gameId} snapshot={connection.snapshot} connection={connection} {...ui}/> : <HostScreen snapshot={connection.snapshot} connection={connection} {...ui}/>}
    <footer className="site-footer"><span>{t('subtitle')}</span><button className="text-button" onClick={() => setRulesOpen(true)}>{t('help')} <Arrow/></button></footer>
    {rulesOpen && <Modal title={t('rules')} close={() => setRulesOpen(false)} t={t}><Rules {...ui}/></Modal>}
  </div>;
}

export function ConnectionNotice({ connection, t, language }: { connection: Connection } & UI) {
  if (!connection.error && connection.connected && !connection.retry) return null;
  if (!connection.error && !connection.retry) return <div className="notice subtle" role="status">{t('serverUnavailable')}</div>;
  const error = connection.error || 'uncertain';
  const errorKey = Object.hasOwn(dictionary.en, error) ? error as TextKey : serverErrorKeys[error];
  const message = errorKey ? t(errorKey) : language === 'en' ? error : t('genericError');
  return <div className="notice" role="alert"><span>{message}</span>{connection.retry && <button disabled={!connection.connected || connection.pending} onClick={connection.retry}>{t('retryAction')}</button>}</div>;
}

function Landing({ t }: UI) {
  const [code, setCode] = useState('');
  function enter(event: FormEvent) { event.preventDefault(); if (code.trim()) location.assign(`/join?room=${encodeURIComponent(code.trim().toUpperCase())}`); }
  return <main className="landing">
    <section className="landing-copy"><Label>{t('local')} <span className="long-dash">——</span> 05–10</Label><h1>{t('landingTitle')}</h1><p className="lead">{t('landingIntro')}</p><div className="orbit-illustration" aria-hidden="true"><div className="orbit-inner"><TableMark/></div>{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ '--angle': `${i * 45}deg` } as React.CSSProperties}/>)}</div></section>
    <section className="entry-panel"><Label>01 / {t('joinTable')}</Label><h2>{t('joinTable')}</h2><p className="muted">{t('joinIntro')}</p><form onSubmit={enter}><label htmlFor="landing-code">{t('roomCode')}</label><input id="landing-code" className="code-input" autoComplete="off" autoCapitalize="characters" maxLength={12} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCDEF" required/><button className="button primary" type="submit">{t('enterRoom')} <Arrow/></button></form><p className="tiny">{t('noAccount')}</p><div className="host-tip"><Label>{t('hostHint')}</Label><p>{t('launchHint')}</p><a className="inline-link" href="/host">{t('openBoard')} <Arrow/></a></div></section>
  </main>;
}

function JoinScreen({ t, roomCode, onJoin }: UI & { roomCode: string; onJoin: (token: string, roomCode: string) => void }) {
  const [code, setCode] = useState(roomCode);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TextKey | null>(null);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(null);
  async function join(event: FormEvent) {
    event.preventDefault(); if (pending) return;
    if (!code.trim()) { setError('codeError'); return; }
    if (!name.trim() || name.trim().length > 24) { setError('nameError'); return; }
    const normalized = code.trim().toUpperCase(); const key = `${normalized}:${name.trim()}`;
    const id = attempt?.key === key ? attempt.id : requestId(); setAttempt({ key, id });
    setPending(true); setError(null); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode: normalized, name: name.trim(), requestId: id }), signal: controller.signal });
      const result: JoinResponse = await response.json();
      if (!result.ok || !result.token) { setError(result.error === 'That action is not available in this phase.' ? 'alreadyStarted' : serverErrorKeys[result.error || ''] || 'joinFailed'); return; }
      onJoin(result.token, normalized);
    } catch { setError('joinFailed'); } finally { clearTimeout(timeout); setPending(false); }
  }
  return <main className="join-screen"><div className="join-decoration"><TableMark/></div><Label>{t('local')}</Label><h1>{t('joinTable')}</h1><p className="lead">{t('joinIntro')}</p><form onSubmit={join} className="join-form"><label htmlFor="join-code">{t('roomCode')}</label><input id="join-code" autoComplete="off" autoCapitalize="characters" maxLength={12} className="code-input" placeholder="ABCDEF" value={code} disabled={pending} onChange={(event) => setCode(event.target.value.toUpperCase())} required/><label htmlFor="join-name">{t('name')}</label><input id="join-name" autoComplete="nickname" maxLength={24} placeholder={t('namePlaceholder')} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} required/>{error && <p role="alert" className="form-error">{t(error)}</p>}<button className="button primary" disabled={pending} type="submit">{t(pending ? 'joining' : 'join')} <Arrow/></button></form><p className="tiny">{t('noAccount')}</p></main>;
}

function HostScreen({ snapshot, connection, ...ui }: UI & { snapshot: ServerSnapshot; connection: Connection }) {
  const { game, isHost } = snapshot; const { t } = ui;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const busy = connection.disabled;
  const latestVote = game.voteHistory.at(-1); const latestQuest = game.questHistory.at(-1);
  const copy = phaseText(game.phase, t, latestVote?.approved, latestQuest?.passed);
  return <main className="host-layout">
    <div className="host-main">
      <div className="table-heading"><Label>{t(game.phase === 'lobby' ? 'lobby' : 'game')} <span className="long-dash">——</span> {game.roomCode}</Label><span className="tiny">{String(game.players.length).padStart(2, '0')} / 10</span></div>
      {game.phase === 'lobby' ? <><section className="host-hero"><h1>{copy.title}</h1><p className="lead">{copy.intro}</p></section><Players game={game} isHost={isHost} actions={connection} {...ui}/><RoleConfiguration game={game} isHost={isHost} actions={connection} {...ui}/></> : <><QuestTrack game={game} {...ui}/><section className="phase-hero" aria-live="polite"><Label>{game.phase === 'game-over' ? t('revealAll') : game.phase === 'roles' ? t('privateLabel') : `${t('questOf')} ${String(game.questNumber).padStart(2, '0')}`}</Label><h1>{game.phase === 'game-over' ? t(game.result?.winner === 'good' ? 'goodWins' : 'evilWins') : copy.title}</h1><p className="lead">{game.phase === 'game-over' ? resultDescription(game, t) : copy.intro}</p></section><PhaseDetails game={game} {...ui}/><Players game={game} {...ui}/><History game={game} {...ui}/></>}
    </div>
    <aside className="host-sidebar">
      {game.phase === 'lobby' && snapshot.hostInfo ? <JoinCard snapshot={snapshot} {...ui}/> : <div className="sidebar-card room-card"><Label>{t('roomCode')}</Label><strong>{game.roomCode}</strong><p className="tiny">{t('sameWifi')}</p></div>}
      <div className="sidebar-card host-controls">
        <Label>{t(isHost ? 'host' : 'hostBoard')}</Label>
        {!isHost ? <><p>{t('notHost')}</p><p className="muted small">{t('notHostHint')}</p></> : <>
          {game.phase === 'lobby' && <><p className="small muted">{t('startHint')}</p><button className="button primary" disabled={busy || !canStart(game)} onClick={() => connection.command({ type: 'start' })}>{t(connection.pending ? 'starting' : 'start')} <Arrow/></button><p className="tiny">{t(game.players.length >= 5 ? game.players.every((p) => p.connected) ? 'readyToBegin' : 'disconnectedPlayers' : 'minimum')}</p></>}
          {(game.phase === 'vote-result' || game.phase === 'quest-result') && <><p className="muted small">{t('waitingHost')}</p><button className="button primary" disabled={busy} onClick={() => connection.command({ type: 'continue' })}>{t(connection.pending ? 'pending' : 'continue')} <Arrow/></button></>}
          {game.phase === 'game-over' && <button className="button primary" disabled={busy} onClick={() => connection.command({ type: 'rematch' })}>{t('rematch')} <Arrow/></button>}
          {!['lobby', 'vote-result', 'quest-result', 'game-over'].includes(game.phase) && <p className="muted small">{t(game.phase === 'roles' ? 'waitingReady' : 'waitingOthers')}</p>}
          {game.phase !== 'lobby' && game.phase !== 'game-over' && <button className="text-button end-game" disabled={busy} onClick={() => setConfirmEnd(true)}>{t('abandon')}</button>}
        </>}
      </div>
      {game.phase !== 'lobby' && <div className="sidebar-card"><Label>{t('rejection')}</Label><div className="rejection-track" aria-label={`${t('rejection')}: ${game.rejectionCount} / 5`}>{Array.from({ length: 5 }, (_, i) => <span key={i} className={i < game.rejectionCount ? 'filled' : ''}>{i + 1}</span>)}</div><p className="tiny">{t('fiveRejections')}</p></div>}
      <p className="sidebar-footnote">{t('stayOpen')}</p>
    </aside>
    {confirmEnd && <Confirm text={t('abandonConfirm')} accept={t('abandon')} close={() => setConfirmEnd(false)} onConfirm={async () => { if (await connection.command({ type: 'abandon' })) setConfirmEnd(false); }} disabled={busy} t={t}/>}
  </main>;
}

function canStart(game: PublicGameView) {
  const count = game.players.length; if (count < 5 || count > 10 || !game.players.every((p) => p.connected)) return false;
  const evil = count === 10 ? 4 : count >= 7 ? 3 : 2;
  return 1 + game.optionalRoles.filter((role) => role !== 'percival').length <= evil;
}

function JoinCard({ snapshot, t }: UI & { snapshot: ServerSnapshot }) {
  const addresses = snapshot.hostInfo?.addresses || [];
  const [selected, setSelected] = useState('');
  const origin = addresses.find((address) => address.url === selected)?.url || addresses[0]?.url || '';
  const joinUrl = origin ? `${origin}/join?room=${encodeURIComponent(snapshot.game.roomCode)}` : '';
  const [qr, setQr] = useState('');
  useEffect(() => { let current = true; setQr(''); if (joinUrl) QRCode.toDataURL(joinUrl, { width: 256, margin: 2, color: { dark: '#111111', light: '#f2f2f2' }, errorCorrectionLevel: 'M' }).then((url) => { if (current) setQr(url); }).catch(() => {}); return () => { current = false; }; }, [joinUrl]);
  return <div className="sidebar-card join-card"><Label>{t('joinTable')}</Label><div className="qr-frame">{qr ? <img src={qr} width="224" height="224" alt={t('phoneCamera')}/> : <TableMark/>}</div><p className="qr-caption">{t('phoneCamera')}</p><div className="room-code"><span>{t('roomCode')}</span><strong>{snapshot.game.roomCode}</strong></div>{addresses.length > 1 && <><label htmlFor="network-address" className="tiny">{t('address')}</label><select id="network-address" value={origin} onChange={(event) => setSelected(event.target.value)}>{addresses.map((address) => <option key={address.url} value={address.url}>{address.label} · {address.url.replace('http://', '')}</option>)}</select></>}<p className="join-url">{joinUrl ? <a href={joinUrl}>{joinUrl}</a> : t('noAddress')}</p><details className="network-details"><summary>{t('sameWifi')}</summary><p>{t('networkHelp')}</p></details></div>;
}

function RoleConfiguration({ game, isHost, actions, language, t }: UI & { game: PublicGameView; isHost: boolean; actions: Actions }) {
  const count = game.players.length; const evil = count === 10 ? 4 : count >= 7 ? 3 : 2; const invalid = count >= 5 && 1 + game.optionalRoles.filter((role) => role !== 'percival').length > evil;
  return <section className="cast-section"><div className="section-heading"><Label>{t('composition')}</Label>{count >= 5 && <span className="tiny">{count - evil} {t('good')} <span className="mid-dot">·</span> {evil} {t('evil')}</span>}</div><p className="muted small">{t('coreRoles')}</p><div className="roles-grid">{optionalRoles.map((role) => { const chosen = game.optionalRoles.includes(role); return <button key={role} className={`role-option ${chosen ? 'role-chosen' : ''}`} aria-pressed={chosen} disabled={!isHost || actions.disabled} onClick={() => actions.command({ type: 'configure', optionalRoles: chosen ? game.optionalRoles.filter((item) => item !== role) : [...game.optionalRoles, role] })}><span className="role-name">{roleText[language][role].name}</span><span className="role-option-bottom"><span>{t(role === 'percival' ? 'good' : 'evil')}</span><span className="checkbox" aria-hidden="true">{chosen ? '✓' : '+'}</span></span></button>; })}</div>{invalid && <p className="form-error" role="alert">{t('slotsError')}</p>}{count === 5 && game.optionalRoles.includes('percival') && !game.optionalRoles.some((role) => role === 'morgana' || role === 'mordred') && <p className="tiny">{t('balanceHint')}</p>}</section>;
}

function Players({ game, isHost = false, actions, playerId, language, t }: UI & { game: PublicGameView; isHost?: boolean; actions?: Actions; playerId?: string }) {
  const [removeId, setRemoveId] = useState<string | null>(null);
  function reorder(index: number, delta: number) { const ids = game.players.map((p) => p.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]; void actions?.command({ type: 'reorder', playerIds: ids }); }
  return <section className="players-section"><div className="section-heading"><Label>{t(game.phase === 'game-over' ? 'revealAll' : 'atTable')}</Label><span className="tiny">{game.players.length} {t('playerCount')}</span></div>{!game.players.length ? <div className="empty-table"><TableMark/><p>{t('noPlayers')}</p></div> : <div className="players-grid">{game.players.map((person, index) => <div key={person.id} className={`player-seat ${game.team.includes(person.id) ? 'on-team' : ''}`}><span className="seat-number">{String(index + 1).padStart(2, '0')}</span><div className="seat-content"><span className="seat-name">{person.name}{person.id === playerId && <small> ({t('you')})</small>}</span><span className="seat-meta"><i className={`presence-dot ${person.connected ? 'present' : ''}`}/>{game.phase === 'game-over' && game.revealedRoles?.[person.id] ? roleText[language][game.revealedRoles[person.id]].name : person.id === game.leaderId && game.phase !== 'lobby' ? t('leader') : person.connected ? t('connected') : t('offline')}{game.phase === 'roles' && game.readyIds.includes(person.id) ? ` · ${t('acknowledged')}` : ['voting', 'quest'].includes(game.phase) && game.submittedIds.includes(person.id) ? ` · ${t('submitted')}` : ''}</span></div>{isHost && game.phase === 'lobby' && actions && <div className="seat-controls"><button aria-label={`${t('moveUp')}: ${person.name}`} title={t('moveUp')} disabled={actions.disabled || index === 0} onClick={() => reorder(index, -1)}>↑</button><button aria-label={`${t('moveDown')}: ${person.name}`} title={t('moveDown')} disabled={actions.disabled || index === game.players.length - 1} onClick={() => reorder(index, 1)}>↓</button><button aria-label={`${t('remove')}: ${person.name}`} title={t('remove')} disabled={actions.disabled} onClick={() => setRemoveId(person.id)}>×</button></div>}</div>)}</div>}{removeId && <Confirm text={t('removeConfirm')} accept={t('remove')} close={() => setRemoveId(null)} onConfirm={async () => { if (await actions?.command({ type: 'remove-player', playerId: removeId })) setRemoveId(null); }} disabled={actions?.disabled || false} t={t}/>}</section>;
}

function QuestTrack({ game, t }: UI & { game: PublicGameView }) {
  return <section className="quest-track" aria-label={t('questHistory')}>{Array.from({ length: 5 }, (_, index) => { const number = index + 1; const result = game.questHistory.find((quest) => quest.questNumber === number); return <div key={number} className={`quest-station ${!result && game.questNumber === number ? 'quest-current' : ''} ${result ? 'quest-complete' : ''}`}><span className="quest-label">{t('quest')} {String(number).padStart(2, '0')}</span><div className="quest-circle"><span>{result ? result.passed ? '✓' : '×' : game.questSizes[index] || '—'}</span></div><span className="quest-caption">{result ? t(result.passed ? 'passed' : 'failed') : game.questSizes[index] ? `${game.questSizes[index]} ${t('teamSize')}` : '—'}{number === 4 && game.players.length >= 7 && <small>2 {t('fail')}</small>}</span></div>; })}</section>;
}

function PhaseDetails({ game, t }: UI & { game: PublicGameView }) {
  const leader = game.players.find((person) => person.id === game.leaderId);
  const latestVote = game.voteHistory.at(-1); const latestQuest = game.questHistory.at(-1);
  if (game.phase === 'game-over') return game.result?.targetId ? <div className="result-note"><Label>{t('target')}</Label><strong>{game.players.find((person) => person.id === game.result?.targetId)?.name}</strong></div> : null;
  if (game.phase === 'roles') return <div className="progress-line"><span>{t('acknowledged')}</span><strong>{game.readyIds.length} <span>/ {game.players.length}</span></strong><div className="progress-bar"><i style={{ width: `${game.readyIds.length / game.players.length * 100}%` }}/></div></div>;
  return <div className="phase-details">
    {game.phase !== 'assassination' && <div className="leader-strip"><div><Label>{t('currentLeader')}</Label><strong>{leader?.name}</strong></div><div className="quest-threshold">{t(game.requiredFails === 2 ? 'twoFails' : 'oneFail')}</div></div>}
    {['proposal', 'voting', 'vote-result', 'quest', 'quest-result'].includes(game.phase) && <div className="team-section"><Label>{t(game.phase === 'proposal' || game.phase === 'voting' || game.phase === 'vote-result' ? 'proposedTeam' : 'selectedTeam')}</Label>{game.team.length ? <div className="team-chips">{game.team.map((id) => <span key={id}>{game.players.find((person) => person.id === id)?.name}</span>)}</div> : <p className="muted small">{t('noTeam')}</p>}</div>}
    {['voting', 'quest'].includes(game.phase) && <div className="progress-line"><span>{t('submitted')}</span><strong>{game.submittedIds.length} <span>/ {game.phase === 'quest' ? game.team.length : game.players.length}</span></strong><div className="progress-bar"><i style={{ width: `${game.submittedIds.length / (game.phase === 'quest' ? game.team.length : game.players.length) * 100}%` }}/></div></div>}
    {game.phase === 'vote-result' && latestVote && <div className="vote-reveal">{game.players.map((person) => <div key={person.id}><span>{person.name}</span><strong>{latestVote.votes[person.id] ? '✓' : '×'} <span>{t(latestVote.votes[person.id] ? 'approve' : 'reject')}</span></strong></div>)}</div>}
    {game.phase === 'quest-result' && latestQuest && <div className="quest-card-reveal"><div><strong>{latestQuest.successes}</strong><span>✓ {t('success')}</span></div><div><strong>{latestQuest.fails}</strong><span>× {t('fail')}</span></div></div>}
  </div>;
}

function resultDescription(game: PublicGameView, t: Text) { const keys: Record<string, TextKey> = { 'three-fails': 'threeFails', 'five-rejections': 'fiveRejections', 'merlin-found': 'merlinFound', 'merlin-survived': 'merlinSurvived' }; return game.result ? t(keys[game.result.reason]) : t('gameOverIntro'); }

function PlayerScreen({ snapshot, connection, ...ui }: UI & { snapshot: ServerSnapshot; connection: Connection }) {
  const { game } = snapshot; const player = snapshot.player!; const { t } = ui;
  return <main className="player-screen"><div className="player-heading"><Label>{t('roomCode')} <span className="long-dash">——</span> {game.roomCode}</Label><span className="player-greeting">{game.players.find((person) => person.id === player.playerId)?.name}</span></div>
    {game.phase === 'lobby' ? <><section className="phone-hero"><h1>{t('waitingPhone')}</h1><p className="lead">{t('waitingPhoneIntro')}</p><div className="phone-table-mark"><TableMark/></div></section><Players game={game} playerId={player.playerId} {...ui}/><RoleConfiguration game={game} isHost={false} actions={connection} {...ui}/></> : game.phase === 'game-over' ? <><QuestTrack game={game} {...ui}/><section className="phone-hero"><Label>{t('revealAll')}</Label><h1>{t(game.result?.winner === 'good' ? 'goodWins' : 'evilWins')}</h1><p className="lead">{resultDescription(game, t)}</p></section><PhaseDetails game={game} {...ui}/><Players game={game} playerId={player.playerId} {...ui}/><History game={game} {...ui}/><p className="muted small">{t('waitingHost')}</p></> : <><div className="phone-quest-heading"><span>{t('quest')} {game.questNumber} / 5</span><span>{t('rejection')} {game.rejectionCount}/5</span></div><RoleCard key={game.gameId} game={game} player={player} actions={connection} {...ui}/><PlayerActions key={game.phaseId} game={game} player={player} actions={connection} {...ui}/>{game.phase !== 'roles' && <details className="phone-board" open={['vote-result', 'quest-result'].includes(game.phase)}><summary>{t('hostBoard')} <span>+</span></summary><QuestTrack game={game} {...ui}/><PhaseDetails game={game} {...ui}/><Players game={game} playerId={player.playerId} {...ui}/><History game={game} {...ui}/></details>}</>}
  </main>;
}

function RoleCard({ game, player, actions, language, t }: UI & { game: PublicGameView; player: PlayerPrivateView; actions: Actions }) {
  const [visible, setVisible] = useState(false); const [read, setRead] = useState(player.ready);
  useEffect(() => { const conceal = () => setVisible(false); const visibility = () => { if (document.hidden) conceal(); }; window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); }; }, []);
  const role = player.role; if (!role) return null;
  const reveal = () => { setVisible(true); setRead(true); };
  return <section className={`private-card ${visible ? 'private-visible' : ''}`}><Label>{t('privateLabel')}</Label>{visible ? <><div className="role-card-heading"><h2>{roleText[language][role].name}</h2><span className="faction-tag">{t(player.faction === 'good' ? 'good' : 'evil')}</span></div><p>{roleText[language][role].description}</p>{player.knownEvilIds.length > 0 ? <Knowledge title={t('knowledgeEvil')} ids={player.knownEvilIds} game={game}/> : null}{player.merlinCandidateIds.length > 0 ? <Knowledge title={t('knowledgeMerlin')} ids={player.merlinCandidateIds} game={game}/> : null}{!player.knownEvilIds.length && !player.merlinCandidateIds.length && <p className="private-empty">{t(['merlin', 'assassin', 'minion', 'morgana', 'mordred'].includes(role) ? 'noVisibleEvil' : 'noKnowledge')}</p>}<button className="button secondary" onClick={() => setVisible(false)}><span aria-hidden="true">◇</span> {t('conceal')}</button></> : <><div className="concealed-glyph" aria-hidden="true">◇</div><h2>{t('concealedTitle')}</h2><p className="muted">{t('concealedIntro')}</p><button className="button secondary" onClick={reveal}>{t('revealed')} <Arrow/></button></>}{game.phase === 'roles' && <div className="ready-action">{player.ready ? <p>✓ {t('readyDone')}</p> : <button className="button primary" disabled={actions.disabled || !read} onClick={() => actions.command({ type: 'ready' })}>{t(actions.pending ? 'pending' : 'ready')} <Arrow/></button>}<p className="tiny">{t('waitingReady')} {game.readyIds.length}/{game.players.length}</p></div>}</section>;
}
function Knowledge({ title, ids, game }: { title: string; ids: string[]; game: PublicGameView }) { return <div className="knowledge"><Label>{title}</Label><div className="team-chips">{ids.map((id) => <span key={id}>{game.players.find((p) => p.id === id)?.name}</span>)}</div></div>; }

function PlayerActions({ game, player, actions, t, ...ui }: UI & { game: PublicGameView; player: PlayerPrivateView; actions: Actions }) {
  const [selected, setSelected] = useState<string[]>([]); const [targetId, setTargetId] = useState<string | null>(null);
  const count = game.questSizes[game.questNumber - 1];
  function toggle(id: string) { setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]); }
  if (game.phase === 'roles') return null;
  if (game.phase === 'proposal') return <section className="action-card"><Label>{t('quest')} {game.questNumber}</Label><h2>{t(player.playerId === game.leaderId ? 'chooseTeam' : 'waitingLeader')}</h2>{player.playerId === game.leaderId ? <><p className="muted small">{t('chooseCount')} {count} {t('playersWord')}.</p><div className="team-selector">{game.players.map((person) => <button key={person.id} aria-pressed={selected.includes(person.id)} disabled={actions.disabled || (!selected.includes(person.id) && selected.length >= count)} className={selected.includes(person.id) ? 'selected' : ''} onClick={() => toggle(person.id)}><span>{person.name}{person.id === player.playerId ? ` (${t('you')})` : ''}</span><span className="checkbox" aria-hidden="true">{selected.includes(person.id) ? '✓' : '+'}</span></button>)}</div><button className="button primary" disabled={actions.disabled || selected.length !== count} onClick={() => actions.command({ type: 'propose', team: selected })}>{t(actions.pending ? 'pending' : 'propose')} <span>{selected.length}/{count}</span></button></> : <p className="muted">{game.players.find((p) => p.id === game.leaderId)?.name} <span className="mid-dot">·</span> {count} {t('playersWord')}</p>}</section>;
  if (game.phase === 'voting') return <section className="action-card"><Label>{t('proposedTeam')}</Label><div className="team-chips">{game.team.map((id) => <span key={id}>{game.players.find((p) => p.id === id)?.name}</span>)}</div>{typeof player.ownVote === 'boolean' ? <Sealed text={t('voteRecorded')} subtext={t('waitingOthers')}/> : <><h2>{t('votePrompt')}</h2><p className="tiny">{t('voteFinal')}</p><div className="choice-buttons"><button className="button secondary" disabled={actions.disabled} onClick={() => actions.command({ type: 'vote', approve: false })}>× {t('reject')}</button><button className="button primary" disabled={actions.disabled} onClick={() => actions.command({ type: 'vote', approve: true })}>✓ {t('approve')}</button></div></>}<p className="tiny action-progress">{game.submittedIds.length}/{game.players.length} {t('submitted')}</p></section>;
  if (game.phase === 'quest') return <section className="action-card"><Label>{t('quest')} {game.questNumber}</Label>{!game.team.includes(player.playerId) ? <><h2>{t('questTitle')}</h2><p className="muted">{t('notOnQuest')}</p></> : player.ownQuestCard ? <Sealed text={t('questRecorded')} subtext={t('waitingOthers')}/> : <><h2>{t('questPrompt')}</h2><p className="muted small">{t(player.faction === 'good' ? 'goodMust' : 'cardFinal')}</p><div className="choice-buttons">{player.faction === 'evil' && <button className="button secondary quest-choice" disabled={actions.disabled} onClick={() => actions.command({ type: 'quest-card', card: 'fail' })}><span aria-hidden="true">×</span>{t('fail')}</button>}<button className="button primary quest-choice" disabled={actions.disabled} onClick={() => actions.command({ type: 'quest-card', card: 'success' })}><span aria-hidden="true">✓</span>{t('success')}</button></div></>}<p className="tiny action-progress">{game.submittedIds.length}/{game.team.length} {t('submitted')}</p></section>;
  if (game.phase === 'assassination') return <section className="action-card"><Label>{t('assassinationTitle')}</Label><h2>{t(player.role === 'assassin' ? 'chooseMerlin' : 'waitingAssassin')}</h2>{player.role === 'assassin' ? <><div className="team-selector">{game.players.filter((p) => p.id !== player.playerId).map((person) => <button key={person.id} disabled={actions.disabled} aria-pressed={selected[0] === person.id} className={selected[0] === person.id ? 'selected' : ''} onClick={() => setSelected([person.id])}><span>{person.name}</span><span className="checkbox" aria-hidden="true">{selected[0] === person.id ? '✓' : '+'}</span></button>)}</div><button className="button primary" disabled={actions.disabled || !selected.length} onClick={() => setTargetId(selected[0])}>{t('assassinate')} <Arrow/></button>{targetId && <Confirm text={`${game.players.find((p) => p.id === targetId)?.name} — ${t('assassinateConfirm')}`} accept={t('assassinate')} close={() => setTargetId(null)} onConfirm={async () => { if (await actions.command({ type: 'assassinate', targetId })) setTargetId(null); }} disabled={actions.disabled} t={t}/>}</> : <p className="muted small">{t('assassinationIntro')}</p>}</section>;
  const copy = phaseText(game.phase, t, game.voteHistory.at(-1)?.approved, game.questHistory.at(-1)?.passed);
  return <section className="action-card"><Label>{t('quest')} {game.questNumber}</Label><h2>{copy.title}</h2><PhaseDetails game={game} t={t} {...ui}/><p className="tiny">{t('waitingHost')}</p></section>;
}
function Sealed({ text, subtext }: { text: string; subtext: string }) { return <div className="sealed"><span aria-hidden="true">✓</span><h2>{text}</h2><p className="muted small">{subtext}</p></div>; }

function History({ game, t }: UI & { game: PublicGameView }) {
  if (!game.voteHistory.length && !game.questHistory.length) return null;
  return <section className="history-section"><Label>{t('history')}</Label><details><summary>{t('voteHistory')} <span>{game.voteHistory.length} <Arrow down/></span></summary><div className="history-list">{game.voteHistory.map((vote, index) => <details key={`${vote.questNumber}-${vote.attempt}-${index}`} className="history-entry"><summary><span>{t('quest')} {vote.questNumber} <span className="mid-dot">·</span> {vote.attempt}</span><strong>{t(vote.approved ? 'approved' : 'rejected')}</strong></summary><p className="tiny">{t('leader')}: {game.players.find((p) => p.id === vote.leaderId)?.name}</p><div className="team-chips">{vote.team.map((id) => <span key={id}>{game.players.find((p) => p.id === id)?.name}</span>)}</div><div className="vote-reveal compact">{game.players.map((person) => <div key={person.id}><span>{person.name}</span><strong>{vote.votes[person.id] ? '✓' : '×'} {t(vote.votes[person.id] ? 'approve' : 'reject')}</strong></div>)}</div></details>)}</div></details>{game.questHistory.length > 0 && <details><summary>{t('questHistory')} <span>{game.questHistory.length} <Arrow down/></span></summary><div className="history-list">{game.questHistory.map((quest) => <div className="quest-history-entry" key={quest.questNumber}><span>{t('quest')} {quest.questNumber}</span><strong>{t(quest.passed ? 'passed' : 'failed')}</strong><p className="tiny">✓ {quest.successes} {t('success')} <span className="mid-dot">·</span> × {quest.fails} {t('fail')}</p></div>)}</div></details>}</section>;
}

function Modal({ title, children, close, t }: { title: string; children: ReactNode; close: () => void; t: Text }) {
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const before = document.body.style.overflow; document.body.style.overflow = 'hidden'; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); if (event.key === 'Tab') { const items = Array.from(document.querySelectorAll<HTMLElement>('.modal button:not(:disabled), .modal a[href], .modal input, .modal select')); const first = items[0]; const last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }; document.addEventListener('keydown', onKey); document.querySelector<HTMLElement>('.modal .modal-close')?.focus(); return () => { document.body.style.overflow = before; document.removeEventListener('keydown', onKey); previous?.focus(); }; }, []);
  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><Label>{title}</Label><button className="modal-close" aria-label={t('close')} onClick={close}>×</button></div>{children}</section></div>;
}
function Confirm({ text, accept, close, onConfirm, disabled, t }: { text: string; accept: string; close: () => void; onConfirm: () => void; disabled: boolean; t: Text }) { return <Modal title={accept} close={close} t={t}><div className="confirm-content"><h2>{text}</h2><div className="choice-buttons"><button className="button secondary" disabled={disabled} onClick={close}>{t('back')}</button><button className="button primary" disabled={disabled} onClick={onConfirm}>{accept}</button></div></div></Modal>; }
function Rules({ t, language }: UI) { return <div className="rules-content"><h1>{t('rulesTitle')}</h1><p className="lead">{t('rulesIntro')}</p>{([1, 2, 3, 4] as const).map((number) => <section key={number}><Label>{t(`rules${number}Title`)}</Label><p>{t(`rules${number}`)}</p></section>)}<div className="rules-roles">{Object.entries(roleText[language]).map(([role, text]) => <div key={role}><h3>{text.name}<span>{t(evilRoles.includes(role as Role) ? 'evil' : 'good')}</span></h3><p>{text.description}</p></div>)}</div><p className="tiny">{t('rulesPrivacy')}</p><p className="eyebrow">{t('edition')}</p></div>; }
