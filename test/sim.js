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
const G = vm.runInContext('({ generateBoard, createGame, applyAction, tick, currentPlayer, pById, buildCost, autoLiquidate, RECONNECT_GRACE_MS })', ctx);

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
    case 'end': {
      // tenta construir no terreno mais barato possível
      for (const i of [...p.propriedades]) {
        const t = s.board.tiles[i];
        if (t.type === 'property' && t.level < 5 && p.saldo - G.buildCost(t) > reserve) act('build', { idx: i });
      }
      return act('endTurn');
    }
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
  p0.conectado = false; p0.desconectadoEm = Date.now();
  assert(!G.tick(s, Date.now() + 3000), 'não deveria pular a vez logo após a queda (refresh)');
  assert(G.tick(s, Date.now() + 12000), 'deveria pular a vez do desconectado');
  assert.notStrictEqual(G.currentPlayer(s).id, p0.id);
  G.tick(s, Date.now() + G.RECONNECT_GRACE_MS + 5000);
  assert(p0.bancarroto && !s.turnos.includes(p0.id), 'desconectado deveria falir após o prazo');
  checkInvariants(s);
  // limite de tempo encerra a partida
  G.tick(s, s.endsAt + 1);
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
console.log('Todos os testes passaram.');
