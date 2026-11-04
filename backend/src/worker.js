import { DurableObject } from 'cloudflare:workers';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 6;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = randomCode();
        const id = env.ROOMS.idFromName(code);
        const response = await env.ROOMS.get(id).fetch('https://room.internal/initialize', { method: 'POST', body: JSON.stringify({ code }) });
        if (response.status === 201) return json({ code }, 201);
      }
      return json({ error: 'Could not reserve a room. Please try again.' }, 503);
    }
    const match = url.pathname.match(/^\/ws\/([A-Z0-9]{5})$/i);
    if (match && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const id = env.ROOMS.idFromName(match[1].toUpperCase());
      return env.ROOMS.get(id).fetch(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Kala room worker is running.', { headers: { 'content-type': 'text/plain' } });
  },
};

export class KalaRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.room = null;
    this.ready = ctx.storage.get('room').then(room => { this.room = room || null; });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/initialize' && request.method === 'POST') {
      if (this.room) return new Response('Room code already exists.', { status: 409 });
      const { code } = await request.json();
      this.room = { code, hostId: null, players: [], phase: 'lobby', mode: 'ffa', game: null };
      await this.persist(); await this.setAlarmAfter(24 * 60 * 60 * 1000);
      return new Response('Created.', { status: 201 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required.', { status: 426 });
    if (!this.room) return new Response('Room not found.', { status: 404 });

    const role = url.searchParams.get('role') === 'viewer' ? 'viewer' : 'player';
    const name = (url.searchParams.get('name') || 'ROOKIE').trim().slice(0, 16) || 'ROOKIE';
    if (role === 'player' && this.room.phase !== 'lobby') return new Response('This match has already started.', { status: 409 });
    if (role === 'player' && this.room.players.length >= MAX_PLAYERS) return new Response('This room is full.', { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, role, name });
    if (role === 'player') {
      const isHost = !this.room.hostId;
      const team = this.room.players.length % 2 === 0 ? 'Blue' : 'Red';
      this.room.players.push({ id, name, team, alive: true, kills: 0, pos: null, ready: isHost });
      this.room.hostId ||= id;
    }
    await this.persist();
    this.send(server, { type: 'connected', clientId: id });
    this.send(server, { type: 'joined', clientId: id, code: this.room.code, role });
    if (role === 'viewer') this.send(server, { ...this.roomInfo(), snapshot: this.room.game ? this.gameSnapshot() : null });
    this.broadcast(this.roomInfo());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.ready;
    if (!this.room) return;
    let message;
    try { message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); }
    catch { this.send(ws, { type: 'error', message: 'Invalid room message.' }); return; }
    const session = ws.deserializeAttachment() || {};
    if (message.type === 'start-match') return this.startMatch(session, message);
    if (message.type === 'move') return this.submitMove(session, message);
    if (message.type === 'round-resolution') return this.resolveRound(session, message);
    if (message.type === 'set-ready') return this.setReady(session, message);
    if (message.type === 'transfer-host') return this.transferHost(session, message);
    if (message.type === 'kick-player') return this.kickPlayer(session, message);
    if (message.type === 'back-to-lobby') return this.backToLobby(session);
    if (message.type === 'end-game') return this.endGame(session);
    if (message.type === 'end-room') return this.endRoom(session);
    if (message.type === 'leave-room') { ws.close(1000, 'Left room'); return; }
  }

  async setReady(session, message) {
    if (session.role !== 'player' || this.room.phase !== 'lobby') return;
    const player = this.room.players.find(entry => entry.id === session.id);
    if (!player || player.id === this.room.hostId) return;
    player.ready = Boolean(message.ready);
    await this.persist(); this.broadcast(this.roomInfo());
  }

  async transferHost(session, message) {
    if (session.id !== this.room.hostId) return;
    const nextHost = this.room.players.find(entry => entry.id === message.targetId);
    if (!nextHost) { this.sendToId(session.id, { type:'error', message:'That operative is no longer in the room.' }); return; }
    this.room.hostId = nextHost.id; nextHost.ready = true;
    await this.persist(); this.broadcast({ type:'host-changed', hostId:this.room.hostId }); this.broadcast(this.roomInfo());
  }

  async kickPlayer(session, message) {
    if (session.id !== this.room.hostId || message.targetId === session.id) return;
    const target = this.room.players.find(entry => entry.id === message.targetId);
    if (!target) return;
    const socket = this.ctx.getWebSockets().find(ws => ws.deserializeAttachment()?.id === target.id);
    if (!socket) { this.room.players = this.room.players.filter(p => p.id !== target.id); await this.persist(); this.broadcast(this.roomInfo()); return; }
    this.send(socket, { type:'kicked', message:'The host removed you from the room.' });
    socket.close(4001, 'Removed by host');
  }

  async backToLobby(session) {
    if (session.id !== this.room.hostId || this.room.phase === 'lobby') return;
    await this.ctx.storage.deleteAlarm();
    this.room.phase='lobby'; this.room.game=null;
    for (const player of this.room.players) { player.alive=true; player.kills=0; player.pos=null; player.ready=player.id===this.room.hostId; }
    await this.persist();
    this.broadcast({ type:'back-to-lobby', hostId:this.room.hostId, players:this.room.players });
    this.broadcast(this.roomInfo());
  }

  async endGame(session) {
    if (session.id !== this.room.hostId || !this.room.game || this.room.phase === 'lobby' || this.room.phase === 'finished') return;
    await this.ctx.storage.deleteAlarm(); this.room.phase='finished'; await this.persist();
    this.broadcast({ type:'game-ended', message:'The host ended the match.', players:this.room.players, round:this.room.game.round });
    this.broadcast(this.roomInfo());
  }

  async endRoom(session) {
    if (session.id !== this.room.hostId) return;
    this.broadcast({ type:'room-closed', message:'The host ended this room.' });
    await this.ctx.storage.deleteAlarm();
    const sockets=this.ctx.getWebSockets();
    for(const socket of sockets) { try{socket.close(1000,'Room ended by host');}catch{} }
    await this.ctx.storage.deleteAll(); this.room=null;
  }

  async startMatch(session, message) {
    if (session.id !== this.room.hostId || this.room.phase !== 'lobby') return;
    if (this.room.players.length < 2) { this.sendToId(session.id, { type: 'error', message: 'Invite at least one operative before starting.' }); return; }
    if (this.room.players.some(player => !player.ready)) { this.sendToId(session.id, { type: 'error', message: 'Wait until every operative is ready.' }); return; }
    const players = this.room.players;
    players.forEach((player, i) => {
      const angle = -Math.PI / 2 + Math.PI * 2 * i / players.length;
      player.alive = true; player.kills = 0; player.pos = { x: Math.cos(angle) * 4.4, y: Math.sin(angle) * 4.4 };
    });
    this.room.mode = message.mode === 'teams' ? 'teams' : 'ffa';
    this.room.game = { mode: this.room.mode, round: 1, seed: this.seed(), moves: {} };
    this.room.phase = 'planning';
    await this.persist();
    this.broadcast({ type: 'match-start', ...this.gameSnapshot(), hostId: this.room.hostId, code: this.room.code });
    this.broadcast(this.roomInfo());
    await this.setAlarmAfter(120_000);
  }

  async submitMove(session, message) {
    if (session.role !== 'player' || this.room.phase !== 'planning' || !this.room.game) return;
    const player = this.room.players.find(entry => entry.id === session.id);
    if (!player?.alive || this.room.game.moves[session.id]) return;
    const x = Number(message.move?.pos?.x), y = Number(message.move?.pos?.y), aim = Number(message.move?.aim);
    if (![x, y, aim].every(Number.isFinite)) return;
    this.room.game.moves[session.id] = {
      pos: { x: Math.max(-20, Math.min(20, x)), y: Math.max(-20, Math.min(20, y)) },
      aim: Math.atan2(Math.sin(aim), Math.cos(aim)),
      weapon: message.move.weapon === 'ricochet' ? 'ricochet' : 'standard',
    };
    const locked = Object.keys(this.room.game.moves).length;
    const total = this.room.players.filter(p => p.alive).length;
    this.broadcast({ type: 'move-count', locked, total, round: this.room.game.round });
    await this.persist();
    if (locked >= total) await this.revealMoves();
  }

  async revealMoves() {
    if (this.room.phase !== 'planning') return;
    this.room.phase = 'revealing'; await this.persist();
    this.broadcast({ type: 'reveal-moves', round: this.room.game.round, moves: this.room.game.moves });
    await this.setAlarmAfter(120_000);
  }

  async resolveRound(session, message) {
    if (session.id !== this.room.hostId || this.room.phase !== 'revealing' || !this.room.game) return;
    for (const update of Array.isArray(message.players) ? message.players : []) {
      const player = this.room.players.find(entry => entry.id === update.id);
      if (!player) continue;
      player.alive = Boolean(update.alive);
      player.kills = Math.max(0, Math.min(999, Number(update.kills) || 0));
      if (Number.isFinite(update.pos?.x) && Number.isFinite(update.pos?.y)) player.pos = { x: update.pos.x, y: update.pos.y };
    }
    const alive = this.room.players.filter(p => p.alive);
    let winner = null;
    if (this.hasWinner(alive)) winner = alive.length ? this.room.mode === 'teams' ? `${alive[0].team.toUpperCase()} TEAM` : alive[0].name : 'DRAW';
    this.room.phase = winner ? 'finished' : 'resolving';
    await this.persist(); await this.ctx.storage.deleteAlarm();
    this.broadcast({ type: 'round-result', players: this.room.players, winner, round: this.room.game.round });
    this.broadcast(this.roomInfo());
    if (!winner) await this.setAlarmAfter(2100);
  }

  async alarm() {
    await this.ready;
    if (!this.room) return;
    if (!this.room.game) {
      if (!this.ctx.getWebSockets().length) { await this.ctx.storage.deleteAll(); this.room = null; return; }
      await this.setAlarmAfter(24 * 60 * 60 * 1000); return;
    }
    if (this.room.phase === 'resolving') {
      this.room.game.round++;
      this.room.game.seed = this.seed(); this.room.game.moves = {};
      this.room.phase = 'planning'; await this.persist();
      this.broadcast({ type: 'round-start', ...this.gameSnapshot(), hostId: this.room.hostId });
      this.broadcast(this.roomInfo()); await this.setAlarmAfter(120_000); return;
    }
    if (this.room.phase === 'planning' || this.room.phase === 'revealing') {
      if (this.room.phase === 'revealing') this.room.phase = 'planning';
      this.room.game.moves = {}; await this.persist();
      this.broadcast({ type: 'turn-timeout', round: this.room.game.round });
      await this.setAlarmAfter(120_000);
    }
  }

  async webSocketClose(ws) { await this.removeSession(ws); }
  async webSocketError(ws) { await this.removeSession(ws); }
  async removeSession(ws) {
    await this.ready;
    if (!this.room) return;
    const session = ws.deserializeAttachment() || {};
    if (session.role === 'player') {
      const player = this.room.players.find(entry => entry.id === session.id);
      if (player && this.room.game) player.alive = false;
      this.room.players = this.room.players.filter(entry => entry.id !== session.id);
      if (this.room.hostId === session.id) { this.room.hostId = this.room.players[0]?.id || null; const host=this.room.players.find(p=>p.id===this.room.hostId);if(host)host.ready=true; }
      if (this.room.phase === 'planning' && this.room.game && Object.keys(this.room.game.moves).length >= this.room.players.filter(p => p.alive).length) await this.revealMoves();
    }
    if (!this.ctx.getWebSockets().length) {
      await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); this.room = null; return;
    }
    await this.persist(); this.broadcast(this.roomInfo());
  }

  hasWinner(alive) { return this.room.mode === 'teams' ? new Set(alive.map(p => p.team)).size <= 1 : alive.length <= 1; }
  seed() { return crypto.getRandomValues(new Uint32Array(1))[0] || 1; }
  async setAlarmAfter(ms) { await this.ctx.storage.setAlarm(Date.now() + ms); }
  async persist() { await this.ctx.storage.put('room', this.room); }
  send(ws, message) { try { ws.send(JSON.stringify(message)); } catch {} }
  sendToId(id, message) {
    for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.id === id) this.send(ws, message);
  }
  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(payload); } catch {} }
  }
  roomInfo() {
    const watchers = this.ctx.getWebSockets().filter(ws => ws.deserializeAttachment()?.role === 'viewer').length;
    return { type: 'room-state', code: this.room.code, hostId: this.room.hostId, players: this.room.players, phase: this.room.phase, mode: this.room.game?.mode || this.room.mode, round: this.room.game?.round || 0, watchers };
  }
  gameSnapshot() {
    return { mode: this.room.game.mode, seed: this.room.game.seed, round: this.room.game.round, phase: this.room.phase, players: this.room.players, moves: this.room.phase === 'revealing' ? this.room.game.moves : undefined, locked: Object.keys(this.room.game.moves).length };
  }
}
