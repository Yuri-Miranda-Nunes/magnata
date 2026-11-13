/* =========================================================================
 * game.js — Regras do jogo e interface
 * As regras (motor) rodam SOMENTE no Host, que é a autoridade única.
 * Os clientes apenas recebem o estado completo e desenham a tela.
 * ========================================================================= */
'use strict';

const TURN_TIMEOUT_MS = 60000;     // jogador conectado e inativo: ação automática
const AWAY_SKIP_MS = 10000;        // jogador desconectado: pula a vez (dá tempo de um refresh voltar)
const RECONNECT_GRACE_MS = 180000; // tempo para voltar após queda antes de falir
const LOG_MAX = 80;
const MAX_JAIL_TURNS = 3;

/* ------------------------------ Jogador ------------------------------ */
class Player {
  constructor(data = {}) {
    this.id = null;
    this.nome = '';
    this.corPeao = '#fff';
    this.saldo = 0;
    this.posicao = 0;
    this.propriedades = [];   // índices das casas possuídas
    this.bancarroto = false;
    this.preso = false;
    this.turnosPreso = 0;
    this.cartasSaida = 0;     // cartas "Habeas Corpus"
    this.conectado = true;
    this.ausenteMs = 0;       // tempo desconectado, contado pelo host
    Object.assign(this, data);
  }

  // Move o peão; devolve true se passou pelo Início
  mover(rolagem, totalCasas) {
    const antes = this.posicao;
    this.posicao = ((this.posicao + rolagem) % totalCasas + totalCasas) % totalCasas;
    return rolagem > 0 && this.posicao < antes;
  }

  receberSalario(valor) { this.saldo += valor; }

  // Paga se tiver saldo; devolve false caso contrário (sem saldo negativo)
  pagar(valor) {
    if (this.saldo < valor) return false;
    this.saldo -= valor;
    return true;
  }

  // Marca falência e devolve as propriedades para serem repassadas
  declararFalencia() {
    const props = this.propriedades;
    this.bancarroto = true;
    this.saldo = 0;
    this.propriedades = [];
    this.preso = false;
    return props;
  }
}

/* ------------------------------ Cartas ------------------------------ */
// t: tipo do efeito · v: valor em R$ (escalado pelo tamanho do tabuleiro) · n: casas
const CARDS = {
  chance: [
    { t: 'goto', to: 'start', text: 'Avance até o Início e receba o salário.' },
    { t: 'jail', text: 'Vá direto para a prisão, sem passar pelo Início.' },
    { t: 'move', n: 3, text: 'Avance 3 casas.' },
    { t: 'move', n: -3, text: 'Volte 3 casas.' },
    { t: 'goto', to: 'rail', text: 'Avance até a estação mais próxima.' },
    { t: 'goto', to: 'priciest', text: 'Faça uma visita à propriedade mais valiosa do tabuleiro.' },
    { t: 'money', v: 1500, text: 'Você ganhou na loteria! Receba {v}.' },
    { t: 'money', v: -500, text: 'Multa por excesso de velocidade: pague {v}.' },
    { t: 'money', v: 1000, text: 'Seu investimento rendeu. Receba {v}.' },
    { t: 'extra', text: 'Turno extra! Jogue os dados novamente.' },
    { t: 'jailCard', text: 'Habeas Corpus: guarde esta carta para sair da prisão.' },
    { t: 'repairs', h: 250, H: 1000, text: 'Reforma geral: pague {h} por casa e {H} por hotel.' },
    { t: 'each', v: -250, text: 'Você foi eleito síndico: pague {v} a cada jogador.' },
    { t: 'move', n: 5, text: 'Avance 5 casas.' },
    { t: 'move', n: -2, text: 'Volte 2 casas.' },
    { t: 'goto', to: 'parking', text: 'Vá passear na Praça Livre.' },
  ],
  community: [
    { t: 'money', v: 2000, text: 'Erro do banco a seu favor. Receba {v}.' },
    { t: 'money', v: -500, text: 'Honorários médicos: pague {v}.' },
    { t: 'money', v: 500, text: 'Venda de ações: receba {v}.' },
    { t: 'jailCard', text: 'Habeas Corpus: guarde esta carta para sair da prisão.' },
    { t: 'jail', text: 'Vá direto para a prisão.' },
    { t: 'each', v: 200, text: 'É seu aniversário! Receba {v} de cada jogador.' },
    { t: 'money', v: 400, text: 'Restituição do imposto de renda: receba {v}.' },
    { t: 'money', v: 1000, text: 'Seu seguro de vida venceu. Receba {v}.' },
    { t: 'money', v: -1000, text: 'Mensalidade escolar: pague {v}.' },
    { t: 'money', v: 250, text: 'Serviço de consultoria: receba {v}.' },
    { t: 'repairs', h: 400, H: 1150, text: 'Reparos na rua: pague {h} por casa e {H} por hotel.' },
    { t: 'money', v: 300, text: 'Segundo lugar no concurso de jardinagem: receba {v}.' },
    { t: 'money', v: 1000, text: 'Você recebeu uma herança. Receba {v}.' },
    { t: 'goto', to: 'start', text: 'Avance até o Início e receba o salário.' },
    { t: 'money', v: -1000, text: 'Conta do hospital: pague {v}.' },
    { t: 'extra', text: 'Turno extra! Jogue os dados novamente.' },
  ],
};
const DECK_LABEL = { chance: 'Sorte', community: 'Cofre Comunitário' };

/* ------------------------------ Utilitários ------------------------------ */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const d6 = () => 1 + Math.floor(Math.random() * 6);
const tileAt = (s, i) => s.board.tiles[i];
const pById = (s, id) => s.players.find(p => p.id === id);
const currentPlayer = s => pById(s, s.turnos[s.turnoAtual]);
const groupTiles = (s, g) => s.board.tiles.filter(t => t.colorGroup === g);
const ownsGroup = (s, ownerId, g) => groupTiles(s, g).every(t => t.owner === ownerId);
const buildCost = (t, level = t.level) => round10(t.houseCost * (1 + 0.25 * level)); // custo crescente por nível
const mortgageValue = t => round10(t.price / 2);
const unmortgageCost = t => round10(t.price * 0.55);
const jailFine = s => round10(500 * s.board.factor);

// Credita um jogador; credor que já faliu não recebe (o valor volta ao banco)
function credit(s, id, amount) {
  const c = id ? pById(s, id) : null;
  if (c && !c.bancarroto) c.saldo += amount;
}

function log(s, msg) {
  s.log.push({ t: Date.now(), msg });
  if (s.log.length > LOG_MAX) s.log.shift();
}

// Troca o id de um jogador em todo o estado (volta à partida por outra aba ou aparelho).
// Os ids são strings únicas entre aspas no JSON, então a troca exata do token é segura.
function renameId(s, oldId, newId) {
  const json = JSON.stringify(s).split(JSON.stringify(oldId)).join(JSON.stringify(newId));
  return hydrate(JSON.parse(json));
}

// Recria as instâncias de Player depois de receber o estado pela rede (JSON)
function hydrate(s) {
  if (s) s.players = s.players.map(p => (p instanceof Player ? p : new Player(p)));
  return s;
}

// Quanto o jogador conseguiria levantar vendendo construções e hipotecando tudo
function liquidationValue(s, p) {
  return p.propriedades.reduce((sum, i) => {
    const t = tileAt(s, i);
    let v = t.mortgage ? 0 : mortgageValue(t);
    for (let l = 0; l < t.level; l++) v += round10(buildCost(t, l) / 2);
    return sum + v;
  }, 0);
}

function netWorth(s, p) {
  return p.saldo + p.propriedades.reduce((sum, i) => {
    const t = tileAt(s, i);
    let v = t.mortgage ? mortgageValue(t) : t.price;
    for (let l = 0; l < t.level; l++) v += buildCost(t, l);
    return sum + v;
  }, 0);
}

function calcRent(s, t) {
  if (t.type === 'property') return t.level ? t.rent[t.level] : t.rent[0] * (ownsGroup(s, t.owner, t.colorGroup) ? 2 : 1);
  const n = s.board.tiles.filter(x => x.type === t.type && x.owner === t.owner).length;
  if (t.type === 'railroad') return t.rent[n - 1];
  return (s.dice[0] + s.dice[1]) * t.rent[n - 1];   // companhia: dados × multiplicador
}

/* ------------------------------ Criação da partida ------------------------------ */
function createGame(lobby, timeLimitMin = 45) {
  const board = generateBoard(lobby.length);
  const players = lobby.map(p => new Player({ id: p.id, nome: p.name, corPeao: p.color, saldo: board.initialMoney }));
  const now = Date.now();
  const s = {
    seq: 0, hostId: null, board, players,
    turnos: players.map(p => p.id),   // fila cíclica de turnos
    turnoAtual: 0,                    // índice em turnos[]
    phase: 'order',                   // order | roll | moving | buy | debt | end | gameover
    orderRolls: {},                   // id → somas tiradas no sorteio da ordem (uma por rodada de desempate)
    orderPending: players.map(p => p.id),
    dice: [1, 1], rollSeq: 0, doublesCount: 0, extraRoll: false,
    pendingBuy: null, pendingBuild: null, trade: null, debt: null, lastCard: null, winnerId: null,
    jailCardOut: { chance: null, community: null },   // quem guarda o Habeas Corpus de cada baralho
    anim: { seq: 0, moves: [] },      // movimentos da última ação, para a animação casa a casa
    decks: { chance: shuffle([...CARDS.chance.keys()]), community: shuffle([...CARDS.community.keys()]) },
    log: [], startedAt: now, phaseSince: now,
    // Tempo medido em duração (somado pelo host a cada tick), não em horário: relógios diferem entre máquinas
    timeLimitMs: timeLimitMin > 0 ? timeLimitMin * 60000 : 0, elapsedMs: 0, tickAt: null,
  };
  log(s, `Partida iniciada com ${players.length} jogadores — tabuleiro de ${board.size} casas e ${board.sets} conjuntos.`);
  log(s, '🎲 Todos rolam os dados: quem tirar mais começa.');
  return s;
}

