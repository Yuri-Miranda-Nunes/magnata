/* Simulação do motor em Node: bots jogam partidas completas e verificamos invariantes.
 * Uso: node test/sim.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Carrega board.js + game.js no mesmo contexto global, como no navegador
const ctx = vm.createContext({ console, Date, Math });
for (const f of ['board.js', 'game.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
const G = vm.runInContext('({ generateBoard, createGame, applyAction, tick, currentPlayer, pById, buildCost, autoLiquidate, RECONNECT_GRACE_MS, CARDS, drawCard, bankrupt, newAnim, land, renameId })', ctx);

function checkInvariants(s) {
  for (const t of s.board.tiles) {
    assert(t.level >= 0 && t.level <= 5, 'nível inválido');
    if (t.owner) assert(G.pById(s, t.owner).propriedades.includes(t.id), `dono inconsistente em ${t.name}`);
    if (t.level > 0) assert(t.owner && !t.mortgage, 'construção sem dono ou hipotecada');
  }
  for (const p of s.players) {
    assert(Number.isFinite(p.saldo) && p.saldo >= 0, `saldo inválido de ${p.nome}: ${p.saldo}`);
    for (const i of p.propriedades) assert.strictEqual(s.board.tiles[i].owner, p.id, 'propriedade sem dono correto');
    assert.strictEqual(s.turnos.includes(p.id), !p.bancarroto, 'fila de turnos inconsistente');
  }
  if (s.phase !== 'gameover') assert(G.currentPlayer(s), 'sem jogador da vez');
}

// Política simples de bot
function botTurn(s) {
  if (s.phase === 'order') return G.applyAction(s, s.orderPending[0], 'rollOrder');
  const p = G.currentPlayer(s);
  const reserve = s.board.initialMoney * 0.15;
  const act = (a, d) => G.applyAction(s, p.id, a, d);
  switch (s.phase) {
    case 'roll':
      if (p.preso && p.cartasSaida) return act('useJailCard');
      return act('roll');
    case 'buy': {
      const t = s.board.tiles[s.pendingBuy];
      return act(p.saldo - t.price > reserve ? 'buy' : 'decline');
    }
    case 'debt':
      G.autoLiquidate(s, p, s.debt.amount);
      return act('payDebt') ? act('bankrupt') : null;
    case 'build': {
      const t = s.board.tiles[s.pendingBuild];
      return act(p.saldo - G.buildCost(t) > reserve ? 'build' : 'skipBuild');
    }
    case 'end':
      return act('endTurn');
  }
  throw new Error('fase inesperada ' + s.phase);
}

function simulate(n, maxTurns = 400) {
  const lobby = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'Bot' + i, color: '#fff' }));
  const s = G.createGame(lobby, 0);
  let actions = 0, turns = 0;
  while (s.phase !== 'gameover' && turns < maxTurns) {
    const before = s.turnos[s.turnoAtual];
    const err = botTurn(s);
    assert(!err || err === null || typeof err === 'string');
    if (err && s.phase !== 'gameover') throw new Error(`Ação recusada inesperadamente: ${err} (fase ${s.phase})`);
    checkInvariants(s);
    JSON.parse(JSON.stringify(s));   // estado precisa ser serializável para a rede
    if (s.turnos[s.turnoAtual] !== before) turns++;
    actions++;
  }
  return { s, turns, actions };
}

// 1) Tabuleiro para cada faixa de jogadores
for (const [n, tiles, sets, salary, money] of [[2, 40, 8, 1500, 15000], [4, 40, 8, 1500, 15000], [5, 52, 11, 2000, 20000], [6, 52, 11, 2000, 20000], [7, 64, 14, 2500, 25000], [8, 64, 14, 2500, 25000]]) {
  const b = G.generateBoard(n);
  assert.strictEqual(b.tiles.length, tiles);
  assert.strictEqual(b.sets, sets);
  assert.strictEqual(b.salary, salary);
  assert.strictEqual(b.initialMoney, money);
  assert.strictEqual(new Set(b.tiles.filter(t => t.colorGroup).map(t => t.colorGroup)).size, sets);
  b.tiles.forEach((t, i) => assert.strictEqual(t.id, i));
}
console.log('✔ tabuleiros 40/52/64 casas corretos');

// 2) Partidas com bots (2, 4, 6 e 8 jogadores). ~200 turnos ≈ 45 min com 8 pessoas (~13 s por turno);
//    o que não acabar por falência é encerrado pelo limite de tempo (maior patrimônio vence).
for (const n of [2, 4, 6, 8]) {
  let ended = 0, totalTurns = 0, survivors = 0;
  const runs = 30;
  for (let r = 0; r < runs; r++) {
    const { s, turns } = simulate(n, 200);
    totalTurns += turns;
    survivors += s.turnos.length;
    if (s.phase === 'gameover') ended++;
  }
  console.log(`✔ ${n} jogadores: ${ended}/${runs} terminaram por falência em até 200 turnos · média ${Math.round(totalTurns / runs)} turnos · ${(survivors / runs).toFixed(1)} sobreviventes em média`);
}

// 3) Desconexão: pula a vez rápido e falência após o prazo de reconexão
{
  const lobby = [0, 1, 2].map(i => ({ id: 'p' + i, name: 'P' + i, color: '#fff' }));
  const s = G.createGame(lobby, 45);
  while (s.phase === 'order') G.applyAction(s, s.orderPending[0], 'rollOrder');
  const p0 = G.currentPlayer(s);
  p0.conectado = false;
  assert(!G.tick(s, Date.now() + 3000), 'não deveria pular a vez logo após a queda (refresh)');
  assert(G.tick(s, Date.now() + 12000), 'deveria pular a vez do desconectado');
  assert.notStrictEqual(G.currentPlayer(s).id, p0.id);
  for (let t = 60000; t <= G.RECONNECT_GRACE_MS + 60000; t += 60000) G.tick(s, Date.now() + 12000 + t);   // host conta o tempo fora a cada tick
  assert(p0.bancarroto && !s.turnos.includes(p0.id), 'desconectado deveria falir após o prazo');
  checkInvariants(s);
  // limite de tempo encerra a partida
  s.elapsedMs = s.timeLimitMs;
  G.tick(s, Date.now() + G.RECONNECT_GRACE_MS + 6000);
  assert.strictEqual(s.phase, 'gameover');
  assert(s.winnerId);
  console.log('✔ desconexão, prazo de reconexão e limite de tempo');
}

// 4) Sorteio da ordem: todos rolam, empates rolam de novo, ordem decrescente pela soma
for (let r = 0; r < 200; r++) {
  const lobby = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, color: '#fff' }));
  const s = G.createGame(lobby, 0);
  assert.strictEqual(s.phase, 'order');
  assert(G.applyAction(s, 'p0', 'roll'), 'não pode rolar normalmente durante o sorteio');
  let guard = 0;
  while (s.phase === 'order' && guard++ < 500) {
    const id = s.orderPending[0];
    assert.strictEqual(G.applyAction(s, id, 'rollOrder'), null);
    if (!s.orderPending.includes(id)) assert(G.applyAction(s, id, 'rollOrder'), 'não pode rolar duas vezes na mesma rodada');
  }
  assert.strictEqual(s.phase, 'roll');
  assert.deepStrictEqual([...s.turnos].sort(), lobby.map(p => p.id).sort());
  for (let i = 1; i < s.turnos.length; i++) {
    const a = s.orderRolls[s.turnos[i - 1]], b = s.orderRolls[s.turnos[i]];
    assert(a[0] >= b[0], 'ordem deve ser decrescente pela primeira rolagem');
    if (a[0] === b[0]) assert(JSON.stringify(a) !== JSON.stringify(b), 'empate não resolvido');
  }
}
console.log('✔ sorteio da ordem com desempate');

// 5) Movimentos registrados para a animação casa a casa
{
  const s = G.createGame([{ id: 'a', name: 'A', color: '#fff' }, { id: 'b', name: 'B', color: '#000' }], 0);
  while (s.phase === 'order') G.applyAction(s, s.orderPending[0], 'rollOrder');
  const p = G.currentPlayer(s), from = p.posicao;
  G.applyAction(s, p.id, 'roll');
  const m = s.anim.moves[0];
  assert(m && m.playerId === p.id && m.from === from && m.steps === s.dice[0] + s.dice[1], 'primeiro movimento deve ser a rolagem');
  console.log('✔ movimentos registrados para animação');
}

// 7) Credor que já faliu não recebe dinheiro nem bens
const started = n => {
  const s = G.createGame(Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, color: '#fff' })), 0);
  while (s.phase === 'order') G.applyAction(s, s.orderPending[0], 'rollOrder');
  return s;
};
{
  const s = started(3);
  const [a, b] = s.turnos.map(id => G.pById(s, id));
  G.bankrupt(s, b, null);
  s.phase = 'debt'; s.debt = { amount: 100, creditorId: b.id };
  assert.strictEqual(G.applyAction(s, a.id, 'payDebt'), null);
  assert.strictEqual(b.saldo, 0, 'credor falido não deve receber');
  const t = s.board.tiles.find(x => x.type === 'property');
  t.owner = a.id; a.propriedades.push(t.id);
  s.phase = 'debt'; s.debt = { amount: 1e9, creditorId: b.id };
  G.applyAction(s, a.id, 'bankrupt');
  assert.strictEqual(t.owner, null, 'bens de quem deve a um falido voltam ao banco');
  assert.strictEqual(b.propriedades.length, 0);
  checkInvariants(s);
  console.log('✔ credor falido não recebe dinheiro nem bens');
}

// 8) "Pague a cada jogador" sem dinheiro abre dívida (jogador escolhe o que vender) e divide ao quitar
{
  const s = started(3);
  const p = G.currentPlayer(s);
  const others = s.turnos.filter(id => id !== p.id).map(id => G.pById(s, id));
  const t = s.board.tiles.filter(x => x.type === 'property').pop();
  t.owner = p.id; p.propriedades.push(t.id);
  p.saldo = 10;
  const before = others.map(o => o.saldo);
  s.decks.chance = [G.CARDS.chance.findIndex(c => c.t === 'each')];
  s.phase = 'moving'; G.newAnim(s);
  G.drawCard(s, p, 'chance');
  assert.strictEqual(s.phase, 'debt', 'deveria abrir a fase de dívida');
  assert.strictEqual(s.debt.splitTo.length, 2);
  assert.strictEqual(t.level, 0); assert(!t.mortgage, 'nada pode ser vendido sem o jogador escolher');
  p.saldo = 1e6;
  assert.strictEqual(G.applyAction(s, p.id, 'payDebt'), null);
  others.forEach((o, i) => assert(o.saldo > before[i], 'cada jogador deveria receber sua parte'));
  console.log('✔ carta "pague a cada jogador" vira dívida dividida');
}

// 9) Habeas Corpus fica fora do baralho enquanto alguém o guarda
{
  const s = started(2);
  const p = G.currentPlayer(s);
  const jail = G.CARDS.chance.findIndex(c => c.t === 'jailCard');
  s.decks.chance = [jail];
  s.phase = 'moving'; G.newAnim(s);
  G.drawCard(s, p, 'chance');
  assert.strictEqual(s.jailCardOut.chance, p.id);
  s.decks.chance = [];
  G.drawCard(s, p, 'chance');                     // força o embaralhamento
  assert(!s.decks.chance.includes(jail), 'Habeas Corpus guardado não pode voltar ao baralho');
  // A segunda carta pode ter movido o jogador; recoloca-o preso e na vez para usar o Habeas Corpus
  p.preso = true; s.phase = 'roll'; s.debt = null; s.turnoAtual = s.turnos.indexOf(p.id);
  assert.strictEqual(G.applyAction(s, p.id, 'useJailCard'), null);
  assert.strictEqual(s.jailCardOut.chance, null, 'ao usar, a carta é liberada');
  console.log('✔ Habeas Corpus fora do baralho enquanto guardado');
}

// 10) Construção: só ao cair de novo na própria propriedade
{
  const s = started(2);
  const p = G.currentPlayer(s);
  const t = s.board.tiles.find(x => x.type === 'property');
  t.owner = p.id; p.propriedades.push(t.id);
  assert(G.applyAction(s, p.id, 'build', { idx: t.id }), 'não pode construir fora da casa');
  p.posicao = t.id; s.phase = 'moving'; G.newAnim(s);
  G.land(s, p);
  assert.strictEqual(s.phase, 'build');
  const saldo = p.saldo;
  assert.strictEqual(G.applyAction(s, p.id, 'build'), null);
  assert.strictEqual(t.level, 1);
  assert.strictEqual(p.saldo, saldo - G.buildCost(t, 0));
  assert(G.applyAction(s, p.id, 'build'), 'só um nível por vez que cai');
  // hipotecada: não oferece construção; com casas: não pode hipotecar
  assert(G.applyAction(s, p.id, 'mortgage', { idx: t.id }), 'não pode hipotecar com casa');
  s.phase = 'end';
  t.level = 0; t.mortgage = true; s.phase = 'moving'; G.land(s, p);
  assert.notStrictEqual(s.phase, 'build');
  checkInvariants(s);
  console.log('✔ construção ao cair de novo na própria propriedade');
}

// 11) Trocas entre jogadores
{
  const s = started(3);
  const [a, b, c] = s.turnos.map(id => G.pById(s, id));
  const props = s.board.tiles.filter(x => x.type === 'property');
  const ta = props[0], tb = props[1];
  ta.owner = a.id; a.propriedades.push(ta.id);
  tb.owner = b.id; b.propriedades.push(tb.id);
  assert(G.applyAction(s, b.id, 'proposeTrade', { to: a.id, give: [tb.id] }), 'só o jogador da vez propõe');
  assert(G.applyAction(s, a.id, 'proposeTrade', { to: b.id, give: [tb.id] }), 'não pode dar o que não é seu');
  assert(G.applyAction(s, a.id, 'proposeTrade', { to: b.id, giveMoney: 1e9 }), 'não pode dar dinheiro que não tem');
  assert(G.applyAction(s, a.id, 'proposeTrade', { to: b.id }), 'proposta vazia');
  assert.strictEqual(G.applyAction(s, a.id, 'proposeTrade', { to: b.id, give: [ta.id], get: [tb.id], giveMoney: 500, getMoney: 0 }), null);
  assert(G.applyAction(s, c.id, 'acceptTrade'), 'só o destinatário aceita');
  const sa = a.saldo, sb = b.saldo;
  assert.strictEqual(G.applyAction(s, b.id, 'acceptTrade'), null);
  assert.strictEqual(ta.owner, b.id); assert.strictEqual(tb.owner, a.id);
  assert.strictEqual(a.saldo, sa - 500); assert.strictEqual(b.saldo, sb + 500);
  assert.strictEqual(s.trade, null);
  checkInvariants(s);
  // com construção não troca; recusa e expiração
  tb.level = 1;
  assert(G.applyAction(s, a.id, 'proposeTrade', { to: b.id, give: [tb.id] }), 'com casas não troca');
  tb.level = 0;
  assert.strictEqual(G.applyAction(s, a.id, 'proposeTrade', { to: c.id, give: [tb.id] }), null);
  assert.strictEqual(G.applyAction(s, c.id, 'rejectTrade'), null);
  assert.strictEqual(tb.owner, a.id);
  assert.strictEqual(G.applyAction(s, a.id, 'proposeTrade', { to: c.id, give: [tb.id] }), null);
  s.phase = 'end';
  G.applyAction(s, a.id, 'endTurn');
  assert.strictEqual(s.trade, null, 'proposta expira ao passar a vez');
  console.log('✔ trocas: validação, aceitar, recusar e expirar');
}

// 12) Volta à partida com outro id (outra guia/aparelho): todas as referências passam ao id novo
{
  let s = started(3);
  const b = G.pById(s, s.turnos[1]);
  const t = s.board.tiles.find(x => x.type === 'property');
  t.owner = b.id; b.propriedades.push(t.id);
  const old = b.id;
  s = G.renameId(s, old, 'novo-id');
  assert(!JSON.stringify(s).includes(JSON.stringify(old)), 'id antigo não pode sobrar');
  assert.strictEqual(s.board.tiles[t.id].owner, 'novo-id');
  assert(s.turnos.includes('novo-id'));
  assert(G.pById(s, 'novo-id').mover, 'jogador continua sendo instância de Player');
  checkInvariants(s);
  console.log('✔ volta à partida com id novo');
}

// 6) Ações fora da vez são recusadas
{
  const s = G.createGame([{ id: 'a', name: 'A', color: '#fff' }, { id: 'b', name: 'B', color: '#000' }], 0);
  while (s.phase === 'order') G.applyAction(s, s.orderPending[0], 'rollOrder');
  const [first, second] = s.turnos;
  assert(G.applyAction(s, second, 'roll'), 'jogador fora da vez não pode rolar');
  assert(G.applyAction(s, 'x', 'roll'), 'jogador desconhecido não pode agir');
  assert(G.applyAction(s, first, 'endTurn'), 'não pode encerrar antes de rolar');
  console.log('✔ validação de vez e fase');
}
// 13) Transporte: mensagens grandes são divididas em pedaços abaixo do limite do canal e remontadas iguais
{
  const pctx = vm.createContext({ console, window: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'peer.js'), 'utf8'), pctx, { filename: 'peer.js' });
  const wire = vm.runInContext('wire', pctx);
  const sent = [], got = [];
  const conn = {
    h: {},
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); },
    emit(e, x) { (this.h[e] || []).forEach(f => f(x)); },
    send(x) { sent.push(JSON.parse(JSON.stringify(x))); },
  };
  wire(conn);
  conn.on('msg', m => got.push(m));
  const s = G.createGame(Array.from({ length: 8 }, (_, i) => ({ id: 'magnata-tab-ABCDE-' + i, name: 'Jogador ção 🎲' + i, color: '#fff' })), 45);
  const big = { type: 'update-state', payload: s };
  conn.send(big);
  assert(sent.length > 1, 'mensagem grande deveria ser dividida');
  for (const c of sent) assert(Buffer.byteLength(JSON.stringify(c)) < 16300, 'pedaço acima do limite do canal');
  sent.forEach(c => conn.emit('data', c));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(JSON.stringify(got[0]), JSON.stringify(big));   // compara conteúdo (objetos vêm de outro contexto vm)
  conn.emit('data', { k: 'p', i: 0, n: 1, d: '{quebrado' });          // lixo é ignorado sem erro
  conn.emit('data', 'texto solto');
  assert.strictEqual(got.length, 1);
  console.log(`✔ transporte: ${sent.length} pedaços < 16 KB, remontagem idêntica`);
}

console.log('Todos os testes passaram.');
