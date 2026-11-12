/* =========================================================================
 * board.js — Geração dinâmica do tabuleiro e renderização em CSS Grid
 * O número de casas, conjuntos de cor e valores depende do nº de jogadores.
 * ========================================================================= */
'use strict';

// Faixas da especificação: casas, conjuntos, salário e dinheiro inicial
const BOARD_PRESETS = [
  { maxPlayers: 4, tiles: 40, groups: 8,  salary: 1500, initialMoney: 15000, utils: 2, taxes: 2, chance: 3, community: 3 },
  { maxPlayers: 6, tiles: 52, groups: 11, salary: 2000, initialMoney: 20000, utils: 2, taxes: 3, chance: 4, community: 4 },
  { maxPlayers: 8, tiles: 64, groups: 14, salary: 2500, initialMoney: 25000, utils: 3, taxes: 3, chance: 5, community: 5 },
];

// Cores dos conjuntos (do mais barato ao mais caro)
const GROUP_COLORS = ['#8d5524', '#7dd3fc', '#ec4899', '#f97316', '#ef4444', '#facc15', '#22c55e', '#1e40af',
                      '#14b8a6', '#a855f7', '#84cc16', '#64748b', '#fb7185', '#a16207'];

// Nomes fictícios de ruas (os dois últimos são sempre o conjunto mais caro)
const STREET_NAMES = [
  'Beco das Andorinhas', 'Rua do Orvalho',
  'Rua das Acácias', 'Travessa do Moinho', 'Rua dos Ipês',
  'Av. das Palmeiras', 'Rua do Farol', 'Alameda dos Sabiás',
  'Rua da Ventania', 'Praça das Bromélias', 'Av. Horizonte',
  'Rua dos Cristais', 'Alameda Aurora', 'Av. das Gaivotas',
  'Rua do Sol Poente', 'Praça Esmeralda', 'Av. Monte Verde',
  'Rua das Hortênsias', 'Alameda Primavera', 'Av. Litorânea',
  'Travessa do Cedro', 'Rua Vale Dourado', 'Av. Mirante',
  'Rua das Orquídeas', 'Praça do Relógio', 'Av. dos Ventos',
  'Alameda Safira', 'Rua Bela Vista', 'Av. Imperial',
  'Rua do Cais', 'Praça da Lua', 'Av. Atlântida',
  'Alameda Jardim Real', 'Rua das Nascentes', 'Av. Pérola',
  'Rua Topázio', 'Praça Diamante', 'Av. Coroa de Ouro',
  'Alameda dos Magnatas', 'Av. do Império',
];
const RAIL_NAMES = ['Estação Sul', 'Estação Oeste', 'Estação Norte', 'Estação Leste'];
const UTIL_NAMES = ['Cia. de Energia', 'Cia. de Água', 'Cia. de Internet'];
const UTIL_ICONS = ['💡', '🚰', '📡'];
const TAX_NAMES = ['Imposto de Renda', 'Taxa de Luxo', 'Taxa Municipal'];
const TAX_VALUES = [2000, 1000, 1500];

const round10 = v => Math.round(v / 10) * 10;
const round50 = v => Math.round(v / 50) * 50;

// Formata dinheiro no padrão brasileiro
function fmt(v) { return 'R$ ' + Math.round(v).toLocaleString('pt-BR'); }

// Escapa texto vindo de outros jogadores antes de inserir como HTML
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function presetFor(numPlayers) {
  return BOARD_PRESETS.find(p => numPlayers <= p.maxPlayers) || BOARD_PRESETS[BOARD_PRESETS.length - 1];
}

/**
 * Gera a configuração completa do tabuleiro para N jogadores.
 * Retorna { tiles: [...casas], side, salary, initialMoney, groups, ... }.
 */
