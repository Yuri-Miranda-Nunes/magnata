/* =========================================================================
 * peer.js — Multiplayer P2P com PeerJS (WebRTC), sem servidor próprio
 *
 * Modelo: o HOST é a autoridade única. Clientes só enviam intenções
 * (join, roll-dice, action, disconnect); o host aplica as regras e devolve
 * o ESTADO COMPLETO (update-state) para todos — nunca há estado parcial,
 * então ninguém fica dessincronizado.
 *
 * Protocolo:
 *   join          Cliente → Host   { id, name, color, deadHost? }
 *   players-list  Host → Todos     [ { id, name, color } ]
 *   start-game    Host → Todos     { boardConfig, players, initialMoney }
 *   roll-dice     Cliente → Host   { playerId, diceValues }  (o host sorteia; o valor do cliente é ignorado)
 *   action        Cliente → Host   { playerId, action, data }
 *   update-state  Host → Todos     estado completo do jogo
 *   end-turn      Host → Todos     { nextPlayerId }
 *   disconnect    Qualquer → Host  saída voluntária (o host também avisa todos quando ele sai)
 *   ping / pong   batimento para detectar quedas
 *   redirect/wait resposta de um peer que não é o host (aponta o host / pede para aguardar a eleição)
 * ========================================================================= */
'use strict';

const PEER_PREFIX = 'magnata-tab-';
const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 9000;
const CONNECT_TIMEOUT_MS = 6000;
const MAX_PLAYERS = 8;
const PAWN_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#ec4899', '#14b8a6'];
const SESSION_PREFIX = 'magnata-sessao-';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomCode = n => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