/* ------------------------------ Sorteio da ordem ------------------------------ */
function rollOrder(s, p) {
  if (s.phase !== 'order' || !s.orderPending.includes(p.id)) return 'Você já rolou para o sorteio da ordem.';
  const d = [d6(), d6()];
  s.dice = d;
  s.rollSeq++;
  (s.orderRolls[p.id] = s.orderRolls[p.id] || []).push(d[0] + d[1]);
  s.orderPending = s.orderPending.filter(id => id !== p.id);
  log(s, `🎲 ${p.nome} tirou ${d[0]} + ${d[1]} = ${d[0] + d[1]} no sorteio da ordem.`);
  if (!s.orderPending.length) resolveOrder(s);
  return null;
}

// Ordena pelos resultados; quem empatou (mesmo histórico de rolagens) rola de novo
function resolveOrder(s) {
  const key = id => JSON.stringify(s.orderRolls[id]);
  const groups = {};
  s.turnos.forEach(id => { (groups[key(id)] = groups[key(id)] || []).push(id); });
  const tied = Object.values(groups).filter(g => g.length > 1).flat();
  if (tied.length) {
    s.orderPending = tied;
    log(s, `Empate entre ${tied.map(id => pById(s, id).nome).join(', ')} — rolem de novo.`);
    return;
  }
  const cmp = (a, b) => {
    const ra = s.orderRolls[a], rb = s.orderRolls[b];
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      const d = (rb[i] ?? -1) - (ra[i] ?? -1);
      if (d) return d;
    }
    return 0;
  };
  s.turnos.sort(cmp);
  s.turnoAtual = 0;
  log(s, `📋 Ordem definida: ${s.turnos.map(id => pById(s, id).nome).join(' → ')}.`);
  startTurn(s);
}

/* ------------------------------ Turnos ------------------------------ */
function startTurn(s) {
  s.doublesCount = 0;
  s.extraRoll = false;
  s.pendingBuy = null;
  s.pendingBuild = null;
  s.debt = null;
  if (s.trade) log(s, 'A proposta de troca expirou.');
  s.trade = null;
  s.phase = 'roll';
  s.phaseSince = Date.now();
  const p = currentPlayer(s);
  log(s, `▶ Vez de ${p.nome}${p.preso ? ' (na prisão)' : ''}.`);
}

function nextTurn(s) {
  s.turnoAtual = (s.turnoAtual + 1) % s.turnos.length;
  startTurn(s);
}

// Termina a resolução da jogada: dupla dá direito a jogar de novo
function finish(s) { s.phase = s.extraRoll ? 'roll' : 'end'; }

function removeFromTurns(s, id) {
  const i = s.turnos.indexOf(id);
  if (i < 0) return;
  if (s.phase === 'order') {
    s.turnos.splice(i, 1);
    s.orderPending = s.orderPending.filter(x => x !== id);
    delete s.orderRolls[id];
    if (!checkWinner(s) && !s.orderPending.length) resolveOrder(s);
    return;
  }
  const wasCurrent = i === s.turnoAtual;
  s.turnos.splice(i, 1);
  if (i < s.turnoAtual) s.turnoAtual--;
  if (s.turnoAtual >= s.turnos.length) s.turnoAtual = 0;
  if (checkWinner(s)) return;
  if (wasCurrent) startTurn(s);
}

function checkWinner(s) {
  if (s.turnos.length > 1) return false;
  s.winnerId = s.turnos[0] || null;
  s.phase = 'gameover';
  const w = pById(s, s.winnerId);
  log(s, `🏆 ${w ? w.nome : 'Ninguém'} venceu a partida!`);
  return true;
}

// Fim por tempo: vence o maior patrimônio entre os sobreviventes
function endByTime(s) {
  const alive = s.turnos.map(id => pById(s, id));
  const best = alive.reduce((a, b) => (netWorth(s, b) > netWorth(s, a) ? b : a));
  s.winnerId = best.id;
  s.phase = 'gameover';
  log(s, `⏰ Tempo esgotado! ${best.nome} vence com patrimônio de ${fmt(netWorth(s, best))}.`);
}

/* ------------------------------ Movimento e casas ------------------------------ */
// Cada ação começa uma nova lista de movimentos para os clientes animarem
function newAnim(s) { s.anim = { seq: (s.anim ? s.anim.seq : 0) + 1, moves: [] }; }

function sendToJail(s, p) {
  s.anim.moves.push({ playerId: p.id, to: s.board.jailIndex, jump: true });
  p.posicao = s.board.jailIndex;
  p.preso = true;
  p.turnosPreso = 0;
  s.extraRoll = false;
  s.doublesCount = 0;
  log(s, `🚓 ${p.nome} foi para a prisão.`);
}

function moveBy(s, p, steps) {
  s.anim.moves.push({ playerId: p.id, from: p.posicao, steps });
  if (p.mover(steps, s.board.size)) {
    p.receberSalario(s.board.salary);
    log(s, `${p.nome} passou pelo Início e recebeu ${fmt(s.board.salary)}.`);
  }
  land(s, p);
}

function land(s, p) {
  const t = tileAt(s, p.posicao);
  log(s, `${p.nome} caiu em ${t.name}.`);
  if (t.type === 'property' || t.type === 'railroad' || t.type === 'utility') {
    if (t.owner === null) { s.pendingBuy = t.id; s.phase = 'buy'; return; }
    if (t.owner === p.id) {
      // Caiu de novo na própria propriedade: pode construir um nível (casa → hotel)
      if (t.type === 'property' && !t.mortgage && t.level < 5) { s.pendingBuild = t.id; s.phase = 'build'; }
      return;
    }
    if (t.mortgage) return;
    const owner = pById(s, t.owner);
    const rent = calcRent(s, t);
    log(s, `${p.nome} deve ${fmt(rent)} de aluguel a ${owner.nome}.`);
    charge(s, p, rent, owner.id);
  } else if (t.type === 'tax') {
    log(s, `${p.nome} deve ${fmt(t.price)} de ${t.name}.`);
    charge(s, p, t.price, null);
  } else if (t.type === 'chance' || t.type === 'community') {
    drawCard(s, p, t.type);
  } else if (t.corner === 'gotojail') {
    sendToJail(s, p);
  }
}

/* ------------------------------ Dinheiro, dívidas e falência ------------------------------ */
// Cobrança do jogador da vez: se faltar dinheiro, abre a fase de dívida
function charge(s, p, amount, creditorId) {
  if (p.pagar(amount)) {
    credit(s, creditorId, amount);
    return true;
  }
  if (p.saldo + liquidationValue(s, p) < amount) {
    log(s, `${p.nome} não tem patrimônio suficiente para pagar ${fmt(amount)}.`);
    bankrupt(s, p, creditorId);
    return false;
  }
  s.debt = { amount, creditorId };
  s.phase = 'debt';
  log(s, `⚠️ ${p.nome} precisa levantar ${fmt(amount)} (vender/hipotecar) ou declarar falência.`);
  return false;
}

// Cobrança forçada (fora da vez ou fiança): liquida bens automaticamente
function forceCharge(s, p, amount, creditorId) {
  if (p.saldo < amount) autoLiquidate(s, p, amount);
  if (p.pagar(amount)) {
    credit(s, creditorId, amount);
    return true;
  }
  bankrupt(s, p, creditorId);
  return false;
}

function sellLevel(s, p, t) {
  const refund = round10(buildCost(t, t.level - 1) / 2);
  t.level--;
  p.saldo += refund;
  log(s, `${p.nome} vendeu uma construção em ${t.name} por ${fmt(refund)}.`);
}

function mortgageTile(s, p, t) {
  t.mortgage = true;
  p.saldo += mortgageValue(t);
  log(s, `${p.nome} hipotecou ${t.name} por ${fmt(mortgageValue(t))}.`);
}

// Vende construções (maiores primeiro) e hipoteca (mais baratas primeiro) até cobrir o valor
function autoLiquidate(s, p, amount) {
  const mine = () => p.propriedades.map(i => tileAt(s, i));
  while (p.saldo < amount) {
    const built = mine().filter(t => t.level > 0).sort((a, b) => b.level - a.level)[0];
    if (built) { sellLevel(s, p, built); continue; }
    const free = mine().filter(t => !t.mortgage).sort((a, b) => a.price - b.price)[0];
    if (!free) break;
    mortgageTile(s, p, free);
  }
}

function bankrupt(s, p, creditorId) {
  let cred = creditorId ? pById(s, creditorId) : null;
  if (cred && cred.bancarroto) cred = null;   // credor já saiu do jogo: bens voltam ao banco
  // O dinheiro que sobrou vai para o credor; os terrenos sempre voltam livres ao tabuleiro
  log(s, `💀 ${p.nome} faliu — os terrenos voltam ao tabuleiro${cred && p.saldo > 0 ? ` e ${fmt(p.saldo)} vão para ${cred.nome}` : ''}.`);
  if (cred) cred.saldo += p.saldo;
  const wasCurrent = currentPlayer(s) === p;
  for (const d of Object.keys(s.jailCardOut || {})) if (s.jailCardOut[d] === p.id) s.jailCardOut[d] = null;
  for (const i of p.declararFalencia()) Object.assign(tileAt(s, i), { owner: null, level: 0, mortgage: false });
  if (wasCurrent) { s.debt = null; s.pendingBuy = null; s.pendingBuild = null; }
  if (s.trade && (s.trade.from === p.id || s.trade.to === p.id)) s.trade = null;
  removeFromTurns(s, p.id);
}