function generateBoard(numPlayers) {
  const cfg = presetFor(numPlayers);
  const N = cfg.tiles;
  const S = (N - 4) / 4;            // casas por lado, sem contar os cantos
  const L = S + 1;                  // distância entre cantos
  const f = cfg.salary / 1500;      // fator de escala de preços conforme o tamanho
  const tiles = new Array(N).fill(null);
  const make = (id, name, type, extra = {}) => ({
    id, name, type, colorGroup: null, price: 0, rent: [], owner: null, level: 0, mortgage: false, ...extra,
  });

  // 1) Cantos: início, prisão, praça livre e "vá para a prisão"
  [['Início', 'start', '🏁'], ['Prisão / Visita', 'jail', '🔒'], ['Praça Livre', 'parking', '🌳'], ['Vá para a Prisão', 'gotojail', '👮']]
    .forEach(([name, corner, icon], s) => { tiles[s * L] = make(s * L, name, 'corner', { corner, icon }); });

  // 2) Uma estação no meio de cada lado
  for (let s = 0; s < 4; s++) {
    const id = s * L + 1 + Math.floor(S / 2);
    tiles[id] = make(id, RAIL_NAMES[s], 'railroad', {
      price: round10(2000 * f), rent: [400, 800, 1600, 3200].map(v => round10(v * f)), icon: '🚉',
    });
  }

  // 3) Casas especiais intercaladas e espalhadas uniformemente nos espaços livres
  const counts = { community: cfg.community, tax: cfg.taxes, chance: cfg.chance, utility: cfg.utils };
  const total = cfg.community + cfg.taxes + cfg.chance + cfg.utils;
  const order = [];
  while (order.length < total) for (const k of Object.keys(counts)) if (counts[k]-- > 0) order.push(k);
  let free = tiles.map((t, i) => (t ? -1 : i)).filter(i => i >= 0);
  let u = 0, x = 0;
  order.forEach((kind, j) => {
    const id = free[Math.floor((j + 0.5) * free.length / total)];
    if (kind === 'utility') {
      tiles[id] = make(id, UTIL_NAMES[u], 'utility', { price: round10(1500 * f), rent: [40, 100, 150].map(v => Math.round(v * f)), icon: UTIL_ICONS[u] });
      u++;
    } else if (kind === 'tax') {
      tiles[id] = make(id, TAX_NAMES[x], 'tax', { price: round10(TAX_VALUES[x] * f), icon: '💸' });
      x++;
    } else if (kind === 'chance') {
      tiles[id] = make(id, 'Sorte', 'chance', { icon: '❓' });
    } else {
      tiles[id] = make(id, 'Cofre Comunitário', 'community', { icon: '🎁' });
    }
  });

  // 4) Os espaços restantes viram propriedades, agrupadas por cor e com preço crescente
  free = tiles.map((t, i) => (t ? -1 : i)).filter(i => i >= 0);
  const groups = {};
  let slot = 0, nameIdx = 0;
  for (let g = 0; g < cfg.groups; g++) {
    const size = (g === 0 || g === cfg.groups - 1) ? 2 : 3;
    const t = g / (cfg.groups - 1);                 // 0 = mais barato, 1 = mais caro
    const base = (600 + 3400 * t) * f;
    const key = 'g' + g;
    groups[key] = { color: GROUP_COLORS[g], size, houseCost: round50(base * 0.6) };
    const names = g === cfg.groups - 1 ? STREET_NAMES.slice(-2) : STREET_NAMES.slice(nameIdx, nameIdx + size);
    nameIdx += size;
    for (let k = 0; k < size; k++) {
      const id = free[slot++];
      const price = round10(base * (1 + 0.1 * k));
      const r = price * (0.10 + 0.12 * t);           // aluguel base: 10% a 22% do preço (partidas mais curtas)
      tiles[id] = make(id, names[k], 'property', {
        colorGroup: key, price, houseCost: groups[key].houseCost,
        // [sem construção, 1 casa, 2, 3, 4 casas, hotel]
        rent: [1, 5, 14, 35, 45, 55].map(m => round10(r * m)),
      });
    }
  }
  if (slot !== free.length) throw new Error('Tabuleiro inconsistente: sobraram casas sem tipo');

  return {
    numPlayers, size: N, side: S, sets: cfg.groups, salary: cfg.salary, initialMoney: cfg.initialMoney,
    factor: f, groups, tiles, jailIndex: L, parkingIndex: 2 * L, goToJailIndex: 3 * L,
  };
}

/* ------------------------------ Renderização ------------------------------ */

// Linha/coluna da casa i no grid (início no canto inferior direito, sentido horário)
function tileGridPos(i, S) {
  const G = S + 2, L = S + 1;
  if (i <= L) return { row: G, col: G - i };
  if (i <= 2 * L) return { row: G - (i - L), col: 1 };
  if (i <= 3 * L) return { row: 1, col: 1 + (i - 2 * L) };
  return { row: 1 + (i - 3 * L), col: G };
}

