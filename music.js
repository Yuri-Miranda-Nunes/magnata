/* =========================================================================
 * music.js — Trilha de fundo gerada na hora com Web Audio (sem arquivos de áudio)
 * Um loop calmo de 8 compassos: acordes suaves, baixo e notas soltas por cima.
 * ========================================================================= */

const Music = {
  on: false,
  ctx: null,
  master: null,
  timer: null,
  nextBar: 0,
  bar: 0,
  BEAT: 60 / 88,   // 88 batidas por minuto
  // Progressão: baixo (MIDI) + notas do acorde
  PROG: [
    [38, [53, 57, 60, 64]],   // Rém9
    [43, [53, 59, 64, 69]],   // Sol13
    [36, [52, 55, 59, 62]],   // Dó7M(9)
    [45, [55, 61, 64, 67]],   // Lá7
    [41, [52, 57, 60, 64]],   // Fá7M
    [40, [50, 56, 59, 62]],   // Mi7
    [45, [55, 60, 64, 71]],   // Lám9
    [43, [53, 59, 62, 64]],   // Sol7(13)
  ],

  init() {
    this.on = localStorage.getItem('magnata-musica') === '1';
    // O navegador só libera o som depois de um clique: se estava ligada, começa no primeiro toque
    if (this.on) addEventListener('pointerdown', () => { if (this.on) this.start(); }, { once: true });
    // Aba escondida: pausa (os timers ficam lentos e o som picotaria)
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (this.on) this.ctx.resume();
    });
  },

  toggle() {
    this.on = !this.on;
    localStorage.setItem('magnata-musica', this.on ? '1' : '0');
    if (this.on) this.start(); else this.stop();
  },

  start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      this.master.connect(lp);
      lp.connect(this.ctx.destination);
    }
    this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0.14, t, 0.8);   // entra devagar
    if (!this.timer) {
      this.nextBar = Math.max(this.nextBar, t + 0.1);
      this.timer = setInterval(() => this.schedule(), 250);
      this.schedule();
    }
  },

  stop() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.25);
    clearInterval(this.timer);
    this.timer = null;
  },

  // Agenda os compassos com 1,5 s de antecedência
  schedule() {
    while (this.nextBar < this.ctx.currentTime + 1.5) {
      this.playBar(this.nextBar, this.PROG[this.bar % this.PROG.length]);
      this.nextBar += this.BEAT * 4;
      this.bar++;
    }
  },

  note(midi, t, dur, type, vol, attack) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  },

  playBar(t, [root, chord]) {
    const b = this.BEAT;
    for (const n of chord) this.note(n, t, b * 4 + 0.4, 'triangle', 0.035, 0.5);          // acorde
    for (const [beat, n, len] of [[0, root, 1.4], [1.5, root + 7, 0.5], [2, root, 1.4], [3.5, root + 7, 0.5]]) {
      this.note(n, t + beat * b, len * b, 'sine', 0.22, 0.02);                              // baixo (ritmo de bossa)
    }
    for (let k = 0; k < 8; k++) {                                                           // notas soltas
      if (Math.random() < 0.3) this.note(chord[Math.floor(Math.random() * chord.length)] + 12, t + k * b / 2, 0.7, 'sine', 0.06, 0.01);
    }
  },
};

Music.init();