/* ------------------------------ Cartas ------------------------------ */
function drawCard(s, p, deck) {
  s.jailCardOut = s.jailCardOut || { chance: null, community: null };
  if (!s.decks[deck].length) {
    s.decks[deck] = shuffle([...CARDS[deck].keys()].filter(k => !(CARDS[deck][k].t === 'jailCard' && s.jailCardOut[deck])));
  }
  const card = CARDS[deck][s.decks[deck].shift()];
  const scale = v => round10((v || 0) * s.board.factor);
  const v = scale(card.v);
  const text = card.text.replace('{v}', fmt(Math.abs(v))).replace('{h}', fmt(scale(card.h))).replace('{H}', fmt(scale(card.H)));
  s.lastCard = { deck, text, playerId: p.id, seq: (s.lastCard ? s.lastCard.seq : 0) + 1 };
  log(s, `🃏 ${p.nome} tirou ${DECK_LABEL[deck]}: "${text}"`);
  const N = s.board.size;
  switch (card.t) {
    case 'money':
      if (v >= 0) p.saldo += v; else charge(s, p, -v, null);
      break;
    case 'move':
      moveBy(s, p, card.n);
      break;
    case 'goto': {
      let target = 0;
      if (card.to === 'parking') target = s.board.parkingIndex;
      if (card.to === 'rail') target = [...Array(N).keys()].map(k => (p.posicao + 1 + k) % N).find(i => tileAt(s, i).type === 'railroad');
      if (card.to === 'priciest') target = s.board.tiles.reduce((a, t) => (t.price > a.price && t.type === 'property' ? t : a)).id;
      moveBy(s, p, (target - p.posicao + N) % N || (target === 0 ? N : 0));
      break;
    }
    case 'jail':
      sendToJail(s, p);
      break;
    case 'jailCard':
      p.cartasSaida++;
      s.jailCardOut[deck] = p.id;
      break;
    case 'extra':
      s.extraRoll = true;
      break;
    case 'each': {
      const others = s.turnos.map(id => pById(s, id)).filter(o => o !== p);
      if (v > 0) {
        // Os outros pagam fora da vez: liquidação automática se faltar dinheiro
        for (const o of others) {
          forceCharge(s, o, v, p.id);
          if (s.phase === 'gameover') break;
        }
      } else if (charge(s, p, -v * others.length, null)) {
        others.forEach(o => credit(s, o.id, -v));
      } else if (s.phase === 'debt') {
        Object.assign(s.debt, { splitTo: others.map(o => o.id), each: -v });   // ao quitar, divide entre eles
      }
      break;
    }
    case 'repairs': {
      const props = p.propriedades.map(i => tileAt(s, i));
      const cost = props.reduce((sum, t) => sum + (t.level === 5 ? scale(card.H) : t.level * scale(card.h)), 0);
      if (cost > 0) charge(s, p, cost, null);
      break;
    }
  }
}

/* ------------------------------ Trocas entre jogadores ------------------------------ */
const TRADABLE = ['property', 'railroad', 'utility'];

// Normaliza a proposta vinda da rede (fronteira de confiança)
function readTrade(fromId, d) {
  const ints = a => (Array.isArray(a) ? [...new Set(a.filter(Number.isInteger))].slice(0, 64) : []);
  const money = v => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : 0);
  return { from: fromId, to: String(d.to || ''), give: ints(d.give), get: ints(d.get), giveMoney: money(d.giveMoney), getMoney: money(d.getMoney) };
}

function tradeError(s, tr) {
  const from = pById(s, tr.from), to = pById(s, tr.to);
  if (!from || !to || from === to || from.bancarroto || to.bancarroto) return 'Escolha outro jogador para negociar.';
  const ok = (ids, owner) => ids.every(i => {
    const t = tileAt(s, i);
    return t && TRADABLE.includes(t.type) && t.owner === owner.id && t.level === 0;
  });
  if (!ok(tr.give, from) || !ok(tr.get, to)) return 'Só dá para trocar propriedades do próprio dono e sem construções.';
  if (!tr.give.length && !tr.get.length && !tr.giveMoney && !tr.getMoney) return 'A proposta está vazia.';
  if (from.saldo < tr.giveMoney) return `${from.nome} não tem ${fmt(tr.giveMoney)}.`;
  if (to.saldo < tr.getMoney) return `${to.nome} não tem ${fmt(tr.getMoney)}.`;
  return null;
}

function doTrade(s, tr) {
  const from = pById(s, tr.from), to = pById(s, tr.to);
  const move = (ids, a, b) => ids.forEach(i => {
    tileAt(s, i).owner = b.id;
    a.propriedades = a.propriedades.filter(x => x !== i);
    b.propriedades.push(i);
  });
  move(tr.give, from, to);
  move(tr.get, to, from);
  from.saldo += tr.getMoney - tr.giveMoney;
  to.saldo += tr.giveMoney - tr.getMoney;
  const desc = (ids, m) => [...ids.map(i => tileAt(s, i).name), ...(m ? [fmt(m)] : [])].join(', ') || 'nada';
  log(s, `🤝 Troca: ${from.nome} deu ${desc(tr.give, tr.giveMoney)} e recebeu ${desc(tr.get, tr.getMoney)} de ${to.nome}.`);
}

// Ações de troca: o jogador da vez propõe; o outro aceita ou recusa (mesmo fora da vez dele)
function tradeAction(s, p, action, data) {
  const tr = s.trade;
  switch (action) {
    case 'proposeTrade': {
      if (currentPlayer(s) !== p) return 'Só o jogador da vez pode propor trocas.';
      if (!['roll', 'end', 'debt'].includes(s.phase)) return 'Termine a decisão atual antes de negociar.';
      if (tr) return 'Já existe uma proposta aguardando resposta.';
      const nt = readTrade(p.id, data);
      const err = tradeError(s, nt);
      if (err) return err;
      s.trade = nt;
      log(s, `🤝 ${p.nome} fez uma proposta de troca para ${pById(s, nt.to).nome}.`);
      return null;
    }
    case 'cancelTrade':
      if (!tr || tr.from !== p.id) return 'Não há proposta sua para cancelar.';
      s.trade = null;
      log(s, `${p.nome} cancelou a proposta de troca.`);
      return null;
    case 'rejectTrade':
      if (!tr || tr.to !== p.id) return 'Não há proposta para você.';
      s.trade = null;
      log(s, `${p.nome} recusou a troca.`);
      return null;
    case 'acceptTrade': {
      if (!tr || tr.to !== p.id) return 'Não há proposta para você.';
      const err = tradeError(s, tr);
      s.trade = null;
      if (err) { log(s, `Troca cancelada: ${err}`); return null; }   // null: o cancelamento precisa ser transmitido
      doTrade(s, tr);
      return null;
    }
  }
  return 'Ação desconhecida.';
}

/* ------------------------------ Ações dos jogadores ------------------------------ */
function doRoll(s, p) {
  if (s.phase !== 'roll') return 'Não é hora de rolar os dados.';
  const d = [d6(), d6()], sum = d[0] + d[1], dbl = d[0] === d[1];
  s.dice = d;
  s.rollSeq++;
  s.extraRoll = false;
  log(s, `🎲 ${p.nome} rolou ${d[0]} + ${d[1]} = ${sum}${dbl ? ' (dupla!)' : ''}.`);
  if (p.preso) {
    if (dbl) {
      p.preso = false; p.turnosPreso = 0;
      log(s, `${p.nome} tirou dupla e saiu da prisão.`);
    } else if (++p.turnosPreso >= MAX_JAIL_TURNS) {
      if (!forceCharge(s, p, jailFine(s), null)) return null;   // faliu na fiança
      p.preso = false; p.turnosPreso = 0;
      log(s, `${p.nome} cumpriu ${MAX_JAIL_TURNS} turnos, pagou ${fmt(jailFine(s))} e saiu da prisão.`);
    } else {
      log(s, `${p.nome} continua preso (${p.turnosPreso}/${MAX_JAIL_TURNS}).`);
      s.phase = 'end';
      return null;
    }
  } else if (dbl) {
    if (++s.doublesCount >= 3) {
      log(s, `Três duplas seguidas!`);
      sendToJail(s, p);
      s.phase = 'end';
      return null;
    }
    s.extraRoll = true;
  }
  s.phase = 'moving';
  moveBy(s, p, sum);
  if (s.phase === 'moving') finish(s);
  return null;
}

/**
 * Ponto único de entrada das ações (somente o Host chama).
 * Devolve null em caso de sucesso ou uma mensagem de erro.
 */