function tileSide(i, S) {
  const L = S + 1;
  return i % L === 0 ? 'corner' : ['bottom', 'left', 'top', 'right'][Math.floor(i / L)];
}

// Monta o grid do tabuleiro uma única vez por partida
function buildBoardDOM(el, board) {
  const S = board.side, G = S + 2;
  el.style.setProperty('--side', S);
  el.innerHTML = board.tiles.map((t, i) => {
    const { row, col } = tileGridPos(i, S);
    const color = t.colorGroup ? board.groups[t.colorGroup].color : null;
    const price = t.type === 'tax' ? '-' + fmt(t.price) : (t.price ? fmt(t.price) : '');
    return `<div class="tile tile-${tileSide(i, S)} type-${t.type}" data-tile="${i}" style="grid-row:${row};grid-column:${col}" title="${esc(t.name)}">
      ${color ? `<div class="tile-band" style="background:${color}"></div>` : ''}
      <div class="tile-body">
        ${t.icon ? `<span class="tile-icon">${t.icon}</span>` : ''}
        <span class="tile-name">${esc(t.name)}</span>
        ${price ? `<span class="tile-price">${price}</span>` : ''}
      </div>
      <div class="tile-level"></div>
      <div class="tile-tokens"></div>
    </div>`;
  }).join('') + `<div class="board-center" style="grid-row:2/${G};grid-column:2/${G}">
      <div class="center-title">MAGNATA</div>
      <div class="center-sub">${board.size} casas · ${board.sets} conjuntos · salário ${fmt(board.salary)}</div>
      <div id="dice" class="dice-tray"><div class="die">${dieFaceHTML(1)}</div><div class="die">${dieFaceHTML(1)}</div></div>
      <div id="center-turn" class="center-turn"></div>
      <div id="center-order" class="center-order hidden"></div>
      <div id="center-card" class="center-card hidden"></div>
    </div>`;
}

// Pontos de cada face do dado numa grade 3x3 (posições 1–9)
const DIE_PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
function dieFaceHTML(n) {
  return Array.from({ length: 9 }, (_, i) => `<span class="pip${DIE_PIPS[n].includes(i + 1) ? ' on' : ''}"></span>`).join('');
}

/**
 * Atualiza donos, construções, hipotecas e posição dos peões.
 * shownPos permite desenhar um peão numa casa intermediária durante a animação.
 */
function updateBoardDOM(el, state, shownPos = {}, movingId = null) {
  const colorOf = {};
  state.players.forEach(p => { colorOf[p.id] = p.corPeao; });
  state.board.tiles.forEach((t, i) => {
    const cell = el.querySelector(`[data-tile="${i}"]`);
    if (!cell) return;
    cell.classList.toggle('owned', !!t.owner);
    cell.classList.toggle('mortgaged', !!t.mortgage);
    cell.style.setProperty('--owner', t.owner ? colorOf[t.owner] : 'transparent');
    cell.querySelector('.tile-level').textContent = t.level === 5 ? '🏨' : '🏠'.repeat(t.level);
    cell.querySelector('.tile-tokens').innerHTML = '';
  });
  // Peões: posicionados em coordenadas absolutas relativas à célula
  const onTile = {};
  state.players.filter(p => !p.bancarroto).forEach(p => {
    const pos = shownPos[p.id] ?? p.posicao;
    const k = (onTile[pos] = (onTile[pos] || 0) + 1) - 1;
    const box = el.querySelector(`[data-tile="${pos}"] .tile-tokens`);
    if (!box) return;
    const tok = document.createElement('span');
    tok.className = 'token' + (state.turnos[state.turnoAtual] === p.id && state.phase !== 'order' ? ' token-active' : '')
      + (p.conectado ? '' : ' token-away') + (p.id === movingId ? ' token-hop' : '');
    tok.style.setProperty('--pc', p.corPeao);
    tok.style.left = (6 + (k % 4) * 23) + '%';
    tok.style.top = (8 + Math.floor(k / 4) * 42) + '%';
    tok.textContent = p.nome.charAt(0).toUpperCase();
    tok.title = p.nome;
    box.appendChild(tok);
  });
}

// Disponibiliza para testes em Node
if (typeof module !== 'undefined') module.exports = { generateBoard, tileGridPos, fmt, esc, presetFor };
