# 🏙️ Magnata — Tabuleiro Dinâmico Multiplayer

Jogo de compra e venda de imóveis para **2 a 8 jogadores**, jogado direto no navegador, **sem servidor**: os navegadores se conectam entre si (P2P via WebRTC/PeerJS).
O diferencial é o **tabuleiro dinâmico**: ele cresce conforme o número de jogadores na sala.

| Jogadores | Casas | Conjuntos de cor | Salário (passar no Início) | Dinheiro inicial |
|-----------|-------|------------------|----------------------------|------------------|
| 2–4       | 40    | 8                | R$ 1.500                   | R$ 15.000        |
| 5–6       | 52    | 11               | R$ 2.000                   | R$ 20.000        |
| 7–8       | 64    | 14               | R$ 2.500                   | R$ 25.000        |

## Como criar e entrar em uma sala

1. Abra o site, digite seu nome e escolha a cor do peão.
2. **Criar sala:** clique em **Criar Sala**. Aparece um código de 5 letras (ex.: `HJE5H`). Envie o código — ou o link do botão **Copiar link** — para os amigos.
3. **Entrar:** digite o código e clique em **Entrar com Código** (ou abra o link recebido).
4. Quem criou a sala é o **host**. Com 2 ou mais jogadores conectados, o host escolhe o limite de tempo e clica em **Iniciar Jogo**. Se alguém sair antes do início, ele some da lista e a sala só inicia com 2+ conectados.

## Como jogar

- **Sorteio da ordem:** no início, todos rolam os dados e quem tirar mais começa. Quem empatar rola de novo até desempatar.
- Na sua vez, clique em **🎲 Rolar Dados**. O peão anda casa a casa a soma dos dois dados. **Dupla** dá direito a jogar de novo; três duplas seguidas mandam para a prisão.
- **Propriedade livre:** abre um modal para comprar ou recusar.
- **Propriedade de outro jogador:** você paga aluguel automaticamente. O valor sobe com casas e hotel; conjunto completo sem construções paga aluguel em dobro. Estações cobram pelo número de estações do dono; companhias cobram *dados × multiplicador*.
- **Construir:** toque numa propriedade sua (no tabuleiro ou no painel). Só é possível construir se você tiver **todos os terrenos da mesma cor** e nenhum hipotecado. São até 4 casas + 1 hotel, e cada nível custa mais que o anterior.
- **Hipoteca:** recebe metade do preço; quitar custa 55% do preço. Hipotecadas não cobram aluguel.
- **Sorte / Cofre Comunitário:** 16 cartas em cada baralho (andar, voltar, ir para o Início, receber ou pagar, prisão, turno extra, Habeas Corpus…).
- **Prisão:** pague a fiança, use um Habeas Corpus ou tente tirar uma dupla. Na 3ª tentativa sem dupla, a fiança é paga automaticamente e você sai.
- **Dívida:** se faltar dinheiro, venda construções ou hipoteque até conseguir pagar, ou declare falência. Se nem vendendo tudo der para pagar, a falência é automática. Os bens vão para o credor (ou voltam ao banco).
- Clique em **Encerrar turno** para passar a vez.
- **Vitória:** o último jogador que não faliu vence. Se acabar o **limite de tempo** (padrão: 45 min), vence quem tiver o **maior patrimônio**.
- Turno parado por 60 s recebe uma ação automática, para a partida não travar.

### Quedas e reconexão
- **Atualizou a página?** O jogo guarda a sessão no `localStorage` e reconecta sozinho à mesma partida.
- **Um jogador caiu:** a vez dele é pulada e ele tem **90 s** para voltar. Depois disso, ele vai à falência e os bens voltam ao banco.
- **O host caiu:** o jogador conectado mais antigo da sala (menor posição) vira o novo host automaticamente, com o último estado recebido, e os outros se reconectam a ele.

## Arquitetura

| Arquivo      | Papel |
|--------------|-------|
| `index.html` | Lobby e tela do jogo |
| `style.css`  | Tabuleiro, peões, painéis e modais |
| `board.js`   | Gera o tabuleiro (casas, cores e preços) conforme o nº de jogadores e o desenha em CSS Grid |
| `game.js`    | Regras (classe `Player`, turnos, aluguel, construção, cartas, prisão, falência) e interface |
| `peer.js`    | Conexões PeerJS, protocolo de mensagens, eleição de host e reconexão |
| `test/sim.js`| Simulação em Node: bots jogam centenas de partidas e o teste confere invariantes do estado |

**O host é a autoridade única.** Os clientes só enviam intenções (`join`, `roll-dice`, `action`, `disconnect`). O host valida (vez, fase, dono), aplica a regra, sorteia os dados e envia o **estado completo** (`update-state`) para todos, numerado por `seq`. Como nenhum cliente altera o estado localmente, todas as telas mostram sempre o mesmo jogo.

Mensagens: `join`, `players-list`, `start-game`, `roll-dice`, `action`, `update-state`, `end-turn`, `disconnect`, além de `ping`/`pong` (detecção de queda) e `redirect`/`wait` (durante a eleição de host).

### Rodar localmente

```bash
python -m http.server 8000
```

Abra `http://localhost:8000` em duas abas para testar. Cada aba é um jogador.

```bash
node test/sim.js
```

## Tecnologias

- HTML5, CSS3 e [Tailwind CSS](https://tailwindcss.com) (CDN)
- JavaScript ES6+ puro, sem frameworks
- [PeerJS](https://peerjs.com) (WebRTC) via CDN, usando o servidor público de sinalização do PeerJS
- GitHub Pages (somente arquivos estáticos)

> Observação: conexões WebRTC entre redes muito restritivas (alguns 4G e redes corporativas) podem precisar de um servidor TURN. O jogo usa os servidores STUN/TURN padrão do PeerJS.

## Licença

[MIT](LICENSE)