function applyAction(s, playerId, action, data = {}) {
  if (s.phase === 'gameover') return 'A partida terminou.';
  const p = pById(s, playerId);
  if (!p || p.bancarroto) return 'Jogador inválido.';
  newAnim(s);
  if (action === 'rollOrder') return rollOrder(s, p);
  if (s.phase === 'order') return 'Aguarde o sorteio da ordem terminar.';
  if (action.endsWith('Trade')) return tradeAction(s, p, action, data);
  if (currentPlayer(s) !== p) return 'Aguarde a sua vez.';
  const t = Number.isInteger(data.idx) ? tileAt(s, data.idx) : null;
  const mineOk = t && t.owner === p.id;

  switch (action) {
    case 'roll':
      return doRoll(s, p);

    case 'buy': {
      if (s.phase !== 'buy') return 'Nada para comprar agora.';
      const b = tileAt(s, s.pendingBuy);
      if (!p.pagar(b.price)) return 'Saldo insuficiente — hipoteque algo ou recuse.';
      b.owner = p.id;
      p.propriedades.push(b.id);
      log(s, `🏷️ ${p.nome} comprou ${b.name} por ${fmt(b.price)}.`);
      s.pendingBuy = null;
      finish(s);
      return null;
    }

    case 'decline':
      if (s.phase !== 'buy') return 'Nada para recusar.';
      log(s, `${p.nome} não comprou ${tileAt(s, s.pendingBuy).name}.`);
      s.pendingBuy = null;
      finish(s);
      return null;

    case 'build': {
      if (s.phase !== 'build') return 'Para construir, caia de novo na sua propriedade.';
      const b = tileAt(s, s.pendingBuild);
      const c = buildCost(b);
      if (!p.pagar(c)) return 'Saldo insuficiente para construir.';
      b.level++;
      log(s, `🏗️ ${p.nome} construiu ${b.level === 5 ? 'um hotel' : 'uma casa'} em ${b.name} (${fmt(c)}).`);
      s.pendingBuild = null;
      finish(s);
      return null;
    }

    case 'skipBuild':
      if (s.phase !== 'build') return 'Nada para construir agora.';
      s.pendingBuild = null;
      finish(s);
      return null;

    case 'sell':
      if (!mineOk || t.level <= 0) return 'Não há construções para vender.';
      sellLevel(s, p, t);
      return null;

    case 'mortgage':
      if (!mineOk || t.mortgage) return 'Não é possível hipotecar.';
      if (t.level > 0) return 'Venda as construções desta propriedade antes.';
      mortgageTile(s, p, t);
      return null;

    case 'unmortgage':
      if (!mineOk || !t.mortgage) return 'Esta propriedade não está hipotecada.';
      if (!p.pagar(unmortgageCost(t))) return 'Saldo insuficiente.';
      t.mortgage = false;
      log(s, `${p.nome} quitou a hipoteca de ${t.name}.`);
      return null;

    case 'payJail':
      if (!p.preso || s.phase !== 'roll') return 'Você não está preso.';
      if (!p.pagar(jailFine(s))) return 'Saldo insuficiente para a fiança.';
      p.preso = false; p.turnosPreso = 0;
      log(s, `${p.nome} pagou ${fmt(jailFine(s))} de fiança.`);
      return null;

    case 'useJailCard':
      if (!p.preso || s.phase !== 'roll' || p.cartasSaida <= 0) return 'Sem Habeas Corpus para usar.';
      p.cartasSaida--; p.preso = false; p.turnosPreso = 0;
      {
        const d = Object.keys(s.jailCardOut || {}).find(k => s.jailCardOut[k] === p.id);
        if (d) s.jailCardOut[d] = null;   // volta ao baralho no próximo embaralhamento
      }
      log(s, `${p.nome} usou um Habeas Corpus.`);
      return null;

    case 'payDebt': {
      if (s.phase !== 'debt') return 'Não há dívida pendente.';
      const { amount, creditorId, splitTo, each } = s.debt;
      if (!p.pagar(amount)) return `Faltam ${fmt(amount - p.saldo)}.`;
      if (splitTo) splitTo.forEach(id => credit(s, id, each));
      else credit(s, creditorId, amount);
      log(s, `${p.nome} quitou a dívida de ${fmt(amount)}.`);
      s.debt = null;
      finish(s);
      return null;
    }

    case 'bankrupt':
      if (s.phase !== 'debt') return 'Só é possível declarar falência com uma dívida pendente.';
      bankrupt(s, p, s.debt.creditorId);
      return null;

    case 'endTurn':
      if (s.phase !== 'end') return 'Termine sua jogada antes.';
      nextTurn(s);
      return null;
  }
  return 'Ação desconhecida.';
}

// Ação padrão quando o jogador da vez está ausente ou inativo
function autoPlay(s, p) {
  const away = !p.conectado;
  log(s, `⏱ Ação automática para ${p.nome}${away ? ' (desconectado)' : ' (inativo)'}.`);
  switch (s.phase) {
    case 'roll': if (away) nextTurn(s); else doRoll(s, p); break;
    case 'buy': applyAction(s, p.id, 'decline'); break;
    case 'build': applyAction(s, p.id, 'skipBuild'); break;
    case 'debt':
      autoLiquidate(s, p, s.debt.amount);
      if (applyAction(s, p.id, 'payDebt')) bankrupt(s, p, s.debt.creditorId);
      break;
    case 'end': nextTurn(s); break;
  }
}

// Relógio do Host (1x por segundo). Devolve true se o estado mudou.
function tick(s, now = Date.now()) {
  if (s.phase === 'gameover') return false;
  let changed = false;
  // Duração desde o último tick deste host (limitada caso a aba tenha ficado congelada)
  const dt = s.tickAt ? Math.min(Math.max(now - s.tickAt, 0), 120000) : 0;
  s.tickAt = now;
  s.elapsedMs = (s.elapsedMs || 0) + dt;
  for (const p of s.players) {
    if (p.bancarroto || p.conectado) continue;
    const antes = p.ausenteMs || 0;
    p.ausenteMs = antes + dt;
    if (Math.floor(antes / 5000) !== Math.floor(p.ausenteMs / 5000)) changed = true;   // atualiza a contagem na tela
    if (p.ausenteMs > RECONNECT_GRACE_MS) {
      log(s, `${p.nome} não voltou a tempo.`);
      bankrupt(s, p, null);
      changed = true;
      if (s.phase === 'gameover') return true;
    }
  }
  if (s.timeLimitMs && s.elapsedMs >= s.timeLimitMs) { endByTime(s); return true; }
  const idle = now - s.phaseSince;
  const late = p => (!p.conectado && idle > AWAY_SKIP_MS) || idle > TURN_TIMEOUT_MS;
  if (s.phase === 'order') {
    // Sorteio da ordem: rola automaticamente por quem está ausente ou inativo
    const auto = s.orderPending.map(id => pById(s, id)).filter(late);
    if (!auto.length) return changed;
    newAnim(s);
    for (const p of auto) {
      if (s.phase !== 'order' || !s.orderPending.includes(p.id)) continue;
      log(s, `⏱ Rolagem automática para ${p.nome}.`);
      rollOrder(s, p);
    }
    s.phaseSince = now;
    return true;
  }
  const p = currentPlayer(s);
  if (late(p)) {
    newAnim(s);
    autoPlay(s, p);
    s.phaseSince = now;
    changed = true;
  }
  return changed;
}

/* =========================================================================
 * INTERFACE — desenha a tela a partir do estado recebido do Host
 * ========================================================================= */
const STEP_MS = 320;      // tempo de cada casa andada pelo peão
const FOLLOW_ZOOM = 1.8;  // aproximação da câmera seguindo o peão

