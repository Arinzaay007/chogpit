import { WORLD_W, WORLD_H, clamp, hash, circleRect, BOT_STARTS, LIVE_SPAWNS, buildArenaWorld } from './arena-world.js';

const MATCH_TIME = 180;
const REQUIRED_SUPPLIES = 2;
const TILE = 64;
const TAU = Math.PI * 2;
const formatClock = t => `${String(Math.floor(Math.max(0, t) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
const payoutForRun = ({ won = false, loot = 0, kills = 0, timeLeft = 0 } = {}) => {
  const supplies = clamp(Math.floor(Number(loot) || 0), 0, 25);
  const eliminations = clamp(Math.floor(Number(kills) || 0), 0, 100);
  const escaped = won === true && supplies >= REQUIRED_SUPPLIES;
  if (!escaped) return { key: 'lost', name: 'HAUL LOST', crates: 0, score: 0 };
  const tier = supplies >= 6 && eliminations >= 2 ? { key: 'legend', name: 'PIT LEGEND', crates: 3 }
    : supplies >= 4 || eliminations >= 2 ? { key: 'heist', name: 'DOUBLE HAUL', crates: 2 }
    : { key: 'safe', name: 'SAFE EXIT', crates: 1 };
  return { ...tier, score: supplies * 150 + eliminations * 100 + Math.round(clamp(Number(timeLeft) || 0, 0, MATCH_TIME)) };
};
const WEAPONS = {
  PEASHOOTER: { rate: .27, speed: 760, damage: 23, spread: .035, pellets: 1, mag: Infinity, reserve: Infinity, color: '#ffe26b', icon: '⌖' },
  SMG: { rate: .09, speed: 750, damage: 13, spread: .13, pellets: 1, mag: 42, reserve: 170, color: '#fff799', icon: '▥' },
  RIFLE: { rate: .17, speed: 920, damage: 27, spread: .045, pellets: 1, mag: 28, reserve: 112, color: '#ffdc56', icon: '➤' },
  SHOTGUN: { rate: .72, speed: 640, damage: 15, spread: .37, pellets: 6, mag: 8, reserve: 40, color: '#ffc281', icon: '✳' },
  BLASTER: { rate: .34, speed: 620, damage: 35, spread: .025, pellets: 1, mag: 18, reserve: 72, color: '#e8a1ff', icon: 'ϟ' }
};
const SCAR_COLORS = { acid: '#e5f65f', static: '#c9a4fd', spores: '#ffc2e2' };
const TRAP_SYMBOLS = { turret: '⌖', mine: '✸', slime: '◉', pulse: 'ϟ' };

export class PitGame {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.miniCanvas = document.getElementById('miniMap');
    this.miniCtx = this.miniCanvas?.getContext('2d');
    this.callbacks = callbacks;
    this.viewW = 1280; this.viewH = 720; this.dpr = 1;
    this.mode = 'preview';
    this.orientationBlocked = false;
    this.arena = { id: 'demo', traps: [], scars: [], genome: 'demo' };
    this.camera = { x: 300, y: 530 };
    this.keys = new Set();
    this.pointer = { x: 820, y: 360, down: false, seen: false };
    this.touch = { move: null, aim: null };
    this.moveStick = document.getElementById('moveStick');
    this.moveKnob = document.getElementById('moveKnob');
    this.touchUsed = false; this.lastTouchAngle = 0; this.buttonFiring = false;
    this.buildTouch = null;
    this.selectedTrap = 'turret'; this.equippedMod = null;
    this.clock = 0; this.lastFrame = 0; this.hudClock = 0; this.miniClock = 0;
    this.particles = []; this.floaters = []; this.shake = 0;
    this.generateWorld(); this.resetRun(); this.mode = 'preview';
    this.bindEvents(); this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    requestAnimationFrame(t => this.frame(t));
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.viewW = Math.max(1, rect.width); this.viewH = Math.max(1, rect.height);
    this.dpr = Math.min(matchMedia('(pointer:coarse)').matches ? 1.5 : 2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.viewW * this.dpr);
    this.canvas.height = Math.round(this.viewH * this.dpr);
    this.ctx.imageSmoothingEnabled = false;
  }

  setArena(arena) {
    this.arena = { id: arena.id, genome: arena.genome || arena.id, traps: (arena.traps || []).map(t => ({ ...t })), scars: (arena.scars || []).map(s => ({ ...s })) };
    this.generateWorld(); this.resetRun(); this.mode = 'preview';
    this.callbacks.onBuildChanged?.(this.arena.traps);
  }
  setPreview() { this.mode = 'preview'; this.buildTouch = null; this.resetRun(); }
  equipMod(name) { this.equippedMod = name || null; }
  setHero(hero) { this.hero = hero || null; // CHOGPIT Hero replica drives look + stats
    if (this.player) { if (hero) { this.player.heroName = hero.name; this.player.color = hero.bgColor; this.player.heroWeapon = hero.weapon; } else { this.player.heroName = null; this.player.color = null; } }
  }
  setSelectedTrap(type) { this.selectedTrap = type; }
  clearTouch() {
    this.touch.move = null; this.touch.aim = null; this.buttonFiring = false; this.pointer.down = false;
    this.syncMoveStick();
  }
  setOrientationBlocked(blocked) {
    const next = !!blocked;
    if (this.orientationBlocked === next) return;
    this.orientationBlocked = next;
    // A rotating screen must never leave a thumb, FIRE, DASH or EXIT held.
    this.keys.clear(); this.clearTouch();
    this.onlineDash = false; this.onlineReload = false; this.onlineInteract = false;
    this.onlineInputClock = 0;
    this.lastFrame = performance.now();
  }
  syncMoveStick() {
    if (!this.moveStick || !this.moveKnob) return;
    const move = this.touch.move;
    this.moveStick.classList.toggle('active', !!move);
    if (!move) {
      this.moveStick.style.left = ''; this.moveStick.style.top = ''; this.moveStick.style.bottom = '';
      this.moveKnob.style.transform = '';
      return;
    }
    const x = clamp(move.origin.x, 56, Math.max(56, this.viewW * .48 - 22));
    const y = clamp(move.origin.y, 56, Math.max(56, this.viewH - 56));
    this.moveStick.style.left = `${Math.round(x - 54)}px`;
    this.moveStick.style.top = `${Math.round(y - 54)}px`;
    this.moveStick.style.bottom = 'auto';
    const dx = move.current.x - move.origin.x, dy = move.current.y - move.origin.y;
    const scale = Math.min(1, 34 / (Math.hypot(dx, dy) || 1));
    this.moveKnob.style.transform = `translate(${Math.round(dx * scale)}px, ${Math.round(dy * scale)}px)`;
  }
  autoAimAtRival() {
    if (this.touch.aim || !['play', 'online'].includes(this.mode)) return;
    let nearest = null, range = 600;
    const rivals = this.mode === 'online' ? this.onlinePlayers.filter(p => p.status === 'active'
      && (this.onlineRoomMode === 'pvp' ? p.id !== this.onlineSelfId && !p.id.startsWith('bot:') : p.id.startsWith('bot:')))
      : this.bots.filter(bot => bot.hp > 0);
    for (const rival of rivals) {
      const d = Math.hypot(rival.x - this.player.x, rival.y - this.player.y);
      if (d < range && this.canSee(this.player, rival)) { nearest = rival; range = d; }
    }
    if (nearest) {
      this.player.angle = Math.atan2(nearest.y - this.player.y, nearest.x - this.player.x);
      this.lastTouchAngle = this.player.angle;
    }
  }
  setFiring(held, touch = false) {
    if (touch) { this.touchUsed = true; this.pointer.seen = false; }
    this.buttonFiring = !this.orientationBlocked && !!held && ['play', 'online'].includes(this.mode);
    if (this.buttonFiring && this.mode === 'play') { if (this.touchUsed) this.autoAimAtRival(); this.firePlayer(); }
  }
  enterBuilder() { this.mode = 'build'; this.keys.clear(); this.clearTouch(); this.buildTouch = null; this.camera.x = clamp(1660 - this.viewW / 2, 0, WORLD_W - this.viewW); this.camera.y = clamp(1170 - this.viewH / 2, 0, WORLD_H - this.viewH); }
  undoTrap() { if (this.mode !== 'build' || !this.arena.traps.length) return; this.arena.traps.pop(); this.callbacks.onBuildChanged?.(this.arena.traps); }

  generateWorld() {
    Object.assign(this, buildArenaWorld(this.arena.genome || this.arena.id));
  }

  resetRun() {
    this.keys.clear(); this.clearTouch(); this.touchUsed = false; this.lastTouchAngle = 0; this.pointer.seen = false;
    this.player = { x: this.spawn.x, y: this.spawn.y, r: 19, hp: 100, shield: 30, angle: 0, hurt: 0, fireCd: 0, reload: 0, dashCd: 0, dashTime: 0, dashX: 0, dashY: 0, weapon: 'PEASHOOTER', ammo: Infinity, reserve: Infinity };
    this.timeLeft = MATCH_TIME; this.kills = 0; this.loot = 0; this.extractHold = 0;
    this.bullets = []; this.particles = []; this.floaters = [];
    this.caches = this.cacheSpots.map((p, i) => ({ ...p, id: i, opened: false }));
    this.rewardBoxes = []; // Revealed only by nearby authoritative server snapshots.
    this.supplyDrops = [];
    this.weaponDrops = this.weaponSpots.map(w => ({ ...w, taken: false }));
    this.traps = this.arena.traps.map((t, i) => ({ ...t, cd: 1 + i * .2, fired: false }));
    this.scars = this.arena.scars.map((s, i) => ({ ...s, cd: i + 1 }));
    this.bots = [];
    this.respawnTimers = [];
    this.camera.x = clamp(this.player.x - this.viewW / 2, 0, Math.max(0, WORLD_W - this.viewW));
    this.camera.y = clamp(this.player.y - this.viewH / 2, 0, Math.max(0, WORLD_H - this.viewH));
    this.clock = 0; this.shake = 0; this.pointer.down = false; this.buttonFiring = false; this.lastTouchAngle = 0;
  }

  start() {
    this.resetRun();
    this.mode = 'play';
    BOT_STARTS.forEach(([x, y], index) => this.spawnBot(x, y, index));
    this.callbacks.onStart?.(); this.feed('DROP IN', 'Grab a gun and find loot.');
  }

  startOnline(arena, selfId, code, roomMode = 'pvp') {
    this.setArena(arena); this.mode = 'online'; this.onlineSelfId = selfId; this.onlineRoomCode = code;
    this.onlineRoomMode = roomMode; this.onlineSelfStatus = 'active'; this.onlinePlayers = []; this.onlineInputClock = 0;
    this.onlineDash = false; this.onlineReload = false; this.onlineInteract = false;
    const title = roomMode === 'solo' ? 'SERVER SOLO' : roomMode === 'coop' ? 'CO-OP VS BOTS' : 'LIVE PVP';
    const note = roomMode === 'coop' ? 'Fight bots together · friendly fire off · five lives each.'
      : roomMode === 'pvp' ? 'Fight each other · five lives each.' : 'Fight server-run bots.';
    this.feed(title, `${note} Hidden boxes are preview-only.`);
  }
  applyOnlineSnapshot(snapshot) {
    if (this.mode !== 'online' || snapshot.code !== this.onlineRoomCode) return;
    this.timeLeft = snapshot.timeLeft;
    this.onlinePlayers = snapshot.players;
    this.rewardBoxes = snapshot.rewardBoxes || [];
    const self = snapshot.players.find(player => player.id === this.onlineSelfId);
    if (!self) return;
    if (self.loot > this.loot) this.callbacks.onLoot?.(self.loot);
    if (self.weapon !== this.player.weapon) this.callbacks.onPickup?.();
    if (self.hp < this.player.hp || self.shield < this.player.shield) this.callbacks.onHurt?.();
    Object.assign(this.player, self, { ammo: self.ammo < 0 ? Infinity : self.ammo, reserve: self.reserve < 0 ? Infinity : self.reserve });
    if (this.onlineSelfStatus === 'active' && self.status === 'respawning') {
      this.keys.clear(); this.clearTouch(); this.onlineDash = false;
      this.onlineReload = false; this.onlineInteract = false; this.onlineInputClock = 0;
    }
    this.onlineSelfStatus = self.status;
    this.loot = self.loot; this.kills = self.kills; this.extractHold = self.hold;
    const opened = new Set(snapshot.opened);
    for (const cache of this.caches) cache.opened = opened.has(cache.id);
    const taken = new Set(snapshot.takenWeapons);
    this.weaponDrops.forEach((drop, index) => { drop.taken = taken.has(index); });
    this.supplyDrops = snapshot.drops;
    this.bullets = snapshot.bullets;
    this.traps = snapshot.traps;
  }
  updateOnline(dt) {
    this.clock += dt;
    const p = this.player;
    if (this.onlineSelfStatus === 'active') {
      let mx = Number(this.keys.has('d') || this.keys.has('arrowright')) - Number(this.keys.has('a') || this.keys.has('arrowleft'));
      let my = Number(this.keys.has('s') || this.keys.has('arrowdown')) - Number(this.keys.has('w') || this.keys.has('arrowup'));
      if (this.touch.move) {
        mx += clamp((this.touch.move.current.x - this.touch.move.origin.x) / 57, -1, 1);
        my += clamp((this.touch.move.current.y - this.touch.move.origin.y) / 57, -1, 1);
      }
      const len = Math.hypot(mx, my); if (len > 1) { mx /= len; my /= len; }
      if (this.touch.aim) {
        const target = this.touch.aim.current;
        p.angle = Math.atan2(target.y + this.camera.y - p.y, target.x + this.camera.x - p.x);
        this.lastTouchAngle = p.angle;
      } else if (this.touchUsed) {
        p.angle = this.lastTouchAngle;
        if (this.buttonFiring) this.autoAimAtRival();
      } else {
        const target = this.pointer.seen ? this.pointer : { x: this.viewW * .65, y: this.viewH * .5 };
        p.angle = Math.atan2(target.y + this.camera.y - p.y, target.x + this.camera.x - p.x);
      }
      this.onlineInputClock -= dt;
      if (this.onlineInputClock <= 0) {
        this.onlineInputClock = .05;
        this.callbacks.onOnlineInput?.({ dx: mx, dy: my, aim: p.angle,
          fire: this.pointer.down || !!this.touch.aim || this.buttonFiring || this.keys.has('f'),
          interact: this.keys.has('e') || this.onlineInteract, dash: this.onlineDash, reload: this.onlineReload });
        this.onlineDash = false; this.onlineReload = false; this.onlineInteract = false;
      }
    }
    const desiredX = clamp(p.x - this.viewW / 2, 0, Math.max(0, WORLD_W - this.viewW));
    const desiredY = clamp(p.y - this.viewH / 2, 0, Math.max(0, WORLD_H - this.viewH));
    this.camera.x += (desiredX - this.camera.x) * Math.min(1, dt * 9);
    this.camera.y += (desiredY - this.camera.y) * Math.min(1, dt * 9);
    this.hudClock -= dt;
    if (this.hudClock <= 0) {
      this.hudClock = .09;
      const nearExtract = Math.hypot(p.x - this.extract.x, p.y - this.extract.y) < 79;
      const holdTime = 1.5 + Math.min(4, Math.max(0, this.loot - REQUIRED_SUPPLIES)) * .35;
      this.callbacks.onStatus?.({ hp: p.hp, shield: p.shield, weapon: p.weapon,
        ammo: p.ammo, reserve: p.reserve, reloading: p.reload > 0, kills: this.kills,
        loot: this.loot, heat: Math.max(0, this.loot - REQUIRED_SUPPLIES), time: this.timeLeft,
        livesLeft: p.livesLeft, alive: this.onlinePlayers.filter(rival => rival.status === 'active').length,
        botsAlive: this.onlinePlayers.filter(rival => rival.id.startsWith('bot:') && rival.status === 'active').length,
        dash: p.dashCd,
        extractDistance: Math.round(Math.hypot(p.x - this.extract.x, p.y - this.extract.y)),
        nearExtract, holdTime, extractProgress: this.extractHold / holdTime,
        action: this.nearbyAction(), storm: this.timeLeft < 114 });
    }
  }

  spawnBot(x, y, index) {
    const colors = ['#f7c942', '#ee657d', '#5bc9ef', '#ff9658', '#a583ec'];
    const candidate = { x, y, r: 18 };
    if (this.obstacles.some(box => circleRect(x, y, 28, box))) {
      candidate.x += 100; candidate.y += 90;
    }
    this.bots.push({ id: `${index}-${Math.floor(this.clock * 10)}`, x: candidate.x, y: candidate.y, r: 18, hp: 74, maxHp: 74, angle: 0, speed: 128 + (index % 4) * 10, shotCd: .6 + (index % 3) * .3, roamCd: 0, roamX: 0, roamY: 0, hurt: 0, color: colors[index % colors.length], name: ['SCOUT', 'GUNK', 'BOLT', 'SNAP', 'JINX'][index % 5] });
  }

  bindEvents() {
    window.addEventListener('keydown', event => {
      if (this.orientationBlocked || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      const key = event.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) event.preventDefault();
      this.keys.add(key);
      if (key === ' ' && ['play', 'online'].includes(this.mode)) this.dash();
      if (key === 'e' && ['play', 'online'].includes(this.mode)) this.interact();
      if (key === 'r' && ['play', 'online'].includes(this.mode)) this.reload();
      if (key === 'p') {
        if (this.mode === 'online') this.callbacks.onRoomMenu?.();
        else if (this.mode === 'play') { this.mode = 'paused'; this.callbacks.onPause?.(true); }
        else if (this.mode === 'paused') { this.mode = 'play'; this.callbacks.onPause?.(false); }
      }
    });
    window.addEventListener('keyup', event => this.keys.delete(event.key.toLowerCase()));
    const pauseOnLeave = () => {
      this.keys.clear(); this.clearTouch();
      if (this.mode === 'play') { this.mode = 'paused'; this.callbacks.onPause?.(true); }
    };
    window.addEventListener('blur', pauseOnLeave);
    document.addEventListener('visibilitychange', () => { if (document.hidden) pauseOnLeave(); });
    this.canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.canvas.addEventListener('pointerdown', event => {
      const pos = this.getPointer(event);
      if (event.pointerType === 'touch') {
        event.preventDefault(); this.canvas.setPointerCapture(event.pointerId);
        this.touchUsed = true; this.pointer.seen = false;
        if (this.mode === 'build') { this.buildTouch = { id: event.pointerId, start: pos, last: pos, moved: false }; return; }
        if (!['play', 'online'].includes(this.mode)) return;
        if (pos.x < this.viewW * .48 && !this.touch.move) {
          this.touch.move = { id: event.pointerId, origin: pos, current: pos };
          this.syncMoveStick();
        } else if (!this.touch.aim) this.touch.aim = { id: event.pointerId, current: pos };
      } else { this.touchUsed = false; this.pointer.x = pos.x; this.pointer.y = pos.y; this.pointer.seen = true; if (event.button === 0) this.pointer.down = true; }
      if (this.mode === 'build' && event.button !== 2) this.placeTrap(pos);
    });
    this.canvas.addEventListener('pointermove', event => {
      const pos = this.getPointer(event);
      if (event.pointerType === 'touch') {
        if (this.mode === 'build' && this.buildTouch?.id === event.pointerId) {
          const touch = this.buildTouch;
          if (Math.hypot(pos.x - touch.start.x, pos.y - touch.start.y) > 8) touch.moved = true;
          if (touch.moved) {
            this.camera.x = clamp(this.camera.x - (pos.x - touch.last.x), 0, Math.max(0, WORLD_W - this.viewW));
            this.camera.y = clamp(this.camera.y - (pos.y - touch.last.y), 0, Math.max(0, WORLD_H - this.viewH));
          }
          touch.last = pos; return;
        }
        if (this.touch.move?.id === event.pointerId) { this.touch.move.current = pos; this.syncMoveStick(); }
        if (this.touch.aim?.id === event.pointerId) this.touch.aim.current = pos;
      } else { this.touchUsed = false; this.pointer.x = pos.x; this.pointer.y = pos.y; this.pointer.seen = true; }
    });
    const end = event => {
      if (event.pointerType === 'touch') {
        if (this.buildTouch?.id === event.pointerId) {
          if (this.mode === 'build' && !this.buildTouch.moved && event.type === 'pointerup') this.placeTrap(this.buildTouch.start);
          this.buildTouch = null; return;
        }
        if (this.touch.move?.id === event.pointerId) { this.touch.move = null; this.syncMoveStick(); }
        if (this.touch.aim?.id === event.pointerId) this.touch.aim = null;
      } else this.pointer.down = false;
    };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
    window.addEventListener('pointerup', event => { if (event.pointerType !== 'touch') this.pointer.down = false; });
  }
  getPointer(event) { const rect = this.canvas.getBoundingClientRect(); return { x: clamp(event.clientX - rect.left, 0, rect.width), y: clamp(event.clientY - rect.top, 0, rect.height) }; }

  moveActor(actor, dx, dy) {
    actor.x = clamp(actor.x + dx, actor.r + 15, WORLD_W - actor.r - 15);
    if (this.obstacles.some(box => circleRect(actor.x, actor.y, actor.r, box))) actor.x -= dx;
    actor.y = clamp(actor.y + dy, actor.r + 15, WORLD_H - actor.r - 15);
    if (this.obstacles.some(box => circleRect(actor.x, actor.y, actor.r, box))) actor.y -= dy;
    actor.x = clamp(actor.x, actor.r + 15, WORLD_W - actor.r - 15);
    actor.y = clamp(actor.y, actor.r + 15, WORLD_H - actor.r - 15);
  }
  canSee(a, b) { for (const box of this.obstacles) { for (let t = .15; t < 1; t += .17) if (circleRect(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2, box)) return false; } return true; }

  dash() {
    const p = this.player;
    if (this.mode === 'online') {
      if (this.onlineSelfStatus === 'active' && p.dashCd <= 0) { this.onlineDash = true; this.callbacks.onDash?.(); }
      return;
    }
    if (this.mode !== 'play' || p.dashCd > 0) return;
    let mx = Number(this.keys.has('d') || this.keys.has('arrowright')) - Number(this.keys.has('a') || this.keys.has('arrowleft'));
    let my = Number(this.keys.has('s') || this.keys.has('arrowdown')) - Number(this.keys.has('w') || this.keys.has('arrowup'));
    if (this.touch.move) { mx += clamp((this.touch.move.current.x - this.touch.move.origin.x) / 55, -1, 1); my += clamp((this.touch.move.current.y - this.touch.move.origin.y) / 55, -1, 1); }
    if (!mx && !my) { mx = Math.cos(p.angle); my = Math.sin(p.angle); }
    const len = Math.hypot(mx, my) || 1; p.dashX = mx / len; p.dashY = my / len; p.dashTime = .19; p.dashCd = 3.6; p.hurt = .22;
    this.burst(p.x, p.y, this.equippedMod === 'NEON AFTERBURN' ? '#ff6ba1' : this.equippedMod === 'FROST AFTERIMAGE' ? '#8defff' : '#e0d363', 18, 230); this.callbacks.onDash?.();
  }
  reload() {
    if (this.mode === 'online') { this.onlineReload = true; return; }
    const p = this.player; const gun = WEAPONS[p.weapon];
    if (p.weapon === 'PEASHOOTER' || p.reload > 0 || p.ammo >= gun.mag || p.reserve <= 0) return;
    p.reload = p.weapon === 'SHOTGUN' ? 1.4 : 1.05; this.feed('RELOADING', p.weapon);
  }
  finishReload() { const p = this.player, gun = WEAPONS[p.weapon]; const amount = Math.min(gun.mag - p.ammo, p.reserve); p.ammo += amount; p.reserve -= amount; }

  interact() {
    if (this.mode === 'online') { this.onlineInteract = true; return; }
    if (this.mode !== 'play') return;
    const p = this.player;
    const cache = this.caches.find(c => !c.opened && Math.hypot(c.x - p.x, c.y - p.y) < 66);
    if (cache) return this.openCache(cache);
  }
  openCache(cache) {
    if (cache.opened) return; cache.opened = true; this.loot++; this.announceHeat();
    this.burst(cache.x, cache.y, '#ffe26e', 25, 230);
    const roll = (cache.id + this.kills + hash(this.arena.id)) % 4;
    if (roll === 0) this.player.shield = Math.min(75, this.player.shield + 24);
    if (roll === 1) this.player.hp = Math.min(100, this.player.hp + 18);
    if (roll === 2 && this.player.weapon !== 'PEASHOOTER') this.player.reserve += 35;
    this.floaters.push({ x: cache.x, y: cache.y - 42, text: '+1 LOOT', color: '#fff18b', life: 1.1 });
    this.feed('LOOT SECURED', `${this.loot} supply${this.loot === 1 ? '' : 'ies'} in your pack`);
    this.callbacks.onLoot?.(this.loot); this.callbacks.onCacheOpen?.();
  }
  announceHeat() {
    if (this.loot === 3 || this.loot === 5) {
      this.spawnHunter();
      this.feed(this.loot === 3 ? 'BOUNTY ALERT' : 'HIGH HEAT', 'A hunter is tracking your overloaded pack.');
    }
  }
  spawnHunter() {
    const p = this.player, dx = this.extract.x - p.x, dy = this.extract.y - p.y;
    const length = Math.hypot(dx, dy) || 1, nx = dx / length, ny = dy / length;
    const candidates = this.loot === 3 ? [
      { x: p.x + nx * 390 + ny * 170, y: p.y + ny * 390 - nx * 170 },
      { x: p.x + nx * 410 - ny * 150, y: p.y + ny * 410 + nx * 150 },
      { x: p.x - ny * 340, y: p.y + nx * 340 }
    ] : [
      { x: 2050, y: 1150 }, { x: 2120, y: 1120 },
      { x: p.x + nx * 310 + ny * 155, y: p.y + ny * 310 - nx * 155 }
    ];
    const point = candidates.map(c => ({ x: clamp(c.x, 90, WORLD_W - 90), y: clamp(c.y, 90, WORLD_H - 90) }))
      .find(c => Math.hypot(c.x - p.x, c.y - p.y) > 250 && this.obstacles.every(box => !circleRect(c.x, c.y, 30, box)));
    if (!point) return;
    this.spawnBot(point.x, point.y, 40 + this.loot);
    const hunter = this.bots.at(-1);
    hunter.hunter = true; hunter.color = '#df4c8d'; hunter.hp = 105; hunter.maxHp = 105;
    hunter.speed = 187; hunter.shotCd = .45; hunter.name = 'HUNTER';
    this.burst(point.x, point.y, '#ff8fb4', 24, 150);
  }
  pickupWeapon(drop) {
    if (drop.taken) return; drop.taken = true;
    const p = this.player, gun = WEAPONS[drop.weapon];
    p.weapon = drop.weapon; p.ammo = gun.mag; p.reserve = gun.reserve; p.reload = 0;
    this.feed('NEW WEAPON', drop.weapon); this.floaters.push({ x: drop.x, y: drop.y - 30, text: drop.weapon, color: '#fff289', life: 1.1 });
    this.callbacks.onPickup?.();
  }
  firePlayer() {
    const p = this.player, gun = WEAPONS[p.weapon];
    if (p.fireCd > 0 || p.reload > 0) return;
    if (p.ammo <= 0) { this.reload(); return; }
    p.fireCd = gun.rate; if (Number.isFinite(p.ammo)) p.ammo--;
    const color = this.equippedMod === 'PINK SPARKS' ? '#ff87ba' : this.equippedMod === 'EMBER TRACERS' ? '#ff985b' : gun.color;
    for (let i = 0; i < gun.pellets; i++) {
      const spread = gun.pellets === 1 ? (Math.random() - .5) * gun.spread : (i - (gun.pellets - 1) / 2) / (gun.pellets - 1) * gun.spread + (Math.random() - .5) * .04;
      const angle = p.angle + spread;
      this.bullets.push({ x: p.x + Math.cos(angle) * 29, y: p.y + Math.sin(angle) * 29, vx: Math.cos(angle) * gun.speed, vy: Math.sin(angle) * gun.speed, damage: gun.damage, owner: 'player', life: gun.pellets > 1 ? .65 : 1.1, color, r: gun.pellets > 1 ? 3 : 4 });
    }
    this.burst(p.x + Math.cos(p.angle) * 32, p.y + Math.sin(p.angle) * 32, color, gun.pellets > 1 ? 9 : 3, 75);
    this.shake = p.weapon === 'SHOTGUN' ? 5 : p.weapon === 'BLASTER' ? 3 : 1.5;
    this.callbacks.onShoot?.();
  }
  fireBot(bot, target) {
    const angle = Math.atan2(target.y - bot.y, target.x - bot.x) + (Math.random() - .5) * (bot.hunter ? .08 : .14);
    const speed = bot.hunter ? 680 : 590;
    this.bullets.push({ x: bot.x + Math.cos(angle) * 26, y: bot.y + Math.sin(angle) * 26, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, damage: bot.hunter ? 14 : 11, owner: bot.id, life: 1.25, color: bot.hunter ? '#ef75bb' : '#ff9189', r: 3 });
    this.burst(bot.x + Math.cos(angle) * 27, bot.y + Math.sin(angle) * 27, bot.hunter ? '#fc79c0' : '#ffc071', 3, 70);
  }

  frame(t) {
    const dt = Math.min(.04, Math.max(0, (t - (this.lastFrame || t)) / 1000)); this.lastFrame = t;
    // Local practice waits for the phone to turn; online rounds continue on
    // the server while we send neutral input until the display is landscape.
    if (this.mode === 'play') { if (!this.orientationBlocked) this.update(dt); }
    else if (this.mode === 'online') this.updateOnline(dt);
    else if (this.mode === 'build') this.updateBuilder(dt);
    else this.clock += dt * .35;
    this.updateParticles(dt);
    this.draw();
    requestAnimationFrame(next => this.frame(next));
  }

  update(dt) {
    this.clock += dt; this.timeLeft -= dt;
    const p = this.player;
    p.fireCd = Math.max(0, p.fireCd - dt); p.dashCd = Math.max(0, p.dashCd - dt); p.hurt = Math.max(0, p.hurt - dt);
    if (p.reload > 0) { p.reload -= dt; if (p.reload <= 0) { p.reload = 0; this.finishReload(); } }
    let mx = Number(this.keys.has('d') || this.keys.has('arrowright')) - Number(this.keys.has('a') || this.keys.has('arrowleft'));
    let my = Number(this.keys.has('s') || this.keys.has('arrowdown')) - Number(this.keys.has('w') || this.keys.has('arrowup'));
    if (this.touch.move) { mx += clamp((this.touch.move.current.x - this.touch.move.origin.x) / 57, -1, 1); my += clamp((this.touch.move.current.y - this.touch.move.origin.y) / 57, -1, 1); }
    const len = Math.hypot(mx, my); if (len > 1) { mx /= len; my /= len; }
    let speed = 250 + (this.hero?.speed ? (this.hero.speed - 5) * 18 : 0);
    for (const trap of this.traps) if (trap.type === 'slime' && Math.hypot(trap.x - p.x, trap.y - p.y) < 75) speed *= .62;
    for (const scar of this.scars) if (scar.type === 'spores' && Math.hypot(scar.x - p.x, scar.y - p.y) < 75) speed *= .68;
    if (p.dashTime > 0) { p.dashTime -= dt; mx = p.dashX; my = p.dashY; speed = 730; if (Math.random() < .7) this.burst(p.x, p.y, this.equippedMod === 'NEON AFTERBURN' ? '#ff72ac' : this.equippedMod === 'FROST AFTERIMAGE' ? '#85e8ff' : '#ddfb91', 1, 32); }
    this.moveActor(p, mx * speed * dt, my * speed * dt);
    if (this.equippedMod === 'TOXIC FOOTPRINTS' && (Math.abs(mx) + Math.abs(my) > .1) && Math.random() < dt * 12) this.burst(p.x - mx * 17, p.y - my * 17, '#d3fa59', 1, 18);
    if (this.touch.aim) {
      const target = this.touch.aim.current;
      p.angle = Math.atan2(target.y + this.camera.y - p.y, target.x + this.camera.x - p.x);
      this.lastTouchAngle = p.angle;
    } else if (this.touchUsed) {
      p.angle = this.lastTouchAngle;
      if (this.buttonFiring) this.autoAimAtRival();
    } else {
      const target = this.pointer.seen ? this.pointer : { x: this.viewW * .65, y: this.viewH * .5 };
      p.angle = Math.atan2(target.y + this.camera.y - p.y, target.x + this.camera.x - p.x);
    }
    if (this.pointer.down || this.touch.aim || this.buttonFiring || this.keys.has('f')) this.firePlayer();
    for (const drop of this.weaponDrops) if (!drop.taken && Math.hypot(drop.x - p.x, drop.y - p.y) < 33) this.pickupWeapon(drop);
    for (const drop of this.supplyDrops) if (!drop.taken && Math.hypot(drop.x - p.x, drop.y - p.y) < 36) {
      drop.taken = true; this.loot++; this.announceHeat();
      this.burst(drop.x, drop.y, '#ffdf72', 13, 130);
      this.floaters.push({ x: drop.x, y: drop.y - 28, text: '+1 LOOT', color: '#fff18b', life: 1 });
      this.feed('RAIDER LOOT', `${this.loot} supplies in your pack`); this.callbacks.onLoot?.(this.loot);
    }
    this.updateBots(dt); this.updateBullets(dt); this.updateTraps(dt); this.updateScars(dt);
    this.respawnTimers = this.respawnTimers.filter(entry => { entry.t -= dt; if (entry.t <= 0 && this.clock < 155 && this.bots.length < 9) { const angle = Math.random() * TAU; this.spawnBot(clamp(p.x + Math.cos(angle) * 720, 100, WORLD_W - 100), clamp(p.y + Math.sin(angle) * 720, 100, WORLD_H - 100), entry.index); return false; } return entry.t > 0; });
    const nearExtract = Math.hypot(p.x - this.extract.x, p.y - this.extract.y) < 79;
    const holdTime = 1.5 + Math.min(4, Math.max(0, this.loot - REQUIRED_SUPPLIES)) * .35;
    if (nearExtract && this.loot >= REQUIRED_SUPPLIES && this.keys.has('e')) { this.extractHold += dt; if (this.extractHold >= holdTime) return this.finish(true); }
    else this.extractHold = Math.max(0, this.extractHold - dt * 2.4);
    if (this.clock > 66) {
      const radius = clamp(1910 - (this.clock - 66) * 12.4, 470, 1910);
      if (Math.hypot(p.x - 1600, p.y - 1110) > radius && Math.floor(this.clock * 2) !== Math.floor((this.clock - dt) * 2)) this.damagePlayer(4);
    }
    if (p.hp <= 0 || this.timeLeft <= 0) return this.finish(false);
    const desiredX = clamp(p.x - this.viewW / 2, 0, Math.max(0, WORLD_W - this.viewW));
    const desiredY = clamp(p.y - this.viewH / 2, 0, Math.max(0, WORLD_H - this.viewH));
    this.camera.x += (desiredX - this.camera.x) * Math.min(1, dt * 8);
    this.camera.y += (desiredY - this.camera.y) * Math.min(1, dt * 8);
    this.hudClock -= dt;
    if (this.hudClock <= 0) {
      this.hudClock = .09;
      const nearby = this.nearbyAction();
      this.callbacks.onStatus?.({ hp: Math.ceil(p.hp), shield: Math.ceil(p.shield), weapon: p.weapon, ammo: p.ammo, reserve: p.reserve, reloading: p.reload > 0, kills: this.kills, loot: this.loot, heat: Math.min(4, Math.max(0, this.loot - REQUIRED_SUPPLIES)), time: this.timeLeft, alive: this.bots.length + 1, dash: p.dashCd, extractDistance: Math.round(Math.hypot(p.x - this.extract.x, p.y - this.extract.y)), nearExtract, holdTime, extractProgress: this.extractHold / holdTime, action: nearby, storm: this.clock > 66 });
    }
  }

  updateBuilder(dt) {
    this.clock += dt * .5;
    let mx = Number(this.keys.has('d') || this.keys.has('arrowright')) - Number(this.keys.has('a') || this.keys.has('arrowleft'));
    let my = Number(this.keys.has('s') || this.keys.has('arrowdown')) - Number(this.keys.has('w') || this.keys.has('arrowup'));
    this.camera.x = clamp(this.camera.x + mx * 520 * dt, 0, Math.max(0, WORLD_W - this.viewW));
    this.camera.y = clamp(this.camera.y + my * 520 * dt, 0, Math.max(0, WORLD_H - this.viewH));
  }
  nearbyAction() {
    const p = this.player;
    if (this.mode === 'online' && this.onlineSelfStatus !== 'active') return null;
    if (this.mode === 'online' && this.rewardBoxes.some(b => Math.hypot(b.x - p.x, b.y - p.y) < 66)) {
      return { type: 'reward', text: 'OPEN HIDDEN PREVIEW BOX' };
    }
    if (this.caches.some(c => !c.opened && Math.hypot(c.x - p.x, c.y - p.y) < 66)) return { type: 'cache', text: 'OPEN SUPPLY CRATE' };
    if (Math.hypot(p.x - this.extract.x, p.y - this.extract.y) < 79) return { type: 'extract', text: this.loot >= REQUIRED_SUPPLIES ? 'HOLD E TO EXTRACT' : `NEED ${REQUIRED_SUPPLIES - this.loot} MORE SUPPL${REQUIRED_SUPPLIES - this.loot === 1 ? 'Y' : 'IES'}` };
    return null;
  }

  updateBots(dt) {
    const p = this.player;
    const heat = Math.min(4, Math.max(0, this.loot - REQUIRED_SUPPLIES));
    const aggroRadius = 660 + heat * 110;
    for (const bot of this.bots) {
      bot.shotCd -= dt; bot.hurt = Math.max(0, bot.hurt - dt); bot.roamCd -= dt;
      let target = bot.hunter || Math.hypot(bot.x - p.x, bot.y - p.y) < aggroRadius ? p : null;
      if (!target) for (const other of this.bots) if (other !== bot && Math.hypot(bot.x - other.x, bot.y - other.y) < 450) { target = other; break; }
      let mx = 0, my = 0;
      if (target) {
        const dx = target.x - bot.x, dy = target.y - bot.y, d = Math.hypot(dx, dy) || 1;
        bot.angle = Math.atan2(dy, dx);
        if (d > 185) { mx = dx / d; my = dy / d; }
        else if (d < 120) { mx = -dx / d; my = -dy / d; }
        else { mx = -dy / d * Math.sin(this.clock + bot.x); my = dx / d * Math.sin(this.clock + bot.x); }
        if (d < (bot.hunter ? 720 : 580) && bot.shotCd <= 0 && this.canSee(bot, target)) {
          this.fireBot(bot, target);
          bot.shotCd = bot.hunter ? .60 + Math.random() * .16
            : (.85 + (hash(bot.id) % 5) * .13 + Math.random() * .25) * (target === p ? 1 - heat * .07 : 1);
        }
      } else {
        if (bot.roamCd <= 0) { bot.roamCd = 1.6 + Math.random() * 2; const a = Math.random() * TAU; bot.roamX = Math.cos(a); bot.roamY = Math.sin(a); }
        mx = bot.roamX; my = bot.roamY; bot.angle = Math.atan2(my, mx);
      }
      this.moveActor(bot, mx * bot.speed * dt, my * bot.speed * dt);
    }
  }

  updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i], prevX = bullet.x, prevY = bullet.y;
      bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt; bullet.life -= dt;
      if (bullet.life <= 0 || bullet.x < 15 || bullet.x > WORLD_W - 15 || bullet.y < 15 || bullet.y > WORLD_H - 15) { this.bullets.splice(i, 1); continue; }
      let hit = false;
      for (let step = 1; step <= 3 && !hit; step++) {
        const x = prevX + (bullet.x - prevX) * step / 3, y = prevY + (bullet.y - prevY) * step / 3;
        if (this.obstacles.some(box => circleRect(x, y, bullet.r, box))) { hit = true; this.burst(x, y, '#e3c491', 5, 75); break; }
        if (bullet.owner !== 'player' && Math.hypot(x - this.player.x, y - this.player.y) < this.player.r + bullet.r) { this.damagePlayer(bullet.damage); hit = true; break; }
        for (let j = this.bots.length - 1; j >= 0; j--) {
          const bot = this.bots[j]; if (bot.id === bullet.owner) continue;
          if (Math.hypot(x - bot.x, y - bot.y) < bot.r + bullet.r) {
            bot.hp -= bullet.damage; bot.hurt = .17; this.burst(x, y, '#ffbe92', 5, 95); hit = true;
            if (bot.hp <= 0) this.killBot(j, bullet.owner === 'player');
            break;
          }
        }
      }
      if (hit) this.bullets.splice(i, 1);
    }
  }
  killBot(index, playerKill) {
    const bot = this.bots[index]; if (!bot) return;
    this.burst(bot.x, bot.y, '#ffe4a3', 20, 200);
    this.floaters.push({ x: bot.x, y: bot.y - 22, text: playerKill ? '+1 ELIM' : 'ELIMINATED', color: '#fff3a3', life: 1.1 });
    if (playerKill) {
      this.kills++; this.feed('ELIMINATION', `${bot.name} dropped a supply · pick it up!`);
      this.player.shield = Math.min(75, this.player.shield + 5);
      this.supplyDrops.push({ x: bot.x, y: bot.y, taken: false });
    }
    if (Math.random() < .33) this.weaponDrops.push({ x: bot.x, y: bot.y, weapon: ['SMG', 'RIFLE', 'SHOTGUN'][this.kills % 3], taken: false });
    this.respawnTimers.push({ t: 8 + Math.random() * 5, index: this.kills + this.bots.length });
    this.bots.splice(index, 1);
  }
  damagePlayer(amount) {
    const p = this.player; if (p.hurt > 0) return;
    let remaining = amount;
    if (p.shield > 0) { const absorbed = Math.min(p.shield, remaining); p.shield -= absorbed; remaining -= absorbed; }
    p.hp = Math.max(0, p.hp - remaining); p.hurt = .34; this.shake = 7;
    this.burst(p.x, p.y, '#ff91a2', 10, 130);
    this.floaters.push({ x: p.x, y: p.y - 28, text: `-${amount}`, color: '#ff758d', life: .7 });
    this.callbacks.onHurt?.();
  }
  updateTraps(dt) {
    const p = this.player;
    for (const trap of this.traps) {
      trap.cd -= dt; const d = Math.hypot(trap.x - p.x, trap.y - p.y);
      if (trap.type === 'turret' && d < 500 && trap.cd <= 0 && this.canSee(trap, p)) { const angle = Math.atan2(p.y - trap.y, p.x - trap.x); this.bullets.push({ x: trap.x, y: trap.y, vx: Math.cos(angle) * 560, vy: Math.sin(angle) * 560, damage: 11, owner: 'turret', life: 1.4, color: '#fe8ca0', r: 4 }); trap.cd = 1.7; }
      if (trap.type === 'mine' && d < 45 && !trap.fired) { trap.fired = true; this.burst(trap.x, trap.y, '#ffac76', 28, 250); this.damagePlayer(22); }
      if (trap.type === 'pulse' && d < 120 && trap.cd <= 0) { this.damagePlayer(13); this.burst(trap.x, trap.y, '#e8a6fa', 16, 165); trap.cd = 2.1; }
    }
  }
  updateScars(dt) {
    for (const scar of this.scars) {
      scar.cd -= dt; const d = Math.hypot(scar.x - this.player.x, scar.y - this.player.y);
      if (scar.type === 'acid' && d < 66 && scar.cd <= 0) { this.damagePlayer(7); scar.cd = 1.2; }
      if (scar.type === 'static' && d < 180 && scar.cd <= 0) { const a = Math.atan2(this.player.y - scar.y, this.player.x - scar.x); this.bullets.push({ x: scar.x, y: scar.y, vx: Math.cos(a) * 440, vy: Math.sin(a) * 440, damage: 7, owner: 'scar', life: 1.4, color: '#e4baff', r: 4 }); scar.cd = 2.9; }
    }
  }
  finish(won) {
    if (this.mode !== 'play') return;
    this.mode = 'result'; this.pointer.down = false; this.buttonFiring = false;
    this.callbacks.onFinish?.({ won, loot: this.loot, kills: this.kills, timeLeft: Math.max(0, this.timeLeft), timeUsed: MATCH_TIME - Math.max(0, this.timeLeft) });
  }

  placeTrap(pos) {
    const x = clamp(Math.round((pos.x + this.camera.x - 32) / 64) * 64 + 32, 160, WORLD_W - 160);
    const y = clamp(Math.round((pos.y + this.camera.y - 32) / 64) * 64 + 32, 160, WORLD_H - 160);
    const existing = this.arena.traps.findIndex(t => Math.hypot(t.x - x, t.y - y) < 25);
    if (existing !== -1) this.arena.traps.splice(existing, 1);
    else {
      if (this.arena.traps.length >= 8) return this.callbacks.onBuildError?.('Maximum 8 traps. Remove one first.');
      if (this.obstacles.some(box => circleRect(x, y, 36, box)) || LIVE_SPAWNS.some(point => Math.hypot(x - point.x, y - point.y) < 120) || Math.hypot(x - this.extract.x, y - this.extract.y) < 135) return this.callbacks.onBuildError?.('Place traps on open terrain, away from live spawns and extraction.');
      if (this.selectedTrap === 'pulse' && !this.callbacks.canUsePulse?.()) return this.callbacks.onBuildError?.('Pulse Coil requires holding 100 $CHOG on Monad.');
      this.arena.traps.push({ type: this.selectedTrap, x, y });
    }
    this.traps = this.arena.traps.map((t, i) => ({ ...t, cd: 1 + i * .2, fired: false }));
    this.callbacks.onBuildChanged?.(this.arena.traps);
  }
  feed(title, detail) { this.callbacks.onFeed?.(title, detail); }
  burst(x, y, color, count, power) {
    for (let i = 0; i < count; i++) { const a = Math.random() * TAU, v = power * (.3 + Math.random() * .7); this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: .25 + Math.random() * .42, max: .67, color, size: 2 + Math.random() * 3 }); }
    if (this.particles.length > 380) this.particles.splice(0, this.particles.length - 380);
  }
  updateParticles(dt) {
    this.shake *= Math.pow(.07, dt);
    this.particles = this.particles.filter(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.pow(.2, dt); p.vy *= Math.pow(.2, dt); p.life -= dt; return p.life > 0; });
    this.floaters = this.floaters.filter(f => { f.y -= dt * 32; f.life -= dt; return f.life > 0; });
  }

  draw() {
    const ctx = this.ctx; ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.save();
    if (this.mode === 'play' && this.shake > .4) ctx.translate((Math.random() - .5) * this.shake, (Math.random() - .5) * this.shake);
    ctx.translate(-this.camera.x, -this.camera.y);
    this.drawGround(ctx); this.drawRoads(ctx); this.drawDecor(ctx);
    this.drawExtraction(ctx); this.drawCaches(ctx); this.drawRewardBoxes(ctx);
    this.drawSupplyDrops(ctx); this.drawWeaponDrops(ctx); this.drawObstacles(ctx);
    this.drawScars(ctx); this.drawTraps(ctx);
    for (const bot of this.bots) if (this.visible(bot.x, bot.y, 80)) this.drawFighter(ctx, bot, false);
    if (this.mode === 'online') for (const rival of this.onlinePlayers) {
      if (rival.id === this.onlineSelfId || rival.status !== 'active' || !this.visible(rival.x, rival.y, 80)) continue;
      this.drawFighter(ctx, { ...rival, maxHp: 100, hurt: 0 }, false);
      ctx.fillStyle = '#1b1831'; ctx.fillRect(rival.x - 35, rival.y - 55, 70, 16);
      ctx.fillStyle = rival.color; ctx.fillRect(rival.x - 33, rival.y - 53, 66, 12);
      ctx.fillStyle = '#211c2f'; ctx.font = '900 9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(rival.name, rival.x, rival.y - 44); ctx.textAlign = 'start';
      ctx.fillStyle = '#241b2b'; ctx.fillRect(rival.x - 22, rival.y - 36, 44, 5);
      ctx.fillStyle = '#f67d91'; ctx.fillRect(rival.x - 20, rival.y - 35, 40 * rival.hp / 100, 3);
      if (rival.spawnShield > 0) { ctx.strokeStyle = '#fff1ad'; ctx.lineWidth = 2; ctx.strokeRect(rival.x - 26, rival.y - 27, 52, 54); }
    }
    if (this.mode !== 'build' && (this.mode !== 'online' || this.onlineSelfStatus === 'active')) this.drawFighter(ctx, this.player, true);
    this.drawBullets(ctx); this.drawParticles(ctx);
    if (this.mode === 'build') this.drawBuildGrid(ctx);
    ctx.restore();
    if (this.mode === 'play' || this.mode === 'online') this.drawCrosshair(ctx);
    if (this.mode === 'paused') { ctx.fillStyle = '#111923a5'; ctx.fillRect(0, 0, this.viewW, this.viewH); ctx.fillStyle = '#fff4dc'; ctx.textAlign = 'center'; ctx.font = '1000 46px system-ui'; ctx.fillText('PAUSED', this.viewW / 2, this.viewH / 2); ctx.font = 'bold 14px monospace'; ctx.fillText('PRESS P TO RESUME', this.viewW / 2, this.viewH / 2 + 30); ctx.textAlign = 'start'; }
    this.miniClock -= .016; if (this.miniClock <= 0) { this.drawMinimap(); this.miniClock = .12; }
  }
  visible(x, y, pad = 100) { return x > this.camera.x - pad && x < this.camera.x + this.viewW + pad && y > this.camera.y - pad && y < this.camera.y + this.viewH + pad; }
  tileNoise(tx, ty) { return hash(`${tx}:${ty}:${this.mapCode}`) % 9; }
  drawGround(ctx) {
    const palettes = [['#368f4f', '#3b9855', '#419f59'], ['#328a4d', '#389553', '#3e9e57'], ['#398d4d', '#409653', '#47a15b']];
    const colors = palettes[this.biome];
    const x0 = Math.max(0, Math.floor(this.camera.x / TILE) - 1), x1 = Math.min(Math.ceil(WORLD_W / TILE), Math.ceil((this.camera.x + this.viewW) / TILE) + 1);
    const y0 = Math.max(0, Math.floor(this.camera.y / TILE) - 1), y1 = Math.min(Math.ceil(WORLD_H / TILE), Math.ceil((this.camera.y + this.viewH) / TILE) + 1);
    for (let tx = x0; tx < x1; tx++) for (let ty = y0; ty < y1; ty++) {
      const n = this.tileNoise(tx, ty), x = tx * TILE, y = ty * TILE;
      ctx.fillStyle = colors[n % 3]; ctx.fillRect(x, y, TILE, TILE);
      ctx.strokeStyle = '#266f3d88'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, TILE, TILE);
      ctx.fillStyle = n > 4 ? '#84bd6940' : '#215e3d40';
      ctx.fillRect(x + 12 + n * 3, y + 14 + n, 3, 7); ctx.fillRect(x + 29, y + 38 + (n % 5), 7, 3);
    }
    ctx.strokeStyle = '#1b5a37'; ctx.lineWidth = 7; ctx.strokeRect(3, 3, WORLD_W - 6, WORLD_H - 6);
  }
  roadX(y) { return 1600 + Math.sin(y / 280) * 190 + Math.sin(y / 95) * 36; }
  roadY(x) { return 1110 + Math.sin(x / 350) * 115 + Math.sin(x / 120) * 23; }
  drawRoads(ctx) {
    const vertical = () => { ctx.beginPath(); for (let y = -80; y <= WORLD_H + 80; y += 35) { const x = this.roadX(y); if (y === -80) ctx.moveTo(x, y); else ctx.lineTo(x, y); } };
    const horizontal = () => { ctx.beginPath(); for (let x = -80; x <= WORLD_W + 80; x += 35) { const y = this.roadY(x); if (x === -80) ctx.moveTo(x, y); else ctx.lineTo(x, y); } };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const path of [vertical, horizontal]) {
      path(); ctx.strokeStyle = '#67472e'; ctx.lineWidth = 244; ctx.stroke();
      path(); ctx.strokeStyle = '#91643c'; ctx.lineWidth = 229; ctx.stroke();
      path(); ctx.strokeStyle = '#ae7b45a6'; ctx.lineWidth = 177; ctx.stroke();
    }
    ctx.fillStyle = '#4f3d2e55';
    const x0 = Math.max(0, Math.floor(this.camera.x / 90) - 2), x1 = Math.min(40, Math.ceil((this.camera.x + this.viewW) / 90) + 2);
    for (let i = x0; i < x1; i++) { const x = i * 90 + 25, y = this.roadY(x); ctx.fillRect(x, y - 35, 13, 3); ctx.fillRect(x + 36, y + 26, 9, 3); }
  }
  drawDecor(ctx) {
    for (const d of this.decor) if (this.visible(d.x, d.y, 90)) {
      ctx.save(); ctx.translate(d.x, d.y);
      if (d.kind === 'bush') {
        const s = d.size / 40; ctx.scale(s, s);
        ctx.fillStyle = '#175b39'; ctx.fillRect(-30, -13, 59, 31); ctx.fillRect(-20, -24, 40, 48);
        ctx.fillStyle = '#247941'; for (const [x, y, w, h] of [[-26,-16,20,21],[-8,-24,25,24],[12,-13,19,26],[-17,5,28,17]]) ctx.fillRect(x,y,w,h);
        ctx.fillStyle = '#47ac5d'; ctx.fillRect(-14,-19,15,9);ctx.fillRect(8,-4,12,9);ctx.fillRect(-24,4,12,8);
      } else if (d.kind === 'tree') {
        const s = d.size / 43; ctx.scale(s,s);ctx.fillStyle='#214f2c';ctx.fillRect(-23,-18,50,43);ctx.fillStyle='#185d36';ctx.fillRect(-29,-16,52,36);ctx.fillRect(-17,-30,37,56);ctx.fillStyle='#2c884b';ctx.fillRect(-22,-23,29,19);ctx.fillRect(-4,-29,26,24);ctx.fillRect(0,2,22,15);ctx.fillStyle='#53ab55';ctx.fillRect(-15,-18,10,8);ctx.fillRect(5,-20,13,8);
      } else { ctx.fillStyle='#2f674f';ctx.fillRect(-16,-9,33,20);ctx.fillStyle='#758d7d';ctx.fillRect(-18,-14,30,19);ctx.fillStyle='#9ea99a';ctx.fillRect(-11,-12,20,7); }
      ctx.restore();
    }
  }
  drawObstacles(ctx) {
    for (const b of this.obstacles) if (this.visible(b.x + b.w / 2, b.y + b.h / 2, 140)) {
      ctx.fillStyle = '#1b292483'; ctx.fillRect(b.x + 9, b.y + 10, b.w, b.h);
      if (b.type === 'wall') {
        const horizontal = b.w > b.h;
        ctx.fillStyle = '#24262b'; ctx.fillRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
        ctx.fillStyle = '#a87857'; ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = '#edd9ad'; ctx.fillRect(b.x + 3, b.y + 3, b.w - 6, b.h - 12);
        ctx.fillStyle = '#fff1c9'; ctx.fillRect(b.x + 5, b.y + 5, horizontal ? b.w - 10 : 7, horizontal ? 4 : b.h - 11);
        ctx.fillStyle = '#78573f';
        if (horizontal) {
          for (let x = b.x + 46; x < b.x + b.w - 7; x += 48) ctx.fillRect(x, b.y + 4, 3, b.h - 13);
          ctx.fillRect(b.x + 8, b.y + b.h - 8, b.w - 16, 3);
        } else {
          for (let y = b.y + 43; y < b.y + b.h - 7; y += 48) ctx.fillRect(b.x + 4, y, b.w - 8, 3);
          ctx.fillRect(b.x + b.w - 8, b.y + 8, 3, b.h - 16);
        }
        ctx.fillStyle = '#3e3732';
        for (const [x, y] of [[b.x + 4, b.y + 4], [b.x + b.w - 8, b.y + b.h - 8]]) ctx.fillRect(x, y, 4, 4);
      } else if (b.type === 'crate') {
        ctx.fillStyle = '#332520'; ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = '#b9844e'; ctx.fillRect(b.x + 3, b.y + 3, b.w - 6, b.h - 6);
        ctx.strokeStyle = '#6e452c'; ctx.lineWidth = 4;ctx.strokeRect(b.x+8,b.y+8,b.w-16,b.h-16);
        ctx.beginPath();ctx.moveTo(b.x+11,b.y+11);ctx.lineTo(b.x+b.w-11,b.y+b.h-11);ctx.moveTo(b.x+b.w-11,b.y+11);ctx.lineTo(b.x+11,b.y+b.h-11);ctx.stroke();
        ctx.fillStyle='#e3aa69';for(const x of [b.x+5,b.x+b.w-10])for(const y of [b.y+5,b.y+b.h-10])ctx.fillRect(x,y,5,5);
      } else if (b.type === 'container') {
        ctx.fillStyle='#223b40';ctx.fillRect(b.x,b.y,b.w,b.h);ctx.fillStyle='#4d8890';ctx.fillRect(b.x+4,b.y+4,b.w-8,b.h-8);
        ctx.fillStyle='#72aeb0';for(let x=b.x+16;x<b.x+b.w-9;x+=22)ctx.fillRect(x,b.y+9,4,b.h-18);
        ctx.fillStyle='#f3d47d';ctx.fillRect(b.x+11,b.y+10,26,9);ctx.fillStyle='#152e36';ctx.fillRect(b.x+14,b.y+12,13,4);
      } else if(b.type==='truck'){
        ctx.fillStyle='#291c21';ctx.fillRect(b.x+5,b.y,b.w-10,b.h);ctx.fillStyle='#ef584e';ctx.fillRect(b.x+10,b.y+5,b.w-20,b.h-10);ctx.fillStyle='#271f2e';ctx.fillRect(b.x+17,b.y+23,b.w-34,44);ctx.fillRect(b.x+17,b.y+86,b.w-34,41);ctx.fillStyle='#ffb67e';ctx.fillRect(b.x+17,b.y+11,b.w-34,8);ctx.fillStyle='#181923';ctx.fillRect(b.x-4,b.y+25,11,27);ctx.fillRect(b.x+b.w-7,b.y+25,11,27);ctx.fillRect(b.x-4,b.y+103,11,27);ctx.fillRect(b.x+b.w-7,b.y+103,11,27);
      } else {
        ctx.fillStyle='#3a3b38';ctx.fillRect(b.x,b.y,b.w,b.h);ctx.fillStyle='#e1c891';ctx.fillRect(b.x+5,b.y+5,b.w-10,b.h-10);ctx.fillStyle='#a77651';for(let x=b.x+18;x<b.x+b.w-10;x+=26)ctx.fillRect(x,b.y+5,5,b.h-10);ctx.fillStyle='#493c32';ctx.fillRect(b.x+10,b.y+20,20,28);ctx.fillRect(b.x+b.w-43,b.y+b.h-48,30,22);
      }
    }
  }
  drawCaches(ctx) {
    for (const c of this.caches) if (!c.opened && this.visible(c.x, c.y, 80)) {
      ctx.save();ctx.translate(c.x,c.y);const pulse=Math.sin(this.clock*3+c.id)*2;
      ctx.fillStyle='#1b382a7a';ctx.fillRect(-23,13,51,20);
      ctx.fillStyle='#20243a';ctx.fillRect(-24,-24,48,48);ctx.fillStyle='#ffce39';ctx.fillRect(-20,-20,40,40);
      ctx.fillStyle='#ed9d25';ctx.fillRect(-20,3,40,8);ctx.fillRect(-4,-20,8,40);
      ctx.fillStyle='#212037';ctx.fillRect(-8,-9,16,16);ctx.fillStyle='#f9f6a6';ctx.fillRect(-4,-6,8,10);
      ctx.strokeStyle='#fff2af';ctx.lineWidth=2;ctx.strokeRect(-23-pulse/2,-23-pulse/2,46+pulse,46+pulse);
      ctx.fillStyle='#fffce8';ctx.font='900 10px monospace';ctx.textAlign='center';ctx.fillText('LOOT',0,-32);ctx.restore();
    }
  }
  drawRewardBoxes(ctx) {
    if (this.mode !== 'online') return;
    for (const box of this.rewardBoxes) if (this.visible(box.x, box.y, 85)) {
      const pulse = Math.sin(this.clock * 5 + box.id) * 3;
      ctx.save(); ctx.translate(box.x, box.y);
      ctx.fillStyle = '#182e2677'; ctx.fillRect(-24, 17, 53, 18);
      ctx.fillStyle = '#1e2537'; ctx.fillRect(-23, -22, 46, 43);
      ctx.fillStyle = '#ef8ea8'; ctx.fillRect(-19, -19, 38, 35);
      ctx.fillStyle = '#ffe59c'; ctx.fillRect(-20, -5, 40, 7);
      ctx.fillStyle = '#253042'; ctx.fillRect(-8, -14, 16, 19);
      ctx.fillStyle = '#fff0ad'; ctx.font = '1000 18px monospace'; ctx.textAlign = 'center';
      ctx.fillText('?', 0, 3);
      ctx.strokeStyle = '#ffe8b7'; ctx.lineWidth = 2;
      ctx.strokeRect(-26 - pulse / 2, -25 - pulse / 2, 52 + pulse, 49 + pulse);
      ctx.fillStyle = '#fff7d9'; ctx.font = '900 10px monospace';
      ctx.fillText('HIDDEN · PREVIEW', 0, -32); ctx.restore();
    }
  }
  drawSupplyDrops(ctx) {
    for (const pack of this.supplyDrops) if (!pack.taken && this.visible(pack.x, pack.y, 70)) {
      ctx.save(); ctx.translate(pack.x, pack.y);
      const bob = Math.sin(this.clock * 4 + pack.x) * 2;
      ctx.fillStyle = '#1c292988'; ctx.fillRect(-20, 12, 45, 16);
      ctx.fillStyle = '#242036'; ctx.fillRect(-19, -19 + bob, 38, 37);
      ctx.fillStyle = '#e371ad'; ctx.fillRect(-15, -15 + bob, 30, 29);
      ctx.fillStyle = '#ffdb69'; ctx.fillRect(-6, -12 + bob, 12, 23);
      ctx.fillStyle = '#fff6dc'; ctx.font = '900 10px monospace'; ctx.textAlign = 'center';
      ctx.fillText('SUPPLY', 0, -27 + bob); ctx.restore();
    }
  }
  drawWeaponDrops(ctx) {
    for (const w of this.weaponDrops) if (!w.taken && this.visible(w.x,w.y,90)) {
      ctx.save();ctx.translate(w.x,w.y);
      const bob=Math.sin(this.clock*3+w.x)*3;
      ctx.fillStyle='#fff28e88';ctx.fillRect(-25,-20+bob,50,40);
      ctx.fillStyle='#202132';ctx.fillRect(-22,-17+bob,44,34);ctx.fillStyle='#e96292';ctx.fillRect(-19,-14+bob,38,28);
      ctx.fillStyle='#fff5e4';ctx.font='900 19px monospace';ctx.textAlign='center';ctx.fillText(WEAPONS[w.weapon].icon,0,7+bob);
      ctx.font='900 10px monospace';ctx.fillStyle='#fffce3';ctx.fillText(w.weapon,0,-26+bob);ctx.restore();
    }
  }
  drawExtraction(ctx) {
    const x=this.extract.x,y=this.extract.y; if(!this.visible(x,y,160))return;
    ctx.save();ctx.translate(x,y);const glow=5*Math.sin(this.clock*3);
    ctx.fillStyle='#1e4a397a';ctx.fillRect(-73,-61,150,124);
    ctx.fillStyle='#1e2130';ctx.fillRect(-68,-58,136,116);ctx.fillStyle='#ffda55';ctx.fillRect(-61,-51,122,102);
    ctx.fillStyle='#e59d30';for(const t of [-54,-29,30,54])ctx.fillRect(t,-51,5,102);
    ctx.fillStyle='#202132';ctx.fillRect(-43,-35,86,70);ctx.fillStyle='#fcf6d6';ctx.fillRect(-32,-25,64,50);
    ctx.fillStyle='#202132';ctx.font='1000 49px system-ui';ctx.textAlign='center';ctx.fillText('↥',0,15);
    ctx.strokeStyle='#fff5a3';ctx.lineWidth=4;ctx.strokeRect(-70-glow,-60-glow,140+glow*2,120+glow*2);
    ctx.fillStyle='#fff7dc';ctx.font='1000 14px system-ui';ctx.fillText('EXTRACTION',0,-76);ctx.restore();
  }
  drawScars(ctx) {
    for(const s of this.scars)if(this.visible(s.x,s.y,100)){
      const color=SCAR_COLORS[s.type]||'#d8ff71';ctx.save();ctx.translate(s.x,s.y);ctx.fillStyle=color+'55';ctx.fillRect(-54,-40,109,83);ctx.strokeStyle=color;ctx.lineWidth=3;ctx.setLineDash([9,7]);ctx.strokeRect(-54,-40,109,83);ctx.setLineDash([]);ctx.fillStyle='#222234';ctx.fillRect(-11,-13,22,26);ctx.fillStyle=color;ctx.font='bold 22px monospace';ctx.textAlign='center';ctx.fillText(s.type==='acid'?'◈':s.type==='static'?'ϟ':'✳',0,7);ctx.restore();
    }
  }
  drawTraps(ctx) {
    for(const t of this.traps)if(this.visible(t.x,t.y,90)){
      ctx.save();ctx.translate(t.x,t.y);
      if(t.type==='slime'){ctx.fillStyle='#d5ff6172';ctx.fillRect(-47,-35,96,72);ctx.fillStyle='#b4dc4d';ctx.fillRect(-31,-23,57,42);ctx.fillStyle='#ebff9b';ctx.fillRect(-11,-25,10,9);}
      else if(t.type==='mine'){if(!t.fired){ctx.fillStyle='#402d30';ctx.fillRect(-18,-18,36,36);ctx.fillStyle='#f05e6e';ctx.fillRect(-11,-11,22,22);ctx.fillStyle='#fff1a9';ctx.fillRect(-3,-4,6,8);}}
      else{ctx.fillStyle='#1f2335';ctx.fillRect(-24,-21,48,42);ctx.fillStyle=t.type==='pulse'?'#d59bfd':'#f3c955';ctx.fillRect(-18,-15,36,30);ctx.fillStyle='#312631';ctx.font='900 24px monospace';ctx.textAlign='center';ctx.fillText(TRAP_SYMBOLS[t.type],0,8);}
      ctx.restore();
    }
  }

  drawFighter(ctx, fighter, player) {
    ctx.save();ctx.translate(Math.round(fighter.x),Math.round(fighter.y));ctx.rotate(fighter.angle);
    if(fighter.hurt>0&&Math.floor(this.clock*18)%2)ctx.globalAlpha=.52;
    // Squared, top-down game sprites. Facing right; the entire sprite rotates with the aim.
    const box=(x,y,w,h,c)=>{ctx.fillStyle=c;ctx.fillRect(x,y,w,h);};
    box(-23,-12,46,35,'#16392766');
    if(player){
      const heroColor = this.hero?.bgColor || '#5d349e';
      // Hero-driven look: body color from mint, still Chog silhouette
      box(-19,-19,32,38,'#211c35');box(-16,-17,30,33,heroColor);
      box(-26,-19,12,10,'#30204d');box(-26,9,12,10,'#30204d');
      box(-25,-27,12,12,'#482478');box(-26,15,12,12,'#482478');
      box(-13,-24,20,7,'#7544b5');box(-13,17,20,7,'#7544b5');
      box(0,-14,23,29,'#211c34');box(2,-12,20,25,'#fff1dc');
      box(12,-8,5,6,'#1d182a');box(12,3,5,6,'#1d182a');
      box(7,-13,7,4,'#f265a0');box(7,10,7,4,'#f265a0');
      box(-10,-24,9,6,'#f186bd');box(-10,18,9,6,'#f186bd');
      box(-10,-14,8,28,'#9866d6');box(-17,-10,5,20,'#cba2ff');
      const mitts = this.equippedMod === 'GOLDEN MITTS' ? '#ffdb50' : '#ed6da9';
      box(-13,-22,13,8,mitts);box(-13,14,13,8,mitts);
    } else {
      const c=fighter.color;box(-21,-18,34,36,'#242237');box(-17,-16,30,32,c);
      box(-25,-25,13,10,'#242237');box(-25,15,13,10,'#242237');
      box(-14,-22,27,8,'#27263b');box(-14,14,27,8,'#27263b');
      box(1,-17,23,34,'#242237');box(4,-15,20,30,c);
      box(13,-11,10,22,'#292638');box(16,-8,5,16,'#b8e6cf');
      box(-7,-22,12,6,'#dca77c');box(-7,16,12,6,'#dca77c');
      box(-14,-13,9,26,'#344554');box(-20,-9,6,18,'#1a2432');
      box(-12,-20,9,7,c);box(-12,13,9,7,c);
    }
    // Gun and hands face the target. Weapons are readable instead of circular placeholders.
    box(16,-7,20,14,'#1b1c2a');box(30,-4,13,8,'#454456');box(40,-3,5,6,'#151625');
    const hands = player ? this.equippedMod === 'GOLDEN MITTS' ? '#ffdb50' : '#ff8cb5' : '#dcb08b';
    box(14,-10,11,6,hands);box(14,4,11,6,hands);
    if(player&&this.equippedMod==='STATIC CROWN'){box(-16,-30,28,5,'#ffe052');box(-10,-38,7,9,'#ffe052');box(2,-38,7,9,'#ffe052');}
    if(player&&this.equippedMod==='ARCADE BADGE'){box(-20,-29,13,13,'#ffdc59');box(-17,-26,7,7,'#ed5890');}
    ctx.restore();
    if (!player && fighter.hunter) {
      ctx.fillStyle = '#242036'; ctx.fillRect(fighter.x - 29, fighter.y - 51, 58, 14);
      ctx.fillStyle = '#ffacd5'; ctx.textAlign = 'center'; ctx.font = '900 9px monospace';
      ctx.fillText('HUNTER', fighter.x, fighter.y - 41); ctx.textAlign = 'start';
    }
    if(this.mode==='play'||player){
      const hp=player?fighter.hp:fighter.hp/fighter.maxHp*100;
      if(player||hp<100){ctx.fillStyle='#1a2030';ctx.fillRect(fighter.x-21,fighter.y-32,42,5);ctx.fillStyle=player?'#ff7080':'#ffd460';ctx.fillRect(fighter.x-20,fighter.y-31,40*hp/100,3);}
    }
  }
  drawBullets(ctx) {
    for(const b of this.bullets)if(this.visible(b.x,b.y,30)){
      ctx.strokeStyle=b.color;ctx.lineWidth=b.r*1.5;ctx.lineCap='square';ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-b.vx*.026,b.y-b.vy*.026);ctx.stroke();ctx.fillStyle='#fff5d6';ctx.fillRect(b.x-2,b.y-2,4,4);
    }
  }
  drawParticles(ctx) {
    for(const p of this.particles)if(this.visible(p.x,p.y,10)){ctx.globalAlpha=clamp(p.life/p.max*1.7,0,1);ctx.fillStyle=p.color;ctx.fillRect(p.x,p.y,p.size,p.size);}ctx.globalAlpha=1;
    for(const f of this.floaters)if(this.visible(f.x,f.y,20)){ctx.globalAlpha=clamp(f.life*2,0,1);ctx.textAlign='center';ctx.font='900 13px monospace';ctx.fillStyle='#18232a';ctx.fillText(f.text,f.x+2,f.y+2);ctx.fillStyle=f.color;ctx.fillText(f.text,f.x,f.y);}ctx.globalAlpha=1;ctx.textAlign='start';
  }
  drawBuildGrid(ctx) {
    const startX=Math.floor(this.camera.x/64)*64,startY=Math.floor(this.camera.y/64)*64;
    ctx.strokeStyle='#fff9cc7a';ctx.lineWidth=1;
    for(let x=startX;x<this.camera.x+this.viewW+64;x+=64)for(let y=startY;y<this.camera.y+this.viewH+64;y+=64)ctx.strokeRect(x,y,64,64);
    if(this.pointer.seen){const x=Math.round((this.pointer.x+this.camera.x-32)/64)*64+32,y=Math.round((this.pointer.y+this.camera.y-32)/64)*64+32;ctx.strokeStyle='#fff5a0';ctx.lineWidth=4;ctx.strokeRect(x-31,y-31,62,62);}
    ctx.fillStyle='#fff9e6';ctx.strokeStyle='#252139';ctx.lineWidth=5;ctx.font='1000 23px system-ui';ctx.strokeText('BUILD MODE · WASD TO PAN',this.camera.x+22,this.camera.y+this.viewH-30);ctx.fillText('BUILD MODE · WASD TO PAN',this.camera.x+22,this.camera.y+this.viewH-30);
  }
  drawCrosshair(ctx) {
    const x=this.pointer.x,y=this.pointer.y;
    if(!this.pointer.seen||this.touch.aim)return;
    ctx.strokeStyle='#17252c';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(x-14,y);ctx.lineTo(x-5,y);ctx.moveTo(x+5,y);ctx.lineTo(x+14,y);ctx.moveTo(x,y-14);ctx.lineTo(x,y-5);ctx.moveTo(x,y+5);ctx.lineTo(x,y+14);ctx.stroke();ctx.strokeStyle='#fff4b8';ctx.lineWidth=2;ctx.stroke();
  }
  drawMinimap() {
    if(!this.miniCtx||this.mode==='preview')return;
    const ctx=this.miniCtx,w=174,h=126,sx=w/WORLD_W,sy=h/WORLD_H;
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#37965a';ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='#a47142';ctx.lineWidth=13;ctx.beginPath();for(let y=0;y<=WORLD_H;y+=80){const x=this.roadX(y)*sx;if(y===0)ctx.moveTo(x,y*sy);else ctx.lineTo(x,y*sy);}ctx.stroke();
    ctx.beginPath();for(let x=0;x<=WORLD_W;x+=80){const y=this.roadY(x)*sy;if(x===0)ctx.moveTo(x*sx,y);else ctx.lineTo(x*sx,y);}ctx.stroke();
    ctx.fillStyle='#edddb4';for(const wall of this.obstacles)if(wall.type==='wall')ctx.fillRect(wall.x*sx,wall.y*sy,Math.max(2,wall.w*sx),Math.max(2,wall.h*sy));
    ctx.fillStyle='#f6d643';ctx.fillRect(this.extract.x*sx-4,this.extract.y*sy-4,8,8);
    ctx.fillStyle='#faff9f';for(const c of this.caches)if(!c.opened)ctx.fillRect(c.x*sx-1,c.y*sy-1,3,3);
    ctx.fillStyle='#f59ec9';for(const pack of this.supplyDrops)if(!pack.taken)ctx.fillRect(pack.x*sx-2,pack.y*sy-2,4,4);
    for(const b of this.bots)if(b.hunter||Math.hypot(b.x-this.player.x,b.y-this.player.y)<620){ctx.fillStyle=b.hunter?'#f5319c':'#ff6e89';ctx.fillRect(b.x*sx-2,b.y*sy-2,b.hunter?5:4,b.hunter?5:4);}
    if(this.mode==='online')for(const rival of this.onlinePlayers)if(rival.id!==this.onlineSelfId&&rival.status==='active'){ctx.fillStyle=rival.color;ctx.fillRect(rival.x*sx-2,rival.y*sy-2,5,5);}
    ctx.fillStyle='#f7f1fd';ctx.fillRect(this.player.x*sx-3,this.player.y*sy-3,6,6);ctx.strokeStyle='#1b2830';ctx.lineWidth=2;ctx.strokeRect(this.player.x*sx-3,this.player.y*sy-3,6,6);
    ctx.strokeStyle='#fff9cb';ctx.lineWidth=1;ctx.strokeRect(this.camera.x*sx,this.camera.y*sy,Math.min(this.viewW*sx,w),Math.min(this.viewH*sy,h));
  }
}

export { formatClock, WEAPONS, REQUIRED_SUPPLIES, payoutForRun };

