// Lightweight synthesized arcade SFX. No audio files, autoplay, or external service.
export class AudioFX {
  constructor() { this.ctx = null; this.enabled = true; }
  unlock() {
    if (!this.enabled) return;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.ctx ||= new Context();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { this.ctx = null; }
  }
  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) this.unlock();
    return this.enabled;
  }
  tone(start, end, duration, volume = .05, type = 'sine', delay = 0) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, start), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), at + duration);
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + .01);
  }
  shoot() { this.tone(280, 95, .075, .028, 'square'); }
  cache() { this.tone(130, 40, .17, .07, 'sawtooth'); this.tone(490, 210, .14, .04, 'triangle', .05); }
  pickup() { this.tone(450, 750, .12, .045, 'sine'); this.tone(700, 1080, .16, .04, 'sine', .08); }
  dash() { this.tone(220, 580, .13, .035, 'sawtooth'); }
  hurt() { this.tone(185, 60, .21, .055, 'triangle'); }
  win() { this.tone(395, 395, .2, .055, 'triangle'); this.tone(525, 525, .2, .055, 'triangle', .12); this.tone(790, 790, .38, .06, 'triangle', .24); }
  fail() { this.tone(240, 95, .3, .04, 'sawtooth'); }
  crate() { this.tone(280, 620, .19, .055, 'triangle'); this.tone(540, 1050, .24, .045, 'triangle', .13); }
}