const Net = {
  peer: null,
  myId: null,
  me: { name: '', color: PAWN_COLORS[0] },
  roomCode: null,
  isHost: false,
  hostId: null,
  conns: new Map(),      // host: id do jogador → conexão
  lastSeen: new Map(),   // host: id → última mensagem recebida
  hostConn: null,        // cliente: conexão com o host
  lastHostMsg: 0,
  lobby: [],
  state: null,
  electing: false,
  _pending: null,         // tentativa de conexão em andamento { id, token, fail }

  /* ---------------- Sessão (sobrevive ao refresh) ---------------- */
  // Uma chave por aba (sessionStorage) para permitir vários jogadores no mesmo navegador
  sessionKey() {
    let k = sessionStorage.getItem('magnata-aba');
    if (!k) { k = randomCode(8); sessionStorage.setItem('magnata-aba', k); }
    return SESSION_PREFIX + k;
  },
  save() {
    try {
      localStorage.setItem(this.sessionKey(), JSON.stringify({
        at: Date.now(), myId: this.myId, me: this.me, roomCode: this.roomCode, hostId: this.hostId, lobby: this.lobby, state: this.state,
      }));
    } catch (e) { console.warn('Não foi possível salvar a sessão', e); }
  },
  load() {
    try { return JSON.parse(localStorage.getItem(this.sessionKey())); } catch { return null; }
  },
  clear() { localStorage.removeItem(this.sessionKey()); },
  cleanupOldSessions() {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(SESSION_PREFIX)) continue;
      try { if (Date.now() - JSON.parse(localStorage.getItem(k)).at > 86400000) localStorage.removeItem(k); } catch { localStorage.removeItem(k); }
    }
  },

  /* ---------------- PeerJS ---------------- */
  // Abre o Peer com um ID fixo; após refresh o ID antigo pode demorar a ser liberado
  openPeer(id, maxTries) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const peer = new Peer(id, { debug: 1 });
        peer.on('open', () => { this.peer = peer; this.bindPeer(peer); resolve(peer); });
        peer.on('error', err => {
          if (this.peer === peer) return;
          peer.destroy();
          if (err.type === 'unavailable-id' && ++tries < maxTries) setTimeout(attempt, 1500);
          else reject(err);
        });
      };
      attempt();
    });
  },

  bindPeer(peer) {
    peer.on('connection', conn => this.onIncoming(conn));
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') {
        // A mensagem traz o id do peer; erro atrasado de uma tentativa antiga não derruba a atual
        if (this._pending && String(err.message).includes(this._pending.id)) this._pending.fail();
      }
      else console.warn('PeerJS:', err.type, err);
    });
    // Perdeu o servidor de sinalização: reconecta (as conexões diretas continuam)
    peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1000));
  },

  setMyId(id) { this.myId = id; UI.myId = id; },

  // Código para convidar: o id do host atual sem o prefixo (ex.: ABCDE ou, após troca de host, ABCDE-WXYZ)
  inviteCode() { return this.hostId ? this.hostId.slice(PEER_PREFIX.length) : this.roomCode; },

  /* ---------------- Lobby ---------------- */
  async createRoom() {
    for (let i = 0; i < 5; i++) {
      const code = randomCode(5);
      try {
        await this.openPeer(PEER_PREFIX + code, 1);
        this.roomCode = code;
        this.setMyId(this.peer.id);
        this.isHost = true;
        this.hostId = this.myId;
        this.lobby = [{ id: this.myId, name: this.me.name, color: this.me.color }];
        this.broadcastLobby();
        return;
      } catch (err) {
        if (err.type !== 'unavailable-id') throw err;
      }
    }
    throw new Error('Não foi possível gerar um código de sala.');
  },

  async joinRoom(input) {
    const raw = input.trim();
    const target = raw.startsWith(PEER_PREFIX) ? raw : PEER_PREFIX + raw.toUpperCase();
    this.roomCode = target.slice(PEER_PREFIX.length).split('-')[0];
    await this.openPeer(PEER_PREFIX + this.roomCode + '-' + randomCode(4), 3);
    this.setMyId(this.peer.id);
    if (!(await this.findHost([target], null, false))) {
      this.peer.destroy();
      this.peer = null;
      throw new Error('Sala não encontrada ou indisponível.');
    }
  },

  startGame() {
    if (!this.isHost) return;
    if (this.lobby.length < 2) { UI.toast('São necessários pelo menos 2 jogadores.'); return; }
    const limit = Number(document.getElementById('sel-limit').value);
    this.state = createGame(this.lobby, limit);
    this.broadcast('start-game', { boardConfig: this.state.board, players: this.state.players, initialMoney: this.state.board.initialMoney });
    this.broadcastState();
  },

  leave() {
    if (!this.isHost && this.hostConn && this.hostConn.open) this.hostConn.send({ type: 'disconnect', payload: { id: this.myId } });
    if (this.isHost) this.broadcast('disconnect', { id: this.myId });   // os outros elegem um novo host na hora
    this.clear();
    setTimeout(() => { location.href = location.pathname; }, 300);
  },

  /* ---------------- Envio de ações (qualquer jogador) ---------------- */
  act(action, data = {}) {
    if (this.isHost) { this.hostAct(this.myId, action, data); return; }
    if (!this.hostConn || !this.hostConn.open) { UI.toast('Sem conexão com o host… aguarde.'); return; }
    this.hostConn.send(action === 'roll'
      ? { type: 'roll-dice', payload: { playerId: this.myId, diceValues: null } }
      : { type: 'action', payload: { playerId: this.myId, action, data } });
  },

  /* ================= LADO DO HOST ================= */
  broadcast(type, payload) {
    for (const c of this.conns.values()) if (c.open) c.send({ type, payload });
  },

  sendTo(id, type, payload) {
    if (id === this.myId) { if (type === 'error') UI.toast(payload.message, 4000); return; }
    const c = this.conns.get(id);
    if (c && c.open) c.send({ type, payload });
  },

  broadcastLobby() {
    this.broadcast('players-list', this.lobby);
    this.save();
    UI.renderLobby(this.lobby, true, this.inviteCode());
  },

  // Toda mudança de estado passa por aqui: incrementa a versão e envia o estado completo
  broadcastState(prevTurnId) {
    const s = this.state;
    s.seq++;
    s.hostId = this.myId;
    this.broadcast('update-state', s);
    const next = s.turnos[s.turnoAtual];
    if (prevTurnId !== undefined && next !== prevTurnId && s.phase !== 'gameover') this.broadcast('end-turn', { nextPlayerId: next });
    this.save();
    UI.render(s);
  },

  hostAct(id, action, data = {}) {
    const s = this.state;
    if (!s) return;
    const before = s.turnos[s.turnoAtual];
    const err = applyAction(s, id, action, data);
    if (err) { this.sendTo(id, 'error', { message: err }); return; }
    s.phaseSince = Date.now();
    this.broadcastState(before);
  },

  hostReceive(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = conn.peer;              // identidade vem da conexão, não do conteúdo da mensagem
    const p = msg.payload || {};
    this.lastSeen.set(id, Date.now());
    switch (msg.type) {
      case 'join': this.hostJoin(conn, p); break;
      case 'roll-dice': if (p.playerId === id) this.hostAct(id, 'roll'); break;
      case 'action':
        if (p.playerId === id && typeof p.action === 'string') {
          const data = p.data && Number.isInteger(p.data.idx) ? { idx: p.data.idx } : {};
          this.hostAct(id, p.action, data);
        }
        break;
      case 'disconnect': this.peerGone(id, true); break;
    }
  },

  hostJoin(conn, p) {
    const id = conn.peer;
    const refuse = message => { conn.send({ type: 'error', payload: { message } }); setTimeout(() => conn.close(), 500); };
    if (this.state) {
      // Partida em andamento: só aceita quem já faz parte dela (reconexão)
      const pl = pById(this.state, id);
      if (!pl) { refuse('A partida já começou.'); return; }
      this.conns.set(id, conn);
      if (!pl.conectado) { pl.conectado = true; pl.ausenteMs = 0; log(this.state, `🔌 ${pl.nome} reconectou.`); }
      conn.send({ type: 'start-game', payload: { boardConfig: this.state.board, players: this.state.players, initialMoney: this.state.board.initialMoney } });
      this.broadcastState();
      return;
    }
    let entry = this.lobby.find(x => x.id === id);
    if (!entry) {
      if (this.lobby.length >= MAX_PLAYERS) { refuse('Sala cheia (máximo de 8 jogadores).'); return; }
      entry = { id };
      this.lobby.push(entry);
    }
    entry.name = String(p.name || '').trim().slice(0, 16) || 'Jogador';
    const taken = this.lobby.filter(x => x !== entry).map(x => x.color);
    entry.color = PAWN_COLORS.includes(p.color) && !taken.includes(p.color) ? p.color : PAWN_COLORS.find(c => !taken.includes(c));
    this.conns.set(id, conn);
    this.broadcastLobby();
  },

  // Jogador saiu (explicit = clicou em sair) ou caiu (sem resposta / conexão fechada)
  peerGone(id, explicit) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    this.lastSeen.delete(id);
    if (c) c.close();
    if (this.state) {
      const s = this.state, p = pById(s, id);
      if (!p || p.bancarroto) return;
      const before = s.turnos[s.turnoAtual];
      if (explicit) {
        log(s, `🚪 ${p.nome} saiu da partida.`);
        bankrupt(s, p, null);
      } else if (p.conectado) {
        p.conectado = false;
        p.ausenteMs = 0;
        log(s, `📴 ${p.nome} desconectou — tem ${RECONNECT_GRACE_MS / 1000}s para voltar.`);
      } else return;
      this.broadcastState(before);
    } else {
      // Antes do início: sai da lista (a sala só inicia com 2+ conectados)
      const n = this.lobby.length;
      this.lobby = this.lobby.filter(x => x.id !== id);
      if (this.lobby.length !== n) this.broadcastLobby();
    }
  },

  becomeHost(deadId) {
    const now = Date.now();
    this.isHost = true;
    this.hostId = this.myId;
    this.hostConn = null;
    this.conns = new Map();
    this.lastSeen = new Map();
    if (this.state) {
      const s = hydrate(this.state);
      const dead = deadId && pById(s, deadId);
      s.tickAt = null;   // o tempo passa a ser contado pelo relógio deste host
      if (dead && !dead.bancarroto && this.hostLeft === deadId) {
        log(s, `🚪 ${dead.nome} saiu da partida.`);
        bankrupt(s, dead, null);
      } else if (dead && !dead.bancarroto && dead.conectado) { dead.conectado = false; dead.ausenteMs = 0; }
      // Quem não se conectar ao novo host em PEER_TIMEOUT_MS será marcado como desconectado
      s.players.forEach(p => { if (p.id !== this.myId && p.conectado && !p.bancarroto) this.lastSeen.set(p.id, now); });
      log(s, `👑 ${pById(s, this.myId).nome} assumiu como host.`);
      s.phaseSince = now;
      this.broadcastState();
    } else {
      this.lobby = this.lobby.filter(x => x.id !== deadId);
      this.lobby.forEach(x => { if (x.id !== this.myId) this.lastSeen.set(x.id, now); });
      this.broadcastLobby();
    }
    UI.toast('👑 Você agora é o host da sala.');
  },

  /* ================= LADO DO CLIENTE ================= */
  /**
   * Conecta a um peer e espera a primeira resposta:
   * true = é o host · { redirect } = aponta o host · { wait } = eleição em andamento · false = falhou
   */
  connectTo(id, deadHost = null) {
    return new Promise(resolve => {
      const conn = this.peer.connect(id, { reliable: true, serialization: 'json' });
      let done = false;
      const end = r => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this._pending && this._pending.token === token) this._pending = null;
        if (r !== true) conn.close();
        resolve(r);
      };
      const timer = setTimeout(() => end(false), CONNECT_TIMEOUT_MS);
      const token = {};
      this._pending = { id, token, fail: () => end(false) };
      conn.on('open', () => conn.send({ type: 'join', payload: { id: this.myId, name: this.me.name, color: this.me.color, deadHost } }));
      conn.on('data', msg => {
        if (!msg || typeof msg !== 'object') return;
        if (!done) {
          if (msg.type === 'redirect') return end({ redirect: msg.payload.hostId });
          if (msg.type === 'wait') return end({ wait: true });
          if (msg.type === 'error') { UI.toast(msg.payload.message, 4000); return end(false); }
          if (msg.type === 'ping') return;
          this.hostConn = conn;
          this.hostId = id;
          this.lastHostMsg = Date.now();
          end(true);
        }
        this.onHostData(conn, msg);
      });
      conn.on('close', () => { if (!done) end(false); else if (this.hostConn === conn) this.onHostLost(); });
      conn.on('error', () => end(false));
    });
  },

  /**
   * Procura o host percorrendo os candidatos em ordem (menor posição primeiro).
   * Com allowSelf, ao chegar na própria vez sem achar ninguém antes, assume como host.
   */
  async findHost(ids, deadHost, allowSelf) {
    for (let round = 0; round < 4; round++) {
      const queue = [...ids];
      const tried = new Set();
      while (queue.length) {
        if (this.isHost) return true;
        const id = queue.shift();
        if (id === this.myId) {
          if (allowSelf) { this.becomeHost(deadHost); return true; }
          continue;
        }
        if (!id || tried.has(id)) continue;
        tried.add(id);
        let r = await this.connectTo(id, deadHost);
        // "wait" ou redirect para o host que caiu: o candidato ainda não percebeu a queda.
        // Não pula para o próximo (isso criaria dois hosts); confere o host antigo e insiste no mesmo candidato.
        for (let w = 0; r && (r.wait || (deadHost && r.redirect === deadHost)) && w < 8; w++) {
          if (r.redirect && (await this.connectTo(deadHost)) === true) return true;   // o host antigo ainda responde
          await sleep(1500);
          r = await this.connectTo(id, deadHost);
        }
        if (r === true) return true;
        if (r && r.redirect && r.redirect !== deadHost) queue.unshift(r.redirect);
      }
      await sleep(2500);
    }
    return false;
  },

  onHostData(conn, msg) {
    if (conn !== this.hostConn) return;
    this.lastHostMsg = Date.now();
    const { type, payload } = msg;
    switch (type) {
      case 'players-list':
        this.lobby = payload;
        this.save();
        if (!this.state) UI.renderLobby(this.lobby, false, this.inviteCode());
        break;
      case 'start-game':
        UI.show('game');
        break;
      case 'update-state':
        // Aceita apenas versões mais novas (ou de um novo host/partida)
        if (!this.state || payload.seq > this.state.seq || payload.hostId !== this.state.hostId || payload.startedAt !== this.state.startedAt) {
          this.state = hydrate(payload);
          this.save();
          UI.render(this.state);
        }
        break;
      case 'end-turn':
        break; // informativo: o update-state já traz de quem é a vez
      case 'disconnect':
        // O próprio host saiu de propósito: elege outro já, e o novo host o retira da partida
        if (payload && payload.id === this.hostId) { this.hostLeft = this.hostId; this.onHostLost(); }
        break;
      case 'ping':
        conn.send({ type: 'pong' });
        break;
      case 'error':
        UI.toast(payload.message, 4000);
        break;
    }
  },

  // Host sumiu: elege o jogador conectado de menor posição (ordem de entrada)
  onHostLost() {
    if (this.isHost || this.electing) return;
    this.electing = true;
    const dead = this.hostId;
    const c = this.hostConn;
    this.hostConn = null;
    if (c) c.close();
    const ids = this.state
      ? this.state.players.filter(p => p.conectado && !p.bancarroto).map(p => p.id)
      : this.lobby.map(p => p.id);
    const cands = ids.filter(id => id !== dead);
    UI.toast('⚠️ Host desconectou — elegendo novo host…', 3000);
    this.findHost(cands, dead, true).then(ok => {
      this.electing = false;
      if (!ok && !this.isHost) this.becomeHost(dead);   // ninguém respondeu: segue sozinho
    });
  },

  /* ================= QUALQUER PEER ================= */
  onIncoming(conn) {
    conn.on('data', msg => (this.isHost ? this.hostReceive(conn, msg) : this.nonHostReceive(conn, msg)));
    conn.on('close', () => { if (this.isHost && this.conns.get(conn.peer) === conn) this.peerGone(conn.peer, false); });
  },

  // Recebi uma conexão sem ser host: aponto o host atual ou peço para aguardar a eleição
  nonHostReceive(conn, msg) {
    if (!msg || msg.type !== 'join') return;
    const dead = msg.payload && msg.payload.deadHost;
    if (dead && dead === this.hostId && !this.electing && Date.now() - this.lastHostMsg > 3000) this.onHostLost();
    if (this.isHost) { this.hostReceive(conn, msg); return; }
    const reply = this.electing ? { type: 'wait' }
      : (this.hostConn && this.hostId ? { type: 'redirect', payload: { hostId: this.hostId } } : null);
    if (reply) conn.send(reply);
    setTimeout(() => conn.close(), 300);
  },

  // Relógio: batimentos, detecção de quedas e temporizadores do jogo
  loop() {
    const now = Date.now();
    if (this.isHost) {
      if (now - (this._lastPing || 0) >= HEARTBEAT_MS) { this._lastPing = now; this.broadcast('ping', {}); }
      for (const [id, t] of this.lastSeen) if (now - t > PEER_TIMEOUT_MS) this.peerGone(id, false);
      if (this.state) {
        const before = this.state.turnos[this.state.turnoAtual];
        if (tick(this.state, now)) this.broadcastState(before);
      }
    } else if (this.hostConn && now - this.lastHostMsg > PEER_TIMEOUT_MS) {
      this.onHostLost();
    }
  },

  /* ---------------- Inicialização ---------------- */
  async resume(sess) {
    UI.$('lobby-entry').classList.add('hidden');
    UI.$('lobby-loading').classList.remove('hidden');
    this.me = sess.me;
    this.roomCode = sess.roomCode;
    this.lobby = sess.lobby || [];
    this.state = hydrate(sess.state);
    try {
      await this.openPeer(sess.myId, 10);
    } catch (e) {
      UI.toast('Não foi possível reconectar: ' + (e.type || e.message), 4000);
      this.clear();
      UI.$('lobby-loading').classList.add('hidden');
      UI.$('lobby-entry').classList.remove('hidden');
      return;
    }
    this.setMyId(sess.myId);
    const others = [sess.hostId, ...(this.state ? this.state.players.map(p => p.id) : this.lobby.map(p => p.id))]
      .filter((id, i, a) => id && id !== this.myId && a.indexOf(id) === i);
    if (await this.findHost(others, null, false)) return;
    // Ninguém respondeu: retoma como host com o estado salvo (ou desiste se era só convidado no lobby)
    if (this.state || sess.hostId === this.myId) { this.becomeHost(null); return; }
    UI.toast('A sala não existe mais.', 4000);
    this.clear();
    UI.$('lobby-loading').classList.add('hidden');
    UI.$('lobby-entry').classList.remove('hidden');
  },

  init() {
    UI.bind();
    this.cleanupOldSessions();
    setInterval(() => this.loop(), 1000);

    // Lobby: nome, cor, criar e entrar
    const nameIn = UI.$('in-name'), codeIn = UI.$('in-code');
    nameIn.value = localStorage.getItem('magnata-nome') || '';
    this.me.color = localStorage.getItem('magnata-cor') || PAWN_COLORS[Math.floor(Math.random() * PAWN_COLORS.length)];
    const picker = UI.$('color-picker');
    const drawPicker = () => {
      picker.innerHTML = PAWN_COLORS.map(c => `<button type="button" class="swatch ${c === this.me.color ? 'selected' : ''}" data-color="${c}" style="background:${c}" aria-label="cor ${c}"></button>`).join('');
    };
    drawPicker();
    picker.addEventListener('click', e => {
      const b = e.target.closest('[data-color]');
      if (b) { this.me.color = b.dataset.color; localStorage.setItem('magnata-cor', this.me.color); drawPicker(); }
    });
    const readName = () => {
      const n = nameIn.value.trim().slice(0, 16);
      if (!n) { UI.toast('Digite seu nome.'); nameIn.focus(); return null; }
      localStorage.setItem('magnata-nome', n);
      this.me.name = n;
      return n;
    };
    const busy = (on) => { UI.$('btn-create').disabled = on; UI.$('btn-join').disabled = on; };
    UI.$('btn-create').onclick = async () => {
      if (!readName()) return;
      busy(true);
      try { await this.createRoom(); } catch (e) { UI.toast('Erro ao criar sala: ' + (e.type || e.message), 4000); }
      busy(false);
    };
    UI.$('btn-join').onclick = async () => {
      if (!readName()) return;
      if (!codeIn.value.trim()) { UI.toast('Digite o código da sala.'); codeIn.focus(); return; }
      busy(true);
      UI.$('lobby-status-entry').textContent = 'Conectando…';
      try { await this.joinRoom(codeIn.value); } catch (e) { UI.toast(e.message || e.type, 4000); }
      UI.$('lobby-status-entry').textContent = '';
      busy(false);
    };
    codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') UI.$('btn-join').click(); });
    UI.$('btn-start').onclick = () => this.startGame();
    UI.$('btn-leave').onclick = () => this.leave();
    UI.$('btn-leave-game').onclick = () => { if (confirm('Sair da partida? Seus bens voltam ao banco.')) this.leave(); };
    UI.$('btn-copy').onclick = () => {
      const link = `${location.origin}${location.pathname}?sala=${this.inviteCode()}`;
      navigator.clipboard.writeText(link).then(() => UI.toast('Link copiado!'), () => UI.toast(link, 6000));
    };

    const urlCode = new URLSearchParams(location.search).get('sala');
    if (urlCode) codeIn.value = urlCode;

    const sess = this.load();
    if (sess && sess.myId) this.resume(sess);
  },
};

window.addEventListener('DOMContentLoaded', () => Net.init());