const UI = {
  myId: null,
  zoom: 1,
  builtSeq: null,       // tabuleiro já montado para esta partida
  lastRollSeq: -1,
  lastCardSeq: 0,
  lastTurnId: null,
  modalKind: null,      // modal aberto: buy | debt | gameover | card | tile
  openTile: null,
  state: null,

  $(id) { return document.getElementById(id); },

  show(screen) {
    this.$('screen-lobby').classList.toggle('hidden', screen !== 'lobby');
    this.$('screen-game').classList.toggle('hidden', screen !== 'game');
  },

  toast(msg, ms = 2500) {
    const el = this.$('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  },

  /* ---------- Lobby ---------- */
  renderLobby(lobby, isHost, roomCode) {
    this.$('lobby-entry').classList.add('hidden');
    this.$('lobby-loading').classList.add('hidden');
    this.$('lobby-room').classList.remove('hidden');
    this.$('room-code').textContent = roomCode;
    this.$('player-list').innerHTML = lobby.map((p, i) => `
      <li class="flex items-center gap-3 bg-slate-700/60 rounded-lg px-3 py-2">
        <span class="token-static" style="background:${esc(p.color)}">${esc(p.name.charAt(0).toUpperCase())}</span>
        <span class="flex-1">${esc(p.name)}${p.id === this.myId ? ' <em class="text-slate-400">(você)</em>' : ''}</span>
        ${i === 0 ? '<span class="text-xs bg-amber-500 text-black rounded px-2">HOST</span>' : ''}
      </li>`).join('');
    this.$('host-controls').classList.toggle('hidden', !isHost);
    this.$('btn-start').disabled = lobby.length < 2;
    const preset = presetFor(Math.max(lobby.length, 2));
    this.$('lobby-status').textContent = lobby.length < 2
      ? 'Aguardando pelo menos 2 jogadores…'
      : `${lobby.length} jogadores · tabuleiro de ${preset.tiles} casas · ${fmt(preset.initialMoney)} iniciais` + (isHost ? '' : ' · aguardando o host iniciar');
  },

  /* ---------- Jogo ---------- */
  shownPos: {},         // casa desenhada de cada peão durante a animação (difere da posição real)
  animQueue: [],
  animating: false,
  lastAnimSeq: null,
  prevSaldo: {},
  _wasOrder: false,

  render(s) {
    this.state = s;
    this._clock = { left: (s.timeLimitMs || 0) - (s.elapsedMs || 0), at: Date.now() };
    this.show('game');
    const board = this.$('board');
    if (this.builtSeq !== s.startedAt) {
      buildBoardDOM(board, s.board);
      this.builtSeq = s.startedAt;
      this.lastAnimSeq = s.anim ? s.anim.seq : null;   // não reanima o que aconteceu antes de entrar
      this.shownPos = {};
      this.fitBoard();
    }
    const rolled = this.lastRollSeq !== -1 && s.rollSeq !== this.lastRollSeq;
    this.renderDice(s);
    // Movimentos novos: os peões andam casa a casa antes de o resultado aparecer.
    // Só a jogada mais recente é animada: jogadas acumuladas (aba em segundo plano, celular bloqueado)
    // nunca podem deixar a tela presa num estado antigo enquanto o host já seguiu.
    if (s.anim && s.anim.seq !== this.lastAnimSeq) {
      this.lastAnimSeq = s.anim.seq;
      this.skipAnim();
      if (s.anim.moves.length && !document.hidden) {
        this.shownPos = {};
        for (const m of s.anim.moves) if (!m.jump && this.shownPos[m.playerId] === undefined) this.shownPos[m.playerId] = m.from;
        this.animQueue = [{ moves: s.anim.moves, delay: rolled ? 650 : 0, token: this.animToken }];
        this.runAnim();
      }
    }
    if (this.animating) {
      updateBoardDOM(board, s, this.shownPos, this._movingId);
      document.querySelectorAll('#actions [data-act]').forEach(b => { b.disabled = true; });
      // Compra/dívida que já não vale no host não pode continuar aberta durante a animação
      const mine = currentPlayer(s) && currentPlayer(s).id === this.myId;
      const still = { buy: mine && s.phase === 'buy', debt: mine && s.phase === 'debt', build: mine && s.phase === 'build', trade: !!(s.trade && s.trade.to === this.myId) };
      if (this.modalKind in still && !still[this.modalKind]) this.closeModal();
      return;
    }
    this.shownPos = {};
    this.renderFull(s);
  },

  // Cancela a animação em andamento (o peão vai direto para a posição real)
  skipAnim() {
    this.animToken = (this.animToken || 0) + 1;
    this.animQueue = [];
    if (this._wakeAnim) this._wakeAnim();
  },

  // Executa a jogada animada, um passo por casa; para assim que for cancelada
  async runAnim() {
    if (this.animating) return;
    this.animating = true;
    const board = this.$('board');
    // Espera que termina antes se a animação for cancelada (nova jogada, aba escondida ou erro do host)
    const wait = ms => new Promise(r => { this._wakeAnim = r; setTimeout(r, ms); });
    while (this.animQueue.length) {
      const { moves, delay, token } = this.animQueue.shift();
      const live = () => token === this.animToken && !document.hidden;
      if (delay) await wait(delay);
      for (const m of moves) {
        if (!live()) break;
        const N = this.state.board.size;
        this._movingId = m.playerId;
        if (m.jump) {
          this.shownPos[m.playerId] = m.to;
          updateBoardDOM(board, this.state, this.shownPos, m.playerId);
          this.camFollow(m.to);
          this.pulseTile(m.to);
          await wait(700);
          continue;
        }
        const dir = Math.sign(m.steps);
        for (let k = 1; k <= Math.abs(m.steps) && live(); k++) {
          this.shownPos[m.playerId] = ((m.from + dir * k) % N + N) % N;
          updateBoardDOM(board, this.state, this.shownPos, m.playerId);
          this.camFollow(this.shownPos[m.playerId]);
          await wait(STEP_MS);
        }
        if (!live()) break;
        this.pulseTile(this.shownPos[m.playerId]);
        await wait(600);
      }
    }
    this.camHome(true);
    this._movingId = null;
    this._wakeAnim = null;
    this.animating = false;
    this.shownPos = {};
    this.render(this.state);
  },

  pulseTile(i) {
    const el = document.querySelector(`[data-tile="${i}"]`);
    if (!el) return;
    el.classList.remove('landed');
    void el.offsetWidth;
    el.classList.add('landed');
  },

  banner(msg) {
    const el = this.$('banner');
    el.textContent = msg;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => el.classList.remove('show'), 1600);
  },

  renderFull(s) {
    updateBoardDOM(this.$('board'), s);
    const me = pById(s, this.myId);
    const cur = s.phase === 'order' ? null : currentPlayer(s);
    const myTurn = !!me && !!cur && cur.id === me.id && s.phase !== 'gameover';

    this.$('g-room').textContent = Net.roomCode || '';
    this.$('center-turn').innerHTML = s.phase === 'order' ? '🎲 Sorteio da ordem de jogada'
      : s.phase === 'gameover' ? '🏆 Fim de jogo'
      : cur ? `<span class="turn-dot" style="background:${esc(cur.corPeao)}"></span>Vez de <b>${esc(cur.nome)}</b>` : '';
    this.renderOrder(s);
    this.renderCard(s);
    this.renderSidebar(s, me, cur, myTurn);
    this.renderLog(s);
    this.renderModals(s, me, myTurn);
    this._wasOrder = s.phase === 'order';

    // Aviso de troca de turno ("fim de turno")
    if (cur && cur.id !== this.lastTurnId) {
      this.lastTurnId = cur.id;
      if (myTurn) this.banner('🎲 Sua vez!');
    }
  },

  renderDice(s) {
    const tray = this.$('dice');
    if (!tray) return;
    const dies = tray.querySelectorAll('.die');
    const setFaces = (a, b) => { dies[0].innerHTML = dieFaceHTML(a); dies[1].innerHTML = dieFaceHTML(b); };
    if (this.lastRollSeq === -1 || s.rollSeq === this.lastRollSeq) {
      this.lastRollSeq = s.rollSeq;
      if (!this._diceT) setFaces(s.dice[0], s.dice[1]);
      return;
    }
    this.lastRollSeq = s.rollSeq;
    const final = [...s.dice];
    clearInterval(this._diceT);
    this._diceT = null;
    tray.classList.remove('doubles');
    if (document.hidden) { setFaces(final[0], final[1]); return; }
    // Animação: os dados giram trocando de face antes de parar no resultado
    let n = 0;
    tray.classList.add('rolling');
    this._diceT = setInterval(() => {
      setFaces(d6(), d6());
      if (++n >= 8) {
        clearInterval(this._diceT);
        this._diceT = null;
        tray.classList.remove('rolling');
        setFaces(final[0], final[1]);
        tray.classList.toggle('doubles', final[0] === final[1]);
      }
    }, 75);
  },

  // Resultados do sorteio da ordem, no centro do tabuleiro
  renderOrder(s) {
    const el = this.$('center-order');
    if (!el) return;
    el.classList.toggle('hidden', s.phase !== 'order');
    if (s.phase !== 'order') return;
    el.innerHTML = s.turnos.map(id => pById(s, id)).map(p => {
      const r = s.orderRolls[p.id] || [];
      const pending = s.orderPending.includes(p.id);
      return `<div class="order-row">
        <span class="token-static" style="background:${esc(p.corPeao)}">${esc(p.nome.charAt(0).toUpperCase())}</span>
        <span class="order-name">${esc(p.nome)}</span>
        <b class="order-roll">${r.length ? r.join(' · ') : '–'}</b>
        <span class="order-state">${pending ? '⏳' : '✔'}</span>
      </div>`;
    }).join('');
  },

  renderCard(s) {
    const el = this.$('center-card');
    if (!el || !s.lastCard) return;
    el.classList.remove('hidden');
    el.innerHTML = `<b>${s.lastCard.deck === 'chance' ? '❓' : '🎁'} ${DECK_LABEL[s.lastCard.deck]}</b><br>${esc(s.lastCard.text)}`;
  },

  actionButtons(s, me, myTurn) {
    const btn = (act, label, cls = 'btn-primary', dis = false) => `<button class="btn ${cls}" data-act="${act}" ${dis ? 'disabled' : ''}>${label}</button>`;
    if (s.phase === 'order') return me && s.orderPending.includes(me.id) ? btn('rollOrder', '🎲 Rolar para definir a ordem') : '';
    if (!myTurn) return '';
    // Negociar: na vez do jogador, fora de decisões pendentes (compra/construção)
    const tradeBtn = s.trade && s.trade.from === me.id ? btn('cancelTrade', '✖ Cancelar proposta', 'btn-secondary')
      : s.trade || s.turnos.length < 2 ? '' : btn('openTrade', '🤝 Negociar', 'btn-secondary');
    switch (s.phase) {
      case 'build': {
        const t = tileAt(s, s.pendingBuild);
        return btn('build', `🏠 Construir ${t.level === 4 ? 'hotel' : 'casa'} ${fmt(buildCost(t))}`, 'btn-primary', me.saldo < buildCost(t))
          + btn('skipBuild', 'Agora não', 'btn-secondary');
      }
      case 'roll':
        if (me.preso) {
          return btn('roll', '🎲 Tentar dupla') + btn('payJail', `Pagar fiança ${fmt(jailFine(s))}`, 'btn-secondary', me.saldo < jailFine(s))
            + (me.cartasSaida ? btn('useJailCard', `Usar Habeas Corpus (${me.cartasSaida})`, 'btn-secondary') : '') + tradeBtn;
        }
        return btn('roll', '🎲 Rolar Dados') + tradeBtn;
      case 'buy': {
        const t = tileAt(s, s.pendingBuy);
        return btn('buy', `Comprar ${fmt(t.price)}`, 'btn-primary', me.saldo < t.price) + btn('decline', 'Recusar', 'btn-secondary');
      }
      case 'debt':
        return btn('payDebt', `Pagar ${fmt(s.debt.amount)}`, 'btn-primary', me.saldo < s.debt.amount) + btn('bankrupt', 'Declarar falência', 'btn-danger') + tradeBtn;
      case 'end':
        return btn('endTurn', 'Encerrar turno ⏭') + tradeBtn;
    }
    return '';
  },

  renderSidebar(s, me, cur, myTurn) {
    const actions = this.actionButtons(s, me, myTurn);
    let hint = '';
    if (s.phase === 'order') hint = actions ? 'Quem tirar mais nos dados começa. Empates rolam de novo.' : 'Aguardando os outros rolarem…';
    if (s.trade && s.phase !== 'gameover') {
      const a = pById(s, s.trade.from), b = pById(s, s.trade.to);
      hint += `${hint ? '<br>' : ''}🤝 Proposta de <b>${esc(a.nome)}</b> para <b>${esc(b.nome)}</b> aguardando resposta…`;
    }
    this.$('actions').innerHTML = (actions ? `<div class="actions-row">${actions}</div>` : '') + (hint ? `<p class="hint">${hint}</p>` : '');

    // Carteira (canto inferior esquerdo) e mão de cartas
    const wallet = this.$('wallet');
    wallet.style.setProperty('--pc', me ? me.corPeao : '#10b981');
    wallet.innerHTML = me ? `<span class="wallet-label">Dinheiro</span><b class="wallet-money">${fmt(me.saldo)}</b>
      <span class="wallet-label">Patrimônio total</span><b class="wallet-worth">${me.bancarroto ? 'falido' : fmt(netWorth(s, me))}</b>` : '';
    this.renderHand(s, me);

    // Jogadores na ordem dos turnos (falidos por último); clique abre os detalhes
    const ordered = [...s.turnos.map(id => pById(s, id)), ...s.players.filter(p => !s.turnos.includes(p.id))];
    const panel = this.$('players-panel');
    panel.innerHTML = ordered.map(p => {
      const badge = p.bancarroto ? '💀' : !p.conectado
        ? `📴${Math.max(0, Math.ceil((RECONNECT_GRACE_MS - (p.ausenteMs || 0)) / 1000))}s` : p.preso ? '🔒' : '';
      return `<button class="pchip ${cur && cur.id === p.id ? 'is-turn' : ''} ${p.bancarroto ? 'is-out' : ''}" style="--pc:${esc(p.corPeao)}" data-player="${esc(p.id)}" data-pid="${esc(p.id)}"
          title="${!p.conectado && !p.bancarroto ? 'Desconectado: volta entrando com o mesmo nome' : 'Ver detalhes'}">
        <span class="pchip-bar"><span class="pchip-name">${esc(p.nome)}${p.id === this.myId ? ' <span class="you">você</span>' : ''}</span>
          <span class="pchip-money">${p.bancarroto ? 'falido' : fmt(p.saldo)}</span></span>
        <span class="pchip-avatar">${esc(p.nome.charAt(0).toUpperCase())}${badge ? `<span class="pchip-badge">${badge}</span>` : ''}</span>
      </button>`;
    }).join('');
    // Dinheiro que entrou ou saiu desde a última atualização
    for (const p of s.players) {
      const prev = this.prevSaldo[p.id];
      this.prevSaldo[p.id] = p.saldo;
      if (prev === undefined || prev === p.saldo) continue;
      const rows = [...panel.querySelectorAll('[data-pid]')].filter(r => r.dataset.pid === p.id);
      if (p.id === this.myId) rows.push(wallet);
      for (const row of rows) {
        const f = document.createElement('span');
        f.className = 'money-float ' + (p.saldo > prev ? 'up' : 'down');
        f.textContent = (p.saldo > prev ? '+' : '−') + fmt(Math.abs(p.saldo - prev));
        row.appendChild(f);
        setTimeout(() => f.remove(), 1800);
      }
    }
  },

  // Propriedades do jogador local como cartas na mão (da mais barata à mais cara) + Habeas Corpus
  renderHand(s, me) {
    const el = this.$('hand');
    const props = me ? me.propriedades.map(i => tileAt(s, i)).sort((a, b) => a.price - b.price || a.id - b.id) : [];
    const n = props.length + (me ? me.cartasSaida || 0 : 0);
    const mid = (n - 1) / 2, spread = Math.min(4, 36 / Math.max(n, 1));
    const fan = i => `--rot:${((i - mid) * spread).toFixed(2)}deg;--lift:${(Math.abs(i - mid) ** 2 * spread * 0.2).toFixed(1)}px`;
    const cards = props.map((t, i) => {
      const gc = t.colorGroup ? s.board.groups[t.colorGroup].color : t.type === 'railroad' ? '#334155' : '#0e7490';
      return `<button class="pcard ${t.mortgage ? 'mortgaged' : ''}" data-open="${t.id}" style="--gc:${gc};${fan(i)}" title="${esc(t.name)}">
        <span class="pcard-band">${t.icon || ''}</span>
        <span class="pcard-name">${esc(t.name)}</span>
        <span class="pcard-level">${t.level === 5 ? '🏨' : '🏠'.repeat(t.level)}</span>
        <span class="pcard-price">${fmt(t.price)}</span>
      </button>`;
    });
    for (let k = 0; me && k < (me.cartasSaida || 0); k++) {
      cards.push(`<div class="pcard pcard-hc" tabindex="0" style="${fan(props.length + k)}" title="Habeas Corpus: sai da prisão sem pagar">
        <span class="pcard-band">🎫</span><span class="pcard-name">Habeas Corpus</span><span class="pcard-price">Sai da prisão</span></div>`);
    }
    const html = cards.join('') || (me ? '<p class="hint hand-empty">Suas propriedades aparecem aqui como cartas.</p>' : '');
    if (html === this._handHtml) return;   // não recria as cartas à toa (o hover do mouse pularia)
    this._handHtml = html;
    el.innerHTML = html;
    this.fitHand();
  },

  // Sobrepõe as cartas o suficiente para caberem na largura disponível
  fitHand() {
    const el = this.$('hand'), c = el.querySelector('.pcard');
    if (!c) return;
    const n = el.children.length, w = c.offsetWidth;
    const ov = n > 1 ? Math.max(w * 0.28, (n * w - (el.clientWidth - 24)) / (n - 1)) : 0;
    el.style.setProperty('--ov', ov + 'px');
  },

  // Detalhes de um jogador: dinheiro, bens e proposta de troca
  openPlayerModal(id) {
    const s = this.state, p = s && pById(s, id);
    if (!p) return;
    const me = pById(s, this.myId);
    const props = p.propriedades.map(i => tileAt(s, i)).sort((a, b) => a.price - b.price || a.id - b.id);
    const status = p.bancarroto ? 'Falido' : [currentPlayer(s) === p && s.phase !== 'order' ? '🎲 Jogando agora' : '',
      p.preso ? '🔒 Preso' : '', p.conectado ? '' : '📴 Desconectado'].filter(Boolean).join(' · ') || 'Aguardando a vez';
    let trade = '';
    if (me && p.id !== me.id && !p.bancarroto && !me.bancarroto && s.phase !== 'gameover') {
      const can = currentPlayer(s) === me && ['roll', 'end', 'debt'].includes(s.phase) && !s.trade;
      trade = can ? `<button class="btn btn-primary" data-trade-with="${esc(p.id)}">🤝 Propor troca</button>`
        : `<p class="hint w-full">${s.trade ? 'Já existe uma proposta de troca aguardando resposta.' : 'Você pode propor trocas durante a sua vez.'}</p>`;
    }
    this.openPlayerId = id;
    this.openModal('player', `
      <div class="flex items-center gap-3 mb-4" style="--pc:${esc(p.corPeao)}">
        <span class="pchip-avatar">${esc(p.nome.charAt(0).toUpperCase())}</span>
        <div class="min-w-0"><h2 class="text-xl font-bold truncate">${esc(p.nome)}${p.id === this.myId ? ' <span class="you">você</span>' : ''}</h2>
          <p class="text-sm text-slate-400">${status}</p></div>
      </div>
      <div class="grid grid-cols-2 gap-2 mb-4">
        <div class="stat"><span>Dinheiro</span><b>${fmt(p.saldo)}</b></div>
        <div class="stat"><span>Patrimônio</span><b>${fmt(netWorth(s, p))}</b></div>
      </div>
      <h3 class="panel-title">Propriedades (${props.length})</h3>
      <div class="space-y-1 mb-3 max-h-64 overflow-y-auto">${props.map(t => `
        <button class="prop-row" data-open="${t.id}">
          <span class="prop-swatch" style="background:${t.colorGroup ? s.board.groups[t.colorGroup].color : '#94a3b8'}"></span>
          <span class="flex-1 text-left truncate">${esc(t.name)}</span>
          <span class="text-xs">${t.mortgage ? '<span class="text-red-400">HIPOTECADA</span>' : (t.level === 5 ? '🏨' : '🏠'.repeat(t.level))}</span>
        </button>`).join('') || '<p class="hint">Nenhuma propriedade.</p>'}</div>
      ${p.cartasSaida ? `<p class="mb-3 text-sm">🎫 Habeas Corpus ×${p.cartasSaida}</p>` : ''}
      <div class="flex flex-wrap items-center gap-2">${trade}<button class="btn btn-secondary" data-close>Fechar</button></div>`);
  },

  renderLog(s) {
    const el = this.$('log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = s.log.map(e => `<div class="log-line">${esc(e.msg)}</div>`).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  },

  /* ---------- Modais ---------- */
  openModal(kind, html) {
    if (this.modalKind === kind && this._modalHtml === html) return;
    this._modalHtml = html;
    this.modalKind = kind;
    this.$('modal-box').innerHTML = html;
    this.$('modal').classList.remove('hidden');
    const first = this.$('modal-box').querySelector('button:not([disabled])');
    if (first) first.focus();
  },

  closeModal() {
    this.modalKind = null;
    this._modalHtml = null;
    this.openTile = null;
    this.openPlayerId = null;
    this._modalCardSeq = null;
    this.$('modal').classList.add('hidden');
  },

  // Carta recém-tirada pelo jogador local, exibida dentro do modal de compra/dívida
  cardBlock(s) {
    if (!s.lastCard || s.lastCard.playerId !== this.myId) return '';
    if (s.lastCard.seq !== this.lastCardSeq) { this._modalCardSeq = s.lastCard.seq; this.lastCardSeq = s.lastCard.seq; }
    if (this._modalCardSeq !== s.lastCard.seq) return '';
    return `<div class="card-face mb-3"><b>${DECK_LABEL[s.lastCard.deck]}</b><p>${esc(s.lastCard.text)}</p></div>`;
  },

  renderModals(s, me, myTurn) {
    // Prioridade: fim de jogo > compra > dívida > carta > detalhes da casa
    let want = null;
    if (s.phase === 'gameover') want = 'gameover';
    else if (myTurn && s.phase === 'buy') want = 'buy';
    else if (myTurn && s.phase === 'debt') want = 'debt';
    else if (myTurn && s.phase === 'build') want = 'build';
    else if (s.trade && s.trade.to === this.myId) want = 'trade';

    if (want === 'build') {
      const t = tileAt(s, s.pendingBuild);
      this.openModal('build', this.cardBlock(s) + `<p class="mb-2">🏠 Você caiu de novo na sua propriedade!</p>` + this.tileInfo(s, t) + `
        <p class="my-2">Seu saldo: <b>${fmt(me.saldo)}</b></p>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-primary" data-act="build" ${me.saldo < buildCost(t) ? 'disabled' : ''}>Construir ${t.level === 4 ? 'hotel' : 'casa'} por ${fmt(buildCost(t))}</button>
          <button class="btn btn-secondary" data-act="skipBuild">Agora não</button>
        </div>`);
      return;
    }
    if (want === 'trade') {
      const tr = s.trade, from = pById(s, tr.from);
      const items = (ids, m) => [...ids.map(i => {
        const t = tileAt(s, i);
        return `<li class="flex items-center gap-2"><span class="prop-swatch" style="background:${t.colorGroup ? s.board.groups[t.colorGroup].color : '#94a3b8'}"></span>${esc(t.name)}${t.mortgage ? ' <small class="text-red-300">(hipotecada)</small>' : ''}</li>`;
      }), ...(m ? [`<li>💰 ${fmt(m)}</li>`] : [])].join('') || '<li class="hint">nada</li>';
      this.openModal('trade', `
        <h2 class="text-xl font-bold mb-3">🤝 Proposta de ${esc(from.nome)}</h2>
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div><h3 class="panel-title">Você recebe</h3><ul class="space-y-1 text-sm">${items(tr.give, tr.giveMoney)}</ul></div>
          <div><h3 class="panel-title">Você dá</h3><ul class="space-y-1 text-sm">${items(tr.get, tr.getMoney)}</ul></div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-primary" data-act="acceptTrade">Aceitar</button>
          <button class="btn btn-danger" data-act="rejectTrade">Recusar</button>
        </div>`);
      return;
    }

    if (want === 'gameover') {
      const w = pById(s, s.winnerId);
      const rank = [...s.players].sort((a, b) => (a.bancarroto - b.bancarroto) || netWorth(s, b) - netWorth(s, a));
      this.openModal('gameover', `
        <h2 class="text-2xl font-bold mb-2">🏆 ${w ? esc(w.nome) : 'Fim de jogo'} venceu!</h2>
        <ol class="mb-4 space-y-1">${rank.map((p, i) => `<li>${i + 1}. ${esc(p.nome)} — ${p.bancarroto ? 'falido' : fmt(netWorth(s, p))}</li>`).join('')}</ol>
        <button class="btn btn-primary" data-act="newGame">Voltar ao lobby</button>`);
      return;
    }
    if (want === 'buy') {
      const t = tileAt(s, s.pendingBuy);
      const html = this.cardBlock(s) + this.tileInfo(s, t) + `
        <p class="my-2">Seu saldo: <b>${fmt(me.saldo)}</b></p>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-primary" data-act="buy" ${me.saldo < t.price ? 'disabled' : ''}>Comprar por ${fmt(t.price)}</button>
          <button class="btn btn-secondary" data-act="decline">Recusar</button>
        </div>
        ${me.saldo < t.price ? '<p class="text-xs text-amber-300 mt-2">Saldo insuficiente: hipoteque propriedades (clique nas suas cartas) ou recuse.</p>' : ''}`;
      this.openModal('buy', html);
      return;
    }
    if (want === 'debt') {
      const html = this.cardBlock(s) + `
        <h2 class="text-xl font-bold mb-2">⚠️ Dívida de ${fmt(s.debt.amount)}</h2>
        <p class="mb-1">Credor: <b>${s.debt.splitTo ? 'os outros jogadores' : s.debt.creditorId ? esc(pById(s, s.debt.creditorId).nome) : 'Banco'}</b> · Seu saldo: <b>${fmt(me.saldo)}</b></p>
        <p class="text-sm text-slate-300 mb-3">Venda construções ou hipoteque propriedades abaixo até ter saldo suficiente.</p>
        <div class="space-y-1 mb-3">${me.propriedades.map(i => tileAt(s, i)).map(t => `
          <div class="flex items-center gap-2 text-sm">
            <span class="flex-1">${esc(t.name)}</span>
            ${t.level > 0 ? `<button class="btn-mini" data-act="sell" data-idx="${t.id}">Vender 🏠 +${fmt(round10(buildCost(t, t.level - 1) / 2))}</button>` : ''}
            ${!t.mortgage && t.level === 0 ? `<button class="btn-mini" data-act="mortgage" data-idx="${t.id}">Hipotecar +${fmt(mortgageValue(t))}</button>` : ''}
            ${t.mortgage ? '<span class="text-slate-500">hipotecada</span>' : ''}
          </div>`).join('')}</div>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-primary" data-act="payDebt" ${me.saldo < s.debt.amount ? 'disabled' : ''}>Pagar ${fmt(s.debt.amount)}</button>
          <button class="btn btn-danger" data-act="bankrupt">Declarar falência</button>
        </div>`;
      this.openModal('debt', html);
      return;
    }
    // Modal obrigatório deixou de valer: fecha
    if (['buy', 'debt', 'gameover', 'build', 'trade'].includes(this.modalKind)) this.closeModal();

    // Sorteio da ordem acabou de terminar: mostra o resultado a todos
    if (this._wasOrder && s.phase !== 'order') {
      this.openModal('card', `<h2 class="text-xl font-bold mb-3">📋 Ordem de jogada</h2>
        <ol class="space-y-2 mb-4">${s.turnos.map((id, i) => {
          const p = pById(s, id);
          return `<li class="order-row"><span class="player-pos">${i + 1}º</span>
            <span class="token-static" style="background:${esc(p.corPeao)}">${esc(p.nome.charAt(0).toUpperCase())}</span>
            <span class="order-name">${esc(p.nome)}</span><b class="order-roll">${(s.orderRolls[id] || []).join(' · ')}</b></li>`;
        }).join('')}</ol>
        <button class="btn btn-primary w-full" data-close>Começar!</button>`);
    }

    // Carta tirada (mostrada a todos)
    if (s.lastCard && s.lastCard.seq !== this.lastCardSeq) {
      const firstRender = this.lastCardSeq === 0 && this.lastRollSeq === s.rollSeq && !this._seenAny;
      this.lastCardSeq = s.lastCard.seq;
      const who = pById(s, s.lastCard.playerId);
      if (!firstRender && !['tile', 'tradeEdit', 'player'].includes(this.modalKind)) {
        this.openModal('card', `<div class="card-face"><b>${DECK_LABEL[s.lastCard.deck]}</b> — ${esc(who ? who.nome : '')}<p class="text-lg my-3">${esc(s.lastCard.text)}</p></div>
          <button class="btn btn-primary" data-close>OK</button>`);
      }
    }
    this._seenAny = true;
    if (this.modalKind === 'tile') this.openTileModal(this.openTile);
    if (this.modalKind === 'player') this.openPlayerModal(this.openPlayerId);
  },

  tileInfo(s, t) {
    const color = t.colorGroup ? s.board.groups[t.colorGroup].color : '#475569';
    const owner = t.owner ? pById(s, t.owner) : null;
    let rows = '';
    if (t.type === 'property') {
      const labels = ['Aluguel', '1 casa', '2 casas', '3 casas', '4 casas', 'Hotel'];
      rows = t.rent.map((r, i) => `<tr class="${t.level === i ? 'text-amber-300 font-bold' : ''}"><td>${labels[i]}</td><td class="text-right">${fmt(r)}</td></tr>`).join('')
        + `<tr><td colspan="2" class="text-xs text-slate-400">Construa uma casa cada vez que cair de novo na sua propriedade (${fmt(buildCost(t, 0))} a ${fmt(buildCost(t, 4))}). Conjunto completo da cor dobra o aluguel sem construções.</td></tr>`;
    } else if (t.type === 'railroad') {
      rows = t.rent.map((r, i) => `<tr><td>${i + 1} estação(ões)</td><td class="text-right">${fmt(r)}</td></tr>`).join('');
    } else if (t.type === 'utility') {
      rows = t.rent.map((r, i) => `<tr><td>${i + 1} companhia(s)</td><td class="text-right">dados × ${r}</td></tr>`).join('');
    }
    return `<div class="rounded-lg overflow-hidden border border-slate-600 mb-2">
      <div class="px-3 py-2 font-bold text-center" style="background:${color};color:#fff;text-shadow:0 1px 2px #000">${t.icon || ''} ${esc(t.name)}</div>
      <div class="p-3 text-sm">
        ${t.price ? `<p>${t.type === 'tax' ? 'Valor do imposto' : 'Preço'}: <b>${fmt(t.price)}</b>${t.type !== 'tax' ? ` · Hipoteca: ${fmt(mortgageValue(t))}` : ''}</p>` : ''}
        ${owner ? `<p>Dono: <b style="color:${esc(owner.corPeao)}">${esc(owner.nome)}</b>${t.mortgage ? ' · <span class="text-red-400">HIPOTECADA</span>' : ''}</p>` : (t.price && t.type !== 'tax' ? '<p class="text-slate-400">Disponível para compra</p>' : '')}
        ${rows ? `<table class="w-full mt-2">${rows}</table>` : ''}
      </div></div>`;
  },

  openTileModal(i) {
    const s = this.state;
    if (!s || i === null || i === undefined) return;
    const t = tileAt(s, i);
    const me = pById(s, this.myId);
    const myTurn = me && currentPlayer(s) === me && !['gameover', 'order'].includes(s.phase);
    let ctrl = '';
    if (me && t.owner === me.id) {
      const b = (act, label, dis) => `<button class="btn btn-secondary" data-act="${act}" data-idx="${t.id}" ${dis || !myTurn ? 'disabled' : ''}>${label}</button>`;
      ctrl = `<div class="flex flex-wrap gap-2 mt-2">
        ${t.level > 0 ? b('sell', `Vender construção (+${fmt(round10(buildCost(t, t.level - 1) / 2))})`) : ''}
        ${!t.mortgage ? b('mortgage', `Hipotecar (+${fmt(mortgageValue(t))})`, t.level > 0) : b('unmortgage', `Quitar hipoteca (${fmt(unmortgageCost(t))})`, me.saldo < unmortgageCost(t))}
      </div>
      ${!myTurn ? '<p class="text-xs text-slate-400 mt-2">Gerencie suas propriedades durante a sua vez.</p>' : ''}
      ${t.type === 'property' && t.level < 5 ? '<p class="text-xs text-slate-400 mt-2">🏠 Para construir, caia de novo nesta propriedade.</p>' : ''}`;
    }
    this.openTile = i;
    this.openModal('tile', this.tileInfo(s, t) + ctrl + '<button class="btn btn-secondary mt-3" data-close>Fechar</button>');
  },

  // Janela para montar uma proposta de troca
  openTradeEditor(toId) {
    const s = this.state, me = pById(s, this.myId);
    const others = s.turnos.map(id => pById(s, id)).filter(p => p.id !== this.myId);
    if (!me || !others.length) return;
    const to = others.find(p => p.id === toId) || others[0];
    const list = (p, name) => {
      const ts = p.propriedades.map(i => tileAt(s, i)).filter(t => TRADABLE.includes(t.type)).sort((a, b) => a.id - b.id);
      return ts.length ? ts.map(t => `
        <label class="trade-item ${t.level ? 'opacity-40' : ''}">
          <input type="checkbox" name="${name}" value="${t.id}" ${t.level ? 'disabled' : ''}>
          <span class="prop-swatch" style="background:${t.colorGroup ? s.board.groups[t.colorGroup].color : '#94a3b8'}"></span>
          <span class="truncate">${esc(t.name)}</span>${t.mortgage ? ' <small class="text-red-300">hip.</small>' : ''}${t.level ? ' <small>🏠</small>' : ''}
        </label>`).join('') : '<p class="hint">Sem propriedades.</p>';
    };
    this.openModal('tradeEdit', `
      <h2 class="text-xl font-bold mb-3">🤝 Negociar</h2>
      <label class="flex items-center gap-2 mb-3 text-sm">Com
        <select id="tr-to" class="flex-1 rounded bg-slate-900 border border-slate-600 px-2 py-1">
          ${others.map(o => `<option value="${esc(o.id)}" ${o === to ? 'selected' : ''}>${esc(o.nome)} — ${fmt(o.saldo)}</option>`).join('')}
        </select>
      </label>
      <div class="grid grid-cols-2 gap-3">
        <div><h3 class="panel-title">Você dá</h3><div class="trade-list">${list(me, 'give')}</div>
          <label class="text-xs block mt-2">Dinheiro <input id="tr-give-money" type="number" min="0" max="${me.saldo}" step="10" value="0" class="trade-money"></label></div>
        <div><h3 class="panel-title">Você recebe</h3><div class="trade-list">${list(to, 'get')}</div>
          <label class="text-xs block mt-2">Dinheiro <input id="tr-get-money" type="number" min="0" max="${to.saldo}" step="10" value="0" class="trade-money"></label></div>
      </div>
      <p class="hint">Propriedades com casas não podem ser trocadas. Hipotecadas vão com a hipoteca.</p>
      <div class="flex flex-wrap gap-2 mt-3">
        <button class="btn btn-primary" data-act="sendTrade">Propor troca</button>
        <button class="btn btn-secondary" data-close>Cancelar</button>
      </div>`);
  },

  sendTrade() {
    const box = this.$('modal-box');
    const picked = n => [...box.querySelectorAll(`input[name="${n}"]:checked`)].map(i => Number(i.value));
    Net.act('proposeTrade', {
      to: box.querySelector('#tr-to').value,
      give: picked('give'), get: picked('get'),
      giveMoney: Number(box.querySelector('#tr-give-money').value) || 0,
      getMoney: Number(box.querySelector('#tr-get-money').value) || 0,
    });
    this.closeModal();
  },

  /* ---------- Câmera do tabuleiro ---------- */
  // cam = ponto do tabuleiro (px, sem escala) que fica no centro da tela + escala
  cam: { x: 0, y: 0, z: 1 },

  // Tamanho das casas para o tabuleiro inteiro caber na área (escala 1)
  fitBoard() {
    const s = this.state, wrap = this.$('board-wrap');
    if (!s || !wrap) return;
    const units = s.board.side + 2 * 1.6 + 2 * 0.18;  // cantos valem 1,6 casa; moldura 0,18 casa de cada lado
    const chrome = 12 + 2 * (s.board.side + 1) + 4;   // padding + gaps do grid + folga
    const fit = (Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth) - chrome) / units;
    this.$('board').style.setProperty('--cell', Math.max(28, Math.floor(fit * 0.98)) + 'px');
    this.camHome(false);
    this.fitHand();
  },

  applyCam(animate) {
    const wrap = this.$('board-wrap'), board = this.$('board');
    const W = wrap.clientWidth, H = wrap.clientHeight, bw = board.offsetWidth, bh = board.offsetHeight;
    const { z } = this.cam;
    // Com zoom, as bordas do tabuleiro param na borda da tela; menor que a tela, fica centralizado
    const clamp = (v, half, size) => size * z <= 2 * half ? size / 2 : Math.min(size - half / z, Math.max(half / z, v));
    const x = clamp(this.cam.x, W / 2, bw), y = clamp(this.cam.y, H / 2, bh);
    this.cam = { x, y, z };
    board.classList.toggle('cam-instant', !animate);
    board.style.transform = `translate(${W / 2 - x * z}px, ${H / 2 - y * z}px) scale(${z})`;
  },

  camHome(animate) {
    const b = this.$('board');
    this.cam = { x: b.offsetWidth / 2, y: b.offsetHeight / 2, z: this.zoom };
    this.applyCam(animate);
  },

  // Aproxima e centraliza a casa do peão que está andando (a transição CSS suaviza o movimento)
  camFollow(i) {
    const b = this.$('board'), el = b.querySelector(`[data-tile="${i}"]`);
    if (!el) return;
    this.cam = { x: b.clientLeft + el.offsetLeft + el.offsetWidth / 2, y: b.clientTop + el.offsetTop + el.offsetHeight / 2, z: Math.max(this.zoom, FOLLOW_ZOOM) };
    this.applyCam(true);
  },

  // Zoom mantendo parado o ponto sob (px, py) na tela (padrão: centro)
  setZoom(z, px, py) {
    const wrap = this.$('board-wrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    px = px ?? W / 2; py = py ?? H / 2;
    const old = this.cam.z;
    this.zoom = Math.min(4, Math.max(1, z));
    const bx = this.cam.x + (px - W / 2) / old, by = this.cam.y + (py - H / 2) / old;
    this.cam = { x: bx - (px - W / 2) / this.zoom, y: by - (py - H / 2) / this.zoom, z: this.zoom };
    this.applyCam(true);
  },

  /* ---------- Eventos de interface ---------- */
  bind() {
    document.addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (act && !act.disabled) {
        const a = act.dataset.act;
        if (a === 'newGame') { Net.leave(); return; }
        if (a === 'openTrade') { this.openTradeEditor(); return; }
        if (a === 'sendTrade') { this.sendTrade(); return; }
        Net.act(a, act.dataset.idx !== undefined ? { idx: Number(act.dataset.idx) } : {});
        if (this.modalKind === 'card') this.closeModal();
        return;
      }
      if (e.target.closest('[data-close]') || (e.target.id === 'modal' && ['card', 'tile', 'tradeEdit', 'player'].includes(this.modalKind))) { this.closeModal(); return; }
      const tw = e.target.closest('[data-trade-with]');
      if (tw) { this.openTradeEditor(tw.dataset.tradeWith); return; }
      const pl = e.target.closest('[data-player]');
      if (pl) { this.openPlayerModal(pl.dataset.player); return; }
      const open = e.target.closest('[data-open]') || e.target.closest('[data-tile]');
      if (open && !this._dragged) this.openTileModal(Number(open.dataset.open ?? open.dataset.tile));
    });
    // Trocar o jogador da proposta recarrega a lista de propriedades dele
    document.addEventListener('change', e => { if (e.target.id === 'tr-to') this.openTradeEditor(e.target.value); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ['card', 'tile', 'tradeEdit', 'player'].includes(this.modalKind)) this.closeModal();
      // Mantém o foco do teclado dentro do modal aberto
      if (e.key === 'Tab' && this.modalKind) {
        const f = [...this.$('modal-box').querySelectorAll('button:not([disabled]), input:not([disabled]), select')];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { f[f.length - 1].focus(); e.preventDefault(); }
        else if (!e.shiftKey && i === f.length - 1) { f[0].focus(); e.preventDefault(); }
      }
    });
    this.$('zoom-in').onclick = () => this.setZoom(this.zoom * 1.25);
    this.$('zoom-out').onclick = () => this.setZoom(this.zoom / 1.25);
    this.$('zoom-fit').onclick = () => { this.zoom = 1; this.camHome(true); };
    window.addEventListener('resize', () => this.fitBoard());
    // Aba escondida: a animação é abandonada (timers ficam lentíssimos em segundo plano)
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.skipAnim(); });

    // Arrastar (mouse ou dedo) move a câmera; roda do mouse dá zoom
    const wrap = this.$('board-wrap');
    let drag = null;
    wrap.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y };
      this._dragged = false;
    });
    window.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) this._dragged = true;
      if (!this._dragged) return;
      this.cam = { x: drag.cx - dx / this.cam.z, y: drag.cy - dy / this.cam.z, z: this.cam.z };
      this.applyCam(false);
    });
    window.addEventListener('pointerup', () => { drag = null; setTimeout(() => { this._dragged = false; }, 0); });
    wrap.addEventListener('wheel', e => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // Música de fundo (preferência salva no navegador)
    const mb = this.$('btn-music');
    const syncMusic = () => {
      mb.setAttribute('aria-pressed', String(Music.on));
      mb.querySelector('.music-icon').textContent = Music.on ? '🎵' : '🔇';
    };
    mb.onclick = () => { Music.toggle(); syncMusic(); };
    syncMusic();

    // Cronômetro da partida
    setInterval(() => {
      const s = this.state, el = this.$('g-timer');
      if (!s || !el) return;
      if (!s.timeLimitMs) { el.textContent = 'sem limite'; return; }
      // Conta localmente a partir do último estado recebido (sem depender do relógio do host)
      const c = this._clock;
      const left = Math.max(0, c.left - (s.phase === 'gameover' ? 0 : Date.now() - c.at));
      el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    }, 1000);
  },
};

// Exporta o motor para testes em Node
if (typeof module !== 'undefined') {
  module.exports = { Player, CARDS, createGame, applyAction, tick, autoLiquidate, liquidationValue, netWorth, calcRent, currentPlayer, pById, hydrate, buildCost };
}
