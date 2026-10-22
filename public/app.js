import { PitGame, formatClock, WEAPONS, REQUIRED_SUPPLIES, payoutForRun } from './game.js';
import { AudioFX } from './audio.js';

const $ = id => document.getElementById(id);
const API = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
};
const storage = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
};
const shortAddress = address => `${address.slice(0, 6)}…${address.slice(-4)}`;
const DEFAULT_TRAPS = [
  { type: 'turret', x: 1888, y: 992 },
  { type: 'mine', x: 2400, y: 1248 },
  { type: 'slime', x: 1632, y: 1440 }
];
const REWARDS = [
  { name: 'NEON AFTERBURN', rarity: 'RARE COSMETIC', symbol: '✦', description: 'A bright pink dash trail. Cosmetic only.' },
  { name: 'STATIC CROWN', rarity: 'RARE COSMETIC', symbol: 'ϟ', description: 'A tiny electric crown for your Chog.' },
  { name: 'TOXIC FOOTPRINTS', rarity: 'UNCOMMON COSMETIC', symbol: '◈', description: 'Leave lime footprints as you move.' },
  { name: 'PINK SPARKS', rarity: 'COMMON COSMETIC', symbol: '✳', description: 'Turn your muzzle flashes a little pinker.' },
  { name: 'ARCADE BADGE', rarity: 'EPIC COSMETIC', symbol: '▣', description: 'A badge you can actually wear in the pit.' },
  { name: 'EMBER TRACERS', rarity: 'UNCOMMON COSMETIC', symbol: '➤', description: 'Your shots streak bright orange. Cosmetic only.' },
  { name: 'GOLDEN MITTS', rarity: 'RARE COSMETIC', symbol: '✹', description: 'Gold gloves for your Chog. No combat advantage.' },
  { name: 'FROST AFTERIMAGE', rarity: 'EPIC COSMETIC', symbol: '❄', description: 'A cool blue dash trail. Cosmetic only.' }
];
const HEROES = [
  { tokenId: 1, name: 'WIZARD APEX', bg: 'Aqua Depths', body: 'Wizard Cape', eyes: 'Fire Laser', aura: 'Royal Blue Aura', tier: 3, bgColor: '#0ea5a0', weapon: 'staff', speed: 6, armor: 5, ability: 'shield' },
  { tokenId: 2, name: 'BANANA RUNNER', bg: 'Sky Blue', body: 'Banana Suit', eyes: 'Side Eye', aura: 'None', tier: 1, bgColor: '#38bdf8', weapon: 'rifle', speed: 5, armor: 3, ability: 'dash' },
  { tokenId: 3, name: 'GANGSTER GUARD', bg: 'Lime Grid', body: 'Gangster Coat', eyes: 'Clown Ring', aura: 'Ember Aura', tier: 2, bgColor: '#a3e635', weapon: 'shotgun', speed: 6, armor: 5, ability: 'ember-burst' },
  { tokenId: 7, name: 'MONAD PULSE', bg: 'Light Purple', body: 'Neon Racer', eyes: 'Holo Scan', aura: 'Monad Pulse', tier: 2, bgColor: '#c084fc', weapon: 'rifle', speed: 5, armor: 4, ability: 'pulse' },
];
const state = {
  id: 'demo', arena: { id: 'demo', traps: DEFAULT_TRAPS, scars: [], raids: 0, clears: 0, genome: 'demo' },
  wallet: null, verified: false, chogBalance: 0, mode: 'lobby', panel: null,
  rewardSession: null, rewardAccount: null, previewBalance: 0,
  samplePass: storage.read('chogpit.sampleRaiderPass', false) === true,
  heroId: storage.read('chogpit.heroId', null),
  crates: Number(storage.read('chogpit.crates', 0)) || 0, collection: storage.read('chogpit.collection', []), equipped: storage.read('chogpit.equipped', null),
  rep: Number(storage.read('chogpit.pitRep', 0)) || 0, bestScore: Number(storage.read('chogpit.bestScore', 0)) || 0,
  summary: null, payout: null, claimed: false, mark: 'acid', loading: false,
  live: null
};
const audio = new AudioFX();
let toastTimer, interactPointerId = null;

function releaseInteract(pointerId = null) {
  if (pointerId !== null && interactPointerId !== pointerId) return;
  interactPointerId = null;
  game.keys.delete('e');
  $('interactPrompt').classList.remove('active');
}
function pauseRun(paused) {
  if (state.mode !== 'play') return;
  game.mode = paused ? 'paused' : 'play';
  if (paused) { game.keys.clear(); game.clearTouch(); releaseInteract(); }
  else game.lastFrame = performance.now();
  $('pauseOverlay').hidden = !paused;
  $('pauseButton').setAttribute('aria-label', paused ? 'Resume game' : 'Pause game');
}

function toast(text, error = false) {
  const el = $('toast'); el.textContent = text; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}
function feed(title, detail) {
  const entry = document.createElement('div');
  const bold = document.createElement('b'); bold.textContent = `${title}  `;
  entry.append(bold, document.createTextNode(detail));
  $('eventFeed').prepend(entry);
  setTimeout(() => entry.remove(), 3800);
  while ($('eventFeed').children.length > 5) $('eventFeed').lastChild.remove();
}
function currentHero() { return HEROES.find(h => h.tokenId === state.heroId) || null; }
function renderHeroes() {
  const grid = $('heroGrid'); if (!grid) return; grid.replaceChildren();
  const addGuest = document.createElement('button'); addGuest.className = `hero-card${state.heroId==null?' active':''}`; addGuest.type='button';
  addGuest.innerHTML = `<div style="background:#fff7d6">◎</div><strong>DEFAULT RAIDER</strong><small>no NFT • free raid</small>`; addGuest.addEventListener('click', () => { state.heroId=null; storage.write('chogpit.heroId', null); renderHeroes(); applyHero(); toast('Default raider active — no NFT needed.'); }); grid.append(addGuest);
  for (const h of HEROES) {
    const b = document.createElement('button'); b.type='button'; b.className=`hero-card${state.heroId===h.tokenId?' active':''}`;
    b.innerHTML = `<div style="background:${h.bgColor}">${h.eyes==='Fire Laser'?'◉':'◈'}</div><strong>${h.name}</strong><small>${h.body} • ${h.weapon}</small><em>#${h.tokenId}</em>`;
    b.addEventListener('click', () => { state.heroId=h.tokenId; storage.write('chogpit.heroId', h.tokenId); renderHeroes(); applyHero(); toast(`${h.name} equipped — your mint is your fighter.`); });
    grid.append(b);
  }
  const h = currentHero(); $('heroActive').textContent = h ? `ACTIVE: ${h.name} #${h.tokenId} — ${h.body} / ${h.eyes} / ${h.aura} → ${h.weapon.toUpperCase()} • ${h.ability} • TIER ${h.tier}` : 'ACTIVE: Default Raider (no hero needed)';
}
function applyHero() { const h = currentHero(); game.setHero(h); }
function updateLocker() {
  $('crateCount').textContent = state.crates;
  $('lockerBadge').textContent = state.crates;
  $('lockerBadge').hidden = state.crates < 1;
  $('openCrateButton').disabled = state.crates < 1;
  $('equippedMod').textContent = state.equipped || 'NONE';
  $('collectionCount').textContent = `${new Set(state.collection).size} MODS DISCOVERED`;
  $('cycleModButton').disabled = state.collection.length === 0;
  game.equipMod(state.equipped);
  storage.write('chogpit.crates', state.crates); storage.write('chogpit.collection', state.collection); storage.write('chogpit.equipped', state.equipped);
}
function updateCareer() {
  const best = state.bestScore.toLocaleString(), rep = state.rep.toLocaleString();
  $('lobbyBest').textContent = best; $('lobbyRep').textContent = rep;
  $('lockerBest').textContent = best; $('lockerRep').textContent = rep;
  storage.write('chogpit.pitRep', state.rep); storage.write('chogpit.bestScore', state.bestScore);
}
function renderPitDossier() {
  const arena = state.arena, demo = state.id === 'demo';
  $('pitDossierKicker').textContent = demo ? 'TUTORIAL / OPEN TRAINING PIT' : `ON-CHAIN TOKEN ID #${state.id} · ART NAME BELOW`;
  $('pitDossierTitle').textContent = demo ? 'TRAINING PIT · NOT AN NFT' : arena.nftName || `CHOG #${state.id}`;
  $('pitDossierOwner').textContent = demo ? 'Everyone can test building here. Demo scars are training-only.'
    : `ON-CHAIN OWNER AT LAST LOAD: ${/^0x[0-9a-fA-F]{40}$/.test(arena.owner || '') ? shortAddress(arena.owner) : 'CHECK UNAVAILABLE'} · Only the current owner can sign and save defenses; ownership is rechecked on each save.`;
  $('pitDossierTraits').textContent = demo ? 'No NFT traits in the tutorial.'
    : (arena.traitHighlights?.length ? arena.traitHighlights.join(' · ') : 'Traits unavailable · token ID alone seeds the pit');
  $('pitDossierRoute').textContent = `${game.layoutName || 'OPEN TRAINING PIT'} · ${game.mapCode || '----'}`;
  $('pitDossierTraps').textContent = `${arena.traps?.length || 0} / 8`;
  $('pitDossierRaids').textContent = Number(arena.raids) || 0;
  $('pitDossierClears').textContent = Number(arena.clears) || 0;
  $('pitDossierScars').textContent = arena.scars?.length || 0;
  const scarTypes = ['acid', 'static', 'spores'].map(type => {
    const count = arena.scars?.filter(scar => scar.type === type).length || 0;
    return count ? `${count} ${type.toUpperCase()}` : null;
  }).filter(Boolean).join(' · ');
  const last = arena.lastRun;
  const newestScar = arena.scars?.at(-1);
  $('pitDossierChronicle').textContent = demo
    ? `Training records reset by the host. ${last ? `Last practice: ${last.won ? 'EXTRACTED' : 'FAILED'} · ${last.loot} supplies.` : 'Finish a tutorial run to try a scar.'}`
    : `${scarTypes ? `ACTIVE SCARS: ${scarTypes}. Acid damages, static shoots, spores slow. ` : 'NO ACTIVE SCARS YET. '}${newestScar?.raider ? `LAST MARK: ${newestScar.raider} chose ${newestScar.type.toUpperCase()}. ` : ''}Traps, raids and scars live on this game host under token #${state.id}, NOT on the NFT contract.`;
  $('pitRecentLabel').textContent = demo ? 'TRAINING HISTORY · TUTORIAL ONLY' : 'RECENT SERVER RAIDS · TOKEN HISTORY';
  const recentList = $('pitRecentRuns'); recentList.replaceChildren();
  const recentRuns = Array.isArray(arena.recentRuns) && arena.recentRuns.length
    ? arena.recentRuns.slice(0, 5) : last ? [last] : [];
  for (const run of recentRuns) {
    const li = document.createElement('li'); li.classList.toggle('clear', run.won === true);
    const when = run.at && Number.isFinite(Date.parse(run.at))
      ? new Date(run.at).toISOString().slice(5, 16).replace('T', ' ') + ' UTC' : '';
    li.textContent = `${run.won ? '✓ EXTRACTED' : '× FAILED'} · ${{ 'server-solo': 'SOLO', 'live-pvp': 'PVP', 'live-coop': 'CO-OP', 'solo-unverified': 'TUTORIAL' }[run.mode] || 'RAID'}${run.raider ? ` · ${run.raider}` : ''} · ${Number(run.loot) || 0} SUPPLIES${when ? ` · ${when}` : ''}`;
    recentList.append(li);
  }
  if (!recentRuns.length) {
    const li = document.createElement('li'); li.textContent = demo ? 'NO TRAINING RUNS YET' : 'BE THE FIRST TO RAID THIS NFT PIT'; recentList.append(li);
  }
  $('sharePitButton').hidden = demo || document.body.dataset.offline === 'true';
  const art = $('pitDossierArt'), url = demo ? null : arena.imageUrl;
  if (!url) { art.src = '/assets/chogbadge.jpg'; art.dataset.artUrl = ''; }
  else if (art.dataset.artUrl !== url) {
    art.src = '/assets/chogbadge.jpg'; art.dataset.artUrl = url;
    const preload = new Image(), id = state.id;
    preload.onload = () => { if (state.id === id && art.dataset.artUrl === url) art.src = url; };
    preload.onerror = () => { if (art.dataset.artUrl === url) art.dataset.artUrl = ''; };
    preload.src = url;
  }
  for (const button of document.querySelectorAll('[data-featured-pit]')) {
    const selected = !demo && button.dataset.featuredPit === state.id;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
function updateArenaLabels() {
  const demo = state.id === 'demo';
  const label = demo ? 'TRAINING PIT' : `CHOG NFT #${state.id}`;
  $('arenaHeader').textContent = label;
  $('miniArena').textContent = demo ? '#DEMO' : `#${state.id}`;
  $('arenaDescription').textContent = demo ? document.body.dataset.offline === 'true' ? 'OFFLINE TRAINING · NFT ARENAS REQUIRE THE HOSTED GAME' : 'TRAINING PIT · PICK A MINTED NFT ABOVE TO RAID' : `${state.arena.nftName || `CHOG TOKEN #${state.id}`} · ${state.arena.traitLabel || 'NFT ARENA'} · ${game.layoutName}`;
  const playText = demo ? 'TRY THE TRAINING PIT' : `RAID CHOG NFT #${state.id} · SERVER SOLO`;
  if ($('playButton').firstChild?.textContent !== playText) {
    const arrow = document.createElement('span'); arrow.textContent = '↗';
    $('playButton').replaceChildren(document.createTextNode(playText), arrow);
  }
  $('builderArenaName').textContent = demo ? 'TRAINING PIT' : `${state.arena.nftName || 'CHOG NFT'} · TOKEN ID #${state.id}`;
  $('verificationStatus').textContent = demo ? 'DEMO BUILDER UNLOCKED' : state.verified ? `OWNER VERIFIED · ${Number(state.chogBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} $CHOG` : 'OWNER VERIFICATION REQUIRED';
  $('verifyButton').textContent = demo ? 'DEMO MODE · NO WALLET NEEDED' : state.verified ? '✓ NFT OWNER VERIFIED' : 'VERIFY NFT OWNERSHIP ↗';
  $('verifyButton').disabled = demo || state.verified;
  if (!state.live) $('buildButton').textContent = demo ? 'TRAINING BUILDER' : `BUILD NFT #${state.id}`;
  const soloCard = $('soloBountyButton');
  soloCard.querySelector('strong').firstChild.textContent = demo ? 'TUTORIAL SERVER SOLO ' : 'SERVER SOLO ';
  soloCard.querySelector('strong span').textContent = demo ? 'TRAINING ONLY' : 'NFT RAID + BOX PREVIEW';
  soloCard.querySelector('small').textContent = demo
    ? 'Demo bots · no NFT history · sample-only boxes' : `CHOG #${state.id} · server-verified raid · sample-only boxes`;
  $('liveEntry').querySelector('.live-mode-card strong').firstChild.textContent = demo ? 'TRAINING LIVE ROOM ' : 'PRIVATE NFT LIVE ROOM ';
  $('createRoomButton').textContent = demo ? 'CREATE A TRAINING ROOM ↗' : `CREATE ROOM IN NFT #${state.id} ↗`;
  const art = $('ownerArt'), url = demo ? null : state.arena.imageUrl;
  if (!url) { art.src = '/assets/chogbadge.jpg'; art.dataset.artUrl = ''; }
  else if (art.dataset.artUrl !== url) {
    art.src = '/assets/chogbadge.jpg'; art.dataset.artUrl = url;
    const preload = new Image(), id = state.id;
    preload.onload = () => { if (state.id === id && art.dataset.artUrl === url) art.src = url; };
    preload.onerror = () => { if (art.dataset.artUrl === url) art.dataset.artUrl = ''; };
    preload.src = url;
  }
  renderPitDossier();
}
function renderSamplePass() {
  $('passPreviewStatus').textContent = state.samplePass
    ? 'SAMPLE PASS DISPLAYED · BROWSER ONLY · NO NFT OR CHOG CREDIT'
    : 'NO SAMPLE PASS YET · GAMEPLAY IS OPEN TO EVERYONE';
  $('passArtSerial').textContent = state.samplePass ? '# SAMPLE / NOT MINTED' : '# PREVIEW';
  $('passPreviewButton').textContent = state.samplePass ? 'SAMPLE PASS IN THIS BROWSER ✓' : 'TRY SAMPLE PASS ↗';
}
function renderPreviewWallet() {
  $('previewBalance').textContent = document.body.dataset.gameOnly === 'true'
    ? 'SAMPLES ONLY' : `${state.previewBalance} PREVIEW`;
}
async function refreshClaimStatus() {
  if (document.body.dataset.offline === 'true') return toast('Real CHOG claims require a reviewed, funded hosted app.', true);
  try {
    const status = await API('/api/claims/status');
    // Even if a future API advertises readiness, this preview deliberately has
    // no active claim button or token-transfer route. Never promote test points.
    $('claimBadge').textContent = 'NOT LIVE';
    $('claimExplanation').textContent = status.message || 'Real claims are not enabled in this playtest.';
    toast('No real CHOG claims are live. Preview balances are not redeemable.');
  } catch (error) { toast(error.message.slice(0, 130), true); }
}
function closePanel() {
  $('builderPanel').hidden = true; $('lockerPanel').hidden = true; $('panelScrim').hidden = true;
  state.panel = null;
  if (state.mode === 'build') { state.mode = 'lobby'; game.setPreview(); $('lobbyOverlay').hidden = false; }
  else if (game.mode === 'paused' && state.mode === 'play') { game.mode = 'play'; }
}
function openBuilder() {
  if (state.live) return toast('Leave the live room before opening the arena builder.', true);
  if (state.mode === 'play') { state.mode = 'lobby'; $('gameHud').hidden = true; }
  releaseInteract(); $('pauseOverlay').hidden = true;
  $('lobbyOverlay').hidden = true; $('resultOverlay').hidden = true; $('lockerPanel').hidden = true;
  $('builderPanel').hidden = false; $('builderPanel').scrollTop = 0;
  $('panelScrim').hidden = true; state.panel = 'builder'; state.mode = 'build';
  if (state.id === 'demo' || state.verified) game.enterBuilder();
  else { game.setPreview(); toast('Connect the wallet that owns this Chog NFT to edit its arena.'); }
  updateArenaLabels(); updateBuilderNote();
}
function openLocker() {
  if (state.live) return toast('Leave the live room to open your locker.', true);
  if (state.mode === 'play') { game.mode = 'paused'; game.keys.clear(); game.clearTouch(); releaseInteract(); $('pauseOverlay').hidden = true; }
  $('lockerPanel').hidden = false; $('lockerPanel').scrollTop = 0;
  $('builderPanel').hidden = true; $('panelScrim').hidden = false;
  state.panel = 'locker'; updateLocker();
}
function showLobby() {
  if (state.live) return showRoomScreen();
  state.mode = 'lobby'; closePanel(); releaseInteract(); game.setPreview();
  document.body.classList.remove('live-active'); $('roomOverlay').hidden = true; $('liveScoreboard').hidden = true;
  $('respawnOverlay').hidden = true;
  $('matchLabel').textContent = 'FREE BOT PLAYTEST'; $('pauseButton').innerHTML = 'Ⅱ <span>PAUSE</span>';
  $('pauseButton').setAttribute('aria-label', 'Pause game');
  $('buildButton').textContent = state.id === 'demo' ? 'TRAINING BUILDER' : `BUILD NFT #${state.id}`;
  $('buildButton').setAttribute('aria-label', state.id === 'demo' ? 'Open tutorial builder' : `Build Chog NFT #${state.id}`);
  $('lobbyOverlay').hidden = false; $('lobbyOverlay').scrollTop = 0;
  $('resultOverlay').hidden = true; $('gameHud').hidden = true; $('pauseOverlay').hidden = true;
  $('interactPrompt').hidden = true; updateResultPreview();
  if (state.id !== 'demo' && !state.loading) refreshArenaRecord();
}
function startRun() {
  if (state.live) return toast('Leave the live room before starting solo practice.', true);
  audio.unlock(); closePanel(); releaseInteract();
  game.setArena(state.arena); game.start();
  state.mode = 'play'; state.summary = null; state.payout = null; state.claimed = false;
  $('lobbyOverlay').hidden = true; $('resultOverlay').hidden = true; $('gameHud').hidden = false; $('pauseOverlay').hidden = true;
  $('hudTime').textContent = '03:00'; $('hudBag').textContent = `0/${REQUIRED_SUPPLIES} SUPPLIES`;
  $('hudRisk').textContent = '2 SUPPLIES TO BANK · HEAT 0';
  $('missionHint').textContent = matchMedia('(pointer:coarse)').matches ? 'Move beside yellow crates and tap OPEN. 2 supplies unlock extraction.' : 'Open yellow crates with E. 2 supplies unlock extraction.';
  state.mark = 'acid'; document.querySelectorAll('[data-mark]').forEach(b => b.classList.toggle('selected', b.dataset.mark === state.mark));
  $('eventFeed').textContent = '';
}
async function refreshArenaRecord() {
  const id = state.id;
  try {
    const arena = await API(`/api/arena/${encodeURIComponent(id)}`);
    if (state.id !== id || state.loading) return;
    state.arena = arena;
    if (game.mode === 'preview') game.setArena(arena);
    updateArenaLabels();
  } catch (error) {
    if (state.id === id) toast(`Could not refresh this NFT pit: ${error.message.slice(0, 90)}`, true);
  }
}
async function loadArena(id, quiet = false) {
  if (state.live) return toast('Leave the live room before changing arenas.', true);
  id = String(id).trim();
  if (id !== 'demo' && !/^(0|[1-9]\d{0,6})$/.test(id)) return toast('Enter a numeric on-chain Chog token ID—or play the demo.', true);
  if (state.loading) return;
  state.loading = true; $('playButton').disabled = true;
  $('arenaDescription').textContent = id === 'demo' ? 'LOADING TRAINING PIT...' : `READING CHOG #${id} ON MONAD...`;
  try {
    const arena = await API(`/api/arena/${encodeURIComponent(id)}`);
    state.id = id; state.arena = arena; state.verified = false; state.chogBalance = 0;
    game.setArena(arena); updateArenaLabels(); showLobby(); $('arenaInput').value = '';
    if (document.body.dataset.offline !== 'true') {
      const url = new URL(location.href);
      if (id === 'demo') url.searchParams.delete('pit'); else url.searchParams.set('pit', id);
      if (!quiet) url.searchParams.delete('room');
      history.replaceState(null, '', url);
    }
    if (!quiet) toast(id === 'demo' ? 'Training pit loaded. Minted NFT arenas are the main game.' : `Chog NFT #${id} loaded. Server-run raids can leave persistent host-side scars.`);
  } catch (error) { toast(error.message.slice(0, 145), true); updateArenaLabels(); }
  finally { state.loading = false; $('playButton').disabled = false; }
}
async function connectWallet() {
  if (!window.ethereum?.request) { toast('No wallet found. Use a wallet-enabled browser for NFT ownership; the demo needs none.', true); return false; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) throw new Error('No account selected.');
    const chain = await window.ethereum.request({ method: 'eth_chainId' });
    if (chain.toLowerCase() !== '0x8f') {
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x8f' }] }); }
      catch (error) {
        if (error.code !== 4902) throw error;
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x8f', chainName: 'Monad Mainnet', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: ['https://rpc.monad.xyz'], blockExplorerUrls: ['https://monadscan.com'] }] });
      }
    }
    state.wallet = accounts[0]; $('walletLabel').textContent = shortAddress(state.wallet);
    toast('Wallet connected on Monad. No transaction was sent.');
    if (state.id !== 'demo') await verifyOwner();
    return true;
  } catch (error) { toast(error?.message?.slice(0, 125) || 'Connection cancelled.', true); return false; }
}
async function verifyOwner() {
  if (state.id === 'demo') return toast('Demo building is open. Load your on-chain token ID to verify an NFT.');
  if (!state.wallet && !(await connectWallet())) return;
  try {
    $('verificationStatus').textContent = 'CHECKING NFT OWNER AND $CHOG BALANCE...';
    const result = await API(`/api/chain/${encodeURIComponent(state.wallet)}/${state.id}`);
    state.verified = result.isOwner; state.chogBalance = Number(result.balance);
    state.arena.owner = result.owner; updateArenaLabels();
    if (state.verified) { toast('NFT owner verified. This arena is yours to edit.'); if (state.mode === 'build') game.enterBuilder(); }
    else { $('verificationStatus').textContent = `OWNED BY ${shortAddress(result.owner)}`; toast('That wallet does not own this Chog NFT. You can still raid it.', true); }
  } catch (error) { state.verified = false; $('verificationStatus').textContent = 'ON-CHAIN CHECK FAILED'; toast(error.message.slice(0, 125), true); }
}
function updateBuilderNote() {
  $('trapCount').textContent = `${game.arena.traps.length} / 8 PLACED`;
  $('builderNote').textContent = state.id === 'demo'
    ? document.body.dataset.offline === 'true'
      ? 'Open training pit: all defenses are free here. Edits reset when this file reloads; wallet checks are unavailable.'
      : 'Open training pit: anyone can build here; Pulse is free to test. Real NFT pits require verified ownership.'
    : state.verified ? 'Review the exact trap layout in your wallet signature—no transaction.' : 'Owner must connect and verify before saving this NFT arena.';
}
async function saveArena() {
  if (state.id !== 'demo' && !state.verified) return toast('Only the current NFT owner can save this arena.', true);
  // Snapshot the exact grid before the wallet prompt; edits made while the
  // wallet is open must not change the layout authorized by this signature.
  const traps = game.arena.traps.map(({ type, x, y }) => ({ type, x, y }));
  try {
    $('saveArenaButton').disabled = true; $('saveArenaButton').textContent = 'SAVING...';
    let body = { traps };
    if (state.id !== 'demo') {
      const challenge = await API(`/api/arena/${state.id}/challenge`, {
        method: 'POST', body: JSON.stringify({ account: state.wallet, traps })
      });
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [challenge.message, state.wallet] });
      body = { ...body, account: state.wallet, nonce: challenge.nonce, signature };
    }
    const arena = await API(`/api/arena/${state.id}/traps`, { method: 'POST', body: JSON.stringify(body) });
    state.arena = { ...state.arena, ...arena }; updateArenaLabels();
    $('builderNote').textContent = `Saved ${traps.length} traps to ${state.id === 'demo' ? 'the training pit' : `token #${state.id}`}.`;
    toast('Arena saved. Raiders will meet these defenses!');
  } catch (error) {
    if (/only the current NFT owner/i.test(error.message)) {
      state.verified = false; state.chogBalance = 0; updateArenaLabels();
      refreshArenaRecord(); // Re-read owner after a transfer; the old owner loses edit rights.
    }
    toast(error.message.slice(0, 145), true);
  }
  finally { $('saveArenaButton').disabled = false; $('saveArenaButton').textContent = 'SAVE ARENA ↗'; }
}
async function postRun(summary, mark) {
  const id = state.id;
  if (id !== 'demo') {
    toast('Practice result only. NFT scars and raid records require server-run solo or a private PvP/co-op room.');
    return;
  }
  try {
    const arena = await API(`/api/arena/${id}/raid`, { method: 'POST', body: JSON.stringify({ won: summary.won, loot: summary.loot, kills: summary.kills, timeLeft: summary.timeLeft, mark }) });
    if (state.id === id) { state.arena = { ...state.arena, ...arena }; updateArenaLabels(); }
  } catch (error) { toast(`Run complete, but arena record did not save: ${error.message.slice(0, 80)}`, true); }
}
function showResult(summary, options = {}) {
  const live = options.live === true;
  state.summary = summary; state.payout = live ? options.payout : payoutForRun(summary);
  state.claimed = false; state.mode = 'result';
  if (live && state.live) state.live.resultShown = true;
  releaseInteract();
  const earned = state.payout.crates > 0, count = state.payout.crates;
  earned ? audio.win() : audio.fail();
  $('resultOverlay').hidden = false; $('resultOverlay').scrollTop = 0;
  $('gameHud').hidden = true; $('pauseOverlay').hidden = true; $('respawnOverlay').hidden = true;
  $('resultKicker').textContent = earned ? `${state.payout.name} / ${count} FREE CRATE${count === 1 ? '' : 'S'}` : live
    ? state.live?.mode === 'solo' ? 'SERVER SOLO / HAUL LOST' : state.live?.mode === 'coop' ? 'CO-OP / HAUL LOST' : 'LIVE PVP / HAUL LOST'
    : 'RAID FAILED / HAUL LOST';
  $('resultTitle').textContent = earned ? 'YOU GOT OUT.' : live ? summary.timeLeft <= 0 ? 'TIME RAN OUT.' : 'ELIMINATED.' : 'THE PIT WON.';
  $('resultDescription').textContent = earned ? (state.id !== 'demo' && !live
    ? `You got out with ${summary.loot} supplies and ${summary.kills} eliminations in practice. Claim free cosmetics; only server-run raids can leave a persistent NFT scar.`
    : `You got out with ${summary.loot} supplies and ${summary.kills} eliminations. Choose a scar, then claim your free cosmetics.`)
    : live && state.live?.mode === 'solo' ? `You dropped ${summary.loot} supplies. No unbanked cosmetic crates or Pit Rep. Hidden-box points, if any, are preview-only.`
    : live && state.live?.mode === 'coop' ? `The clock ran out or you lost your final life. Your team can grab dropped supplies; only successful extractions bank free cosmetics.`
    : live ? `You dropped ${summary.loot} supplies. Other raiders can grab your dropped haul. No unbanked crates or Pit Rep.`
    : `You dropped ${summary.loot} supplies. Unextracted loot earns no crates or Pit Rep.`;
  $('resultKills').textContent = summary.kills; $('resultLoot').textContent = summary.loot;
  $('resultTime').textContent = formatClock(summary.timeUsed); $('resultScore').textContent = state.payout.score.toLocaleString();
  $('resultPayout').textContent = earned ? `${count} FREE COSMETIC CRATE${count === 1 ? '' : 'S'} + ${state.payout.score.toLocaleString()} PIT REP` : '0 CRATES · 0 PIT REP · TRY ANOTHER ROUTE';
  $('resultPayout').dataset.tier = state.payout.key;
  updateResultPreview();
  $('resultLiveStandings').hidden = !live;
  if (live) renderStandings();
  $('scarLabel').textContent = state.id === 'demo' ? 'LEAVE A SCAR ON THIS DEMO PIT'
    : live ? `LEAVE A SCAR ON CHOG NFT TOKEN #${state.id}` : 'PRACTICE SCAR — NOT SAVED ON THE NFT PIT';
  $('mutationPicker').hidden = !earned; $('resultButton').hidden = !earned;
  $('resultButton').disabled = false; $('resultButton').innerHTML = `CLAIM ${count} FREE CRATE${count === 1 ? '' : 'S'} <span>↗</span>`;
  $('retryButton').hidden = earned;
  $('retryButton').textContent = live ? 'SEE ROOM STANDINGS →' : 'DROP BACK IN →';
  $('resultMenuButton').textContent = live ? earned ? 'VIEW ROOM WITHOUT BANKING' : 'SEE ROOM STANDINGS' : earned ? 'LEAVE WITHOUT BANKING' : 'BACK TO MENU';
  if (!earned && !live) postRun(summary, null);
}
async function claimRun() {
  if (!state.payout?.crates) return;
  if (state.claimed) return state.live ? showRoomScreen() : startRun();
  const payout = state.payout, summary = state.summary, mark = state.mark;
  state.claimed = true; $('resultButton').disabled = true; $('resultButton').textContent = 'BANKING YOUR HAUL...';
  // REAL CHOG for holders: 5/10/25 roll per win → 50 auto-payout from vault 0x371a…
  const w=localStorage.getItem('chogpit.wallet');
  if(w && summary.won){
    const roll=Math.random(); const delta= roll<0.70?5: roll<0.95?10:25;
    try{
      const r=await fetch('/api/chog/credit',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({wallet:w, delta, runId: state.id+'-'+Date.now()})}).then(r=>r.json());
      if(r.balance!==undefined){
        if(r.paid && r.payoutHash) toast(`💰 REAL 50 CHOG SENT → ${w.slice(0,6)}… tx ${r.payoutHash.slice(0,10)}…`, false);
        else if(!r.paid) toast(`+${delta} CHOG → ${r.balance}/50 until REAL 50 CHOG payout (holder #${r.isHolder?'✓':''})`, false);
      } else if(r.error && r.error.includes('Not a holder')) toast('Sample +'+delta+' CHOG — claim CHOG #1-40 on /choose.html for REAL 50 CHOG vault', true);
    }catch{}
  }
  state.crates += payout.crates; state.rep += payout.score;
  state.bestScore = Math.max(state.bestScore, payout.score);
  updateLocker(); updateCareer();
  if (state.live) sendLive({ type: 'scar', mark });
  else await postRun(summary, mark);
  if (state.mode !== 'result' || state.summary !== summary) return;
  $('resultButton').disabled = false; $('resultButton').innerHTML = state.live ? 'VIEW ROOM <span>↗</span>' : 'DROP BACK IN <span>↗</span>';
  $('resultDescription').textContent = state.live ? `Banked locally! Your ${payout.crates} free cosmetic crate${payout.crates === 1 ? '' : 's'} are in the locker. Scar requested on the live arena.` : `Banked! Your ${payout.crates} free crate${payout.crates === 1 ? '' : 's'} are in the locker. This arena now carries your scar.`;
  $('resultPayout').textContent = `BANKED · BEST RAID ${state.bestScore.toLocaleString()} · TOTAL REP ${state.rep.toLocaleString()}`;
  $('resultMenuButton').textContent = state.live ? 'VIEW ROOM' : 'BACK TO MENU'; $('mutationPicker').hidden = true;
  toast(`${payout.crates} free crate${payout.crates === 1 ? '' : 's'} earned! Your raid is banked.`);
}
function openCrate() {
  if (state.crates < 1) return; audio.unlock(); audio.crate(); state.crates--;
  const unseen = REWARDS.filter(r => !state.collection.includes(r.name));
  const pool = unseen.length ? unseen : REWARDS;
  const reward = pool[Math.floor(Math.random() * pool.length)];
  state.collection.push(reward.name); state.equipped = reward.name; updateLocker();
  $('rewardSigil').textContent = reward.symbol; $('rewardRarity').textContent = reward.rarity;
  $('crateModalTitle').textContent = reward.name; $('rewardDescription').textContent = `${reward.description} Equipped for your next run.`;
  $('crateModal').hidden = false; $('closeCrateModal').focus();
}
function onStatus(s) {
  $('hudHpNumber').textContent = s.hp; $('hudHpBar').style.width = `${s.hp}%`; $('hudShieldBar').style.width = `${s.shield / 75 * 100}%`;
  $('hudKills').textContent = s.kills; $('hudLoot').textContent = s.loot; $('hudTime').textContent = formatClock(s.time); $('hudAlive').textContent = `${s.alive} IN THE PIT`;
  $('hudWeapon').textContent = s.weapon; $('weaponIcon').textContent = WEAPONS[s.weapon].icon;
  $('hudAmmo').textContent = s.reloading ? 'RELOADING...' : Number.isFinite(s.ammo) ? `${s.ammo} / ${s.reserve} AMMO` : '∞ AMMO';
  $('hudBag').textContent = s.loot < REQUIRED_SUPPLIES ? `${s.loot}/${REQUIRED_SUPPLIES} SUPPLIES` : `${s.loot} SUPPLIES`;
  const potential = payoutForRun({ won: true, loot: s.loot, kills: s.kills, timeLeft: s.time });
  $('hudRisk').textContent = potential.crates ? `${potential.name} · ${potential.crates} CRATE${potential.crates === 1 ? '' : 'S'} · HEAT ${s.heat}` : `2 SUPPLIES TO BANK · HEAT ${s.heat}`;
  $('hudRisk').dataset.tier = potential.key;
  $('hudExtract').textContent = `EXIT ${s.extractDistance}m ▸`;
  $('hudDash').textContent = s.dash > 0 ? `DASH ${s.dash.toFixed(1)}s` : 'SPACE · DASH';
  $('interactPrompt').hidden = !s.action;
  if (!s.action && interactPointerId !== null) releaseInteract();
  const touchUI = matchMedia('(pointer:coarse)').matches;
  if (s.action) {
    $('interactPrompt').disabled = s.action.type === 'extract' && s.loot < REQUIRED_SUPPLIES;
    $('interactText').textContent = touchUI && s.action.type === 'reward' ? 'OPEN SECRET · TEST ONLY'
      : touchUI && s.action.type === 'cache' ? 'OPEN SUPPLY'
      : s.action.type === 'extract' && s.loot >= REQUIRED_SUPPLIES ? `${touchUI ? 'HOLD EXIT' : 'HOLD E TO EXTRACT'} · ${s.holdTime.toFixed(1)}s` : s.action.text;
    $('interactPrompt').setAttribute('aria-label', $('interactText').textContent);
    $('holdTrack').hidden = s.action.type !== 'extract' || s.loot < REQUIRED_SUPPLIES;
    $('holdFill').style.width = `${Math.round(s.extractProgress * 100)}%`;
  }
  $('missionHint').textContent = s.storm ? 'THE STORM IS CLOSING · BANK YOUR HAUL AT THE EXIT!' : s.loot < REQUIRED_SUPPLIES ? `${touchUI ? 'Tap OPEN near' : 'Press E at'} yellow crates or grab raider drops. ${REQUIRED_SUPPLIES - s.loot} supplies to exit.` : potential.crates === 1 ? s.heat ? 'HUNTER ON YOUR TRAIL · 4 supplies OR 2 elims = 2 crates.' : 'SAFE EXIT READY · 4 supplies OR 2 elims = 2 crates. More loot raises HEAT.' : potential.crates === 2 ? 'DOUBLE HAUL READY · HUNTERS ACTIVE · 6 supplies + 2 elims = 3 crates.' : 'PIT LEGEND READY · HOLD THE EXIT THROUGH THE HEAT FOR 3 CRATES!';
  if (state.live?.phase === 'playing') {
    const live = state.live;
    const rivals = live.mode === 'pvp' ? `${s.alive} RAIDERS` : `${s.botsAlive} BOTS`;
    const lives = live.mode === 'solo' ? '' : ` · ${s.livesLeft ?? 5}/5 LIVES`;
    $('hudRisk').textContent = `${potential.crates ? `${potential.name} · ${potential.crates} FREE CRATE${potential.crates === 1 ? '' : 'S'}` : '2 SUPPLIES TO BANK'} · ${rivals}${lives}`;
    $('missionHint').textContent = live.mode === 'solo'
      ? s.storm ? 'STORM CLOSING · GET TO THE EXIT!' : s.loot < 2 ? 'FIGHT BOTS · OPEN 2 YELLOW SUPPLIES · EXPLORE FOR PINK TEST BOXES.' : 'EXIT READY · hidden pink boxes are test-only, not claimable CHOG.'
      : live.mode === 'coop'
        ? s.storm ? 'STORM CLOSING · TEAM UP AND EXIT BEFORE THE CLOCK!' : s.loot < 2 ? 'FIGHT BOTS TOGETHER · OPEN YELLOW SUPPLIES OR GRAB BOT DROPS · 2 TO EXIT.' : 'EXIT READY · EXTRACT YOUR HAUL · FRIENDLY FIRE IS OFF.'
        : s.storm ? 'STORM CLOSING · EXIT BEFORE THE CLOCK RUNS OUT!' : s.loot < 2 ? 'OPEN yellow crates · other raiders can take your haul · 2 supplies to exit.' : 'EXIT READY · extra supplies and eliminations raise rewards, but extend the exit hold.';
  }
}

function sendLive(message) {
  const ws = state.live?.ws;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function renderStandings() {
  const live = state.live;
  if (!live) return;
  const sorted = [...(live.standings || [])].sort((a, b) => {
    const rank = { escaped: 0, active: 1, respawning: 2, waiting: 3, eliminated: 4 };
    return (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || (b.score || 0) - (a.score || 0) || b.loot - a.loot;
  });
  const fill = (target, className, rows) => {
    target.replaceChildren();
    for (const player of rows) {
      const row = document.createElement('div'); row.className = `${className}${player.id === live.you ? ' you' : ''}`;
      const name = document.createElement('span');
      const dot = document.createElement('i'); dot.className = 'player-dot'; dot.style.backgroundColor = player.color || '#ffa9b8';
      name.append(dot, document.createTextNode(`${player.name}${player.id === live.hostId ? ' ★' : ''}`));
      const score = document.createElement('small');
      score.textContent = player.status === 'escaped' ? `${player.score} PTS`
        : player.status === 'active' ? `${player.loot} BAG · ${player.kills} ELIM${live.mode === 'solo' ? '' : ` · ${player.livesLeft}L`}`
        : player.status === 'respawning' ? `BACK IN ${Math.max(1, Math.ceil(player.respawnIn))}s · ${player.livesLeft}L`
        : player.status === 'eliminated' ? 'OUT · 0 PTS' : 'READY';
      row.append(name, score); target.append(row);
    }
  };
  fill($('roomPlayers'), 'room-player', sorted);
  if (live.mode !== 'solo' && ['waiting', 'countdown'].includes(live.phase)) for (let i = sorted.length; i < 4; i++) {
    const slot = document.createElement('div'); slot.className = 'room-player empty'; slot.textContent = '＋ INVITE SLOT'; $('roomPlayers').append(slot);
  }
  fill($('liveScoreRows'), 'live-score-row', sorted);
  fill($('resultLiveRows'), 'result-standings-row', sorted);
  $('liveScoreHeader').textContent = live.mode === 'solo' ? 'SERVER SOLO · BOTS + HIDDEN PREVIEW BOXES'
    : `${live.mode === 'coop' ? 'CO-OP VS BOTS' : 'PVP'} · ${live.code} · BANK YOUR ESCAPE`;
}
function renderRoom() {
  const live = state.live;
  if (!live) return;
  const count = live.standings?.length || 0;
  const ready = live.standings?.filter(player => player.connected).length || 0;
  const winner = live.standings?.find(player => player.id === live.winnerId);
  const winnerLabel = live.winnerName || winner?.name;
  $('roomCode').textContent = live.mode === 'solo' ? 'SOLO' : live.code || '······';
  $('copyRoomLink').hidden = live.mode === 'solo';
  $('copyRoomLink').disabled = !live.code;
  $('roomArena').textContent = live.arena ? `${live.arena.nftName || (live.arena.id === 'demo' ? 'TRAINING PIT · NOT AN NFT' : `CHOG #${live.arena.id}`)} · ${live.arena.traitLabel || 'NFT ARENA'}` : 'CONNECTING TO THE SERVER';
  const privateRoom = live.mode !== 'solo', canPickMode = privateRoom
    && live.you === live.hostId && ready >= 2 && ['waiting', 'finished'].includes(live.phase);
  $('roomKicker').textContent = live.mode === 'solo'
    ? `${live.arena?.id === 'demo' ? 'TUTORIAL' : 'CHOG NFT'} SERVER SOLO · 1 LIFE`
    : `${live.arena?.id === 'demo' ? 'TRAINING' : 'NFT'} PRIVATE ${live.mode === 'coop' ? 'CO-OP VS BOTS' : 'PVP'} · 2–4 RAIDERS`;
  $('roomModeChooser').hidden = !privateRoom || !['waiting', 'finished', 'countdown'].includes(live.phase);
  for (const button of document.querySelectorAll('[data-room-mode]')) {
    const selected = button.dataset.roomMode === live.mode;
    button.disabled = !canPickMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  $('roomModeHint').textContent = ready < 2 ? 'Invite at least one friend before choosing the mode.'
    : live.phase === 'countdown' ? 'Mode locked · dropping in now.'
    : live.you === live.hostId ? `YOU CHOSE ${live.mode === 'coop' ? 'CO-OP VS BOTS' : 'PVP'} · change it before starting.`
      : `HOST CHOSE ${live.mode === 'coop' ? 'CO-OP VS BOTS' : 'PVP'} · wait for the host to start.`;
  $('roomFineprint').textContent = privateRoom
    ? '3 minutes · collect 2 supplies and extract · 5 lives total (4 respawns) each. The server controls hits, loot, bots and scores. Hidden boxes are non-redeemable samples only.'
    : '3 minutes · collect 2 supplies and extract · 1 life. The server controls bots, loot and scores. Hidden boxes are non-redeemable samples only.';
  $('roomTitle').textContent = live.phase === 'playing' ? live.mode === 'solo' ? 'SOLO RAID IN PROGRESS.'
    : live.mode === 'coop' ? 'BOT RAID IN PROGRESS.' : 'PVP MATCH IN PROGRESS.'
    : live.phase === 'finished' ? live.mode === 'solo' ? winnerLabel ? 'YOU GOT OUT.' : 'TRY ANOTHER ROUTE.'
      : winnerLabel ? live.mode === 'coop' ? `${winnerLabel} EXTRACTED.` : `${winnerLabel} BANKED THE WIN.` : 'NOBODY GOT OUT.'
    : live.phase === 'countdown' ? 'DROPPING IN...' : live.mode === 'solo' ? 'STARTING SOLO RAID...' : 'GATHER YOUR CREW.';
  $('roomStatus').textContent = live.phase === 'playing'
    ? live.campaign ? 'This run never pauses. A recorded opening alone is not CHOG: the opening raider would need a real minted Raider Pass before any real payout. This is not built.'
      : 'This server run never pauses. Hidden boxes are test-only, not real CHOG.'
    : live.phase === 'finished' ? live.mode === 'solo' ? live.campaign
      ? 'Openings need an email-confirmed address before batching and the opening raider’s current minted Raider Pass holder proof before any payout. This preview cannot pay CHOG.'
      : 'Start a fresh solo run or return to the lobby. Test points are not redeemable.'
      : `${ready} connected · the host can switch PvP / co-op before the rematch. Only extracted supplies bank.`
    : live.phase === 'countdown' ? `Launching in ${Math.max(1, Math.ceil((live.startsAt - Date.now()) / 1000))}… Keep this tab open.`
    : live.phase === 'waiting' ? `${count}/4 raiders joined · host chooses PvP or co-op when a friend joins, then starts.` : 'Connecting to the live server…';
  $('roomStartButton').hidden = !(live.phase === 'waiting' || live.phase === 'finished') || live.you !== live.hostId;
  $('roomStartButton').disabled = ready < (live.mode === 'solo' ? 1 : 2);
  $('roomStartButton').innerHTML = `${live.mode === 'solo' ? 'TRY SERVER SOLO AGAIN'
    : `START ${live.mode === 'coop' ? 'CO-OP BOT' : 'PVP'} ${live.phase === 'finished' ? 'REMATCH' : 'ROUND'}`} <span>↗</span>`;
  $('roomResumeButton').hidden = live.phase !== 'playing' || !['active', 'respawning'].includes(game.onlineSelfStatus);
  $('roomLeaveButton').textContent = live.phase === 'playing' && ['active', 'respawning'].includes(game.onlineSelfStatus)
    ? live.mode === 'solo' ? 'LEAVE SOLO · FORFEIT HAUL' : 'LEAVE ROOM · FORFEIT HAUL'
    : 'BACK TO MENU';
  renderStandings();
}
function renderRespawn(snapshot = state.live?.lastSnapshot) {
  const self = snapshot?.players?.find(player => player.id === state.live?.you);
  const show = state.live?.phase === 'playing' && state.mode === 'live' && self?.status === 'respawning'
    && $('roomOverlay').hidden && $('resultOverlay').hidden;
  const overlay = $('respawnOverlay');
  if (show) {
    if (overlay.hidden) { stopFiring(); releaseInteract(); $('interactPrompt').hidden = true; }
    $('respawnTime').textContent = `${Math.max(1, Math.ceil(self.respawnIn))}s`;
    $('respawnLives').textContent = `${self.livesLeft} OF 5 LIVES LEFT · 4 RESPAWNS MAX`;
  }
  overlay.hidden = !show;
}
function showRoomScreen() {
  if (!state.live) return;
  game.keys.clear(); game.clearTouch(); releaseInteract(); if(typeof stopFiring==='function') stopFiring();
  state.mode = 'room';
  $('lobbyOverlay').hidden = true; $('resultOverlay').hidden = true; $('pauseOverlay').hidden = true;
  $('roomOverlay').hidden = false; $('respawnOverlay').hidden = true;
  $('gameHud').hidden = state.live.phase !== 'playing' || !['active', 'respawning'].includes(game.onlineSelfStatus);
  renderRoom();
}
function resumeLivePit() {
  if (!state.live || state.live.phase !== 'playing' || !['active', 'respawning'].includes(game.onlineSelfStatus)) return;
  state.mode = 'live'; $('roomOverlay').hidden = true; $('gameHud').hidden = false;
  renderRespawn();
}
function leaveRoom() {
  if (!state.live) return;
  const ws = state.live.ws;
  state.live = null;
  ws.onclose = null;
  try { ws.close(1000, 'Left room'); } catch {}
  showLobby();
}
function updateResultPreview() {
  const live = state.live;
  $('resultPreview').hidden = !live;
  if (live) $('resultPreview').textContent = live.campaign
    ? `RECORDED BOXES · ${live.rewardFound || 0} · NO CHOG WITHOUT OPENING RAIDER'S REAL RAIDER PASS BEFORE PAYOUT · PREVIEW POINTS NEVER CONVERT`
    : `HIDDEN-BOX TEST · ${live.rewardFound || 0} FOUND · ${live.previewAmount || 0} SIMULATED CHOG · NO REAL TOKENS OR WITHDRAWALS`;
}
function beginLiveRound() {
  const live = state.live;
  if (!live || live.roundStarted || !live.arena) return;
  live.roundStarted = true; live.resultShown = false; live.rewardFound = 0; live.previewAmount = 0;
  live.lastSnapshot = null;
  game.startOnline(live.arena, live.you, live.code, live.mode);
  state.mode = 'live'; state.summary = null; state.payout = null; state.claimed = false;
  updateResultPreview();
  $('lobbyOverlay').hidden = true; $('roomOverlay').hidden = true; $('respawnOverlay').hidden = true;
  $('resultOverlay').hidden = true; $('gameHud').hidden = false; $('pauseOverlay').hidden = true;
  $('liveScoreboard').hidden = false; document.body.classList.add('live-active');
  $('matchLabel').textContent = live.mode === 'solo'
    ? live.campaign ? 'SERVER SOLO · CAMPAIGN' : 'SERVER SOLO · PREVIEW'
    : `${live.mode === 'coop' ? 'CO-OP VS BOTS' : 'LIVE PVP'} · ${live.code}`;
  $('pauseButton').innerHTML = '☰ <span>ROOM</span>';
  $('pauseButton').setAttribute('aria-label', 'Open server-run room menu; the match does not pause');
  $('eventFeed').textContent = '';
  audio.unlock(); feed(live.mode === 'solo' ? 'SOLO DROP' : live.mode === 'coop' ? 'BOT RAID' : 'PVP DROP', live.campaign
    ? 'Open 2 supplies to escape. Email-confirmed address before batch; the opening raider would need to prove current ownership of a real minted Raider Pass before any real CHOG payout. This game preview cannot pay.'
    : `Open 2 supplies to escape in 3 minutes. ${live.mode === 'solo' ? 'One life.' : 'Five lives each.'} Hidden test boxes never pay CHOG.`);
}
function handleLiveMessage(message) {
  const live = state.live;
  if (!live) return;
  if (message.type === 'error') {
    if (!live.code) {
      const text = message.message;
      if (/wallet link expired/i.test(text)) {
        state.rewardSession = null; state.rewardAccount = null; state.previewBalance = 0; renderPreviewWallet();
      }
      leaveRoom(); toast(text, true);
    } else toast(message.message, true);
    return;
  }
  if (message.type === 'room') {
    live.code = message.code; live.you = message.you; live.hostId = message.hostId;
    live.mode = message.mode || live.mode || 'pvp';
    live.campaign = message.rewardMode === 'campaign' && message.rewardPreviewOnly === false;
    $('buildButton').textContent = live.mode === 'solo' ? 'SOLO · SERVER' : `ROOM · ${live.code}`;
    $('buildButton').setAttribute('aria-label', `Open live room ${live.code}`);
    live.phase = message.phase; live.startsAt = message.startsAt; live.winnerId = message.winnerId; live.winnerName = message.winnerName;
    live.standings = message.standings;
    if (message.arena) {
      if (state.id !== message.arena.id) { state.verified = false; state.chogBalance = 0; }
      state.id = message.arena.id; state.arena = message.arena; live.arena = message.arena;
      if (game.mode !== 'online') game.setArena(message.arena);
      updateArenaLabels();
    }
    if (live.phase === 'playing') beginLiveRound();
    else if (live.phase === 'finished') { live.roundStarted = false; if (state.mode !== 'result') showRoomScreen(); }
    else showRoomScreen();
    renderRoom();
  } else if (message.type === 'start') beginLiveRound();
  else if (message.type === 'snapshot') {
    live.lastSnapshot = message; live.standings = message.standings;
    if (game.mode === 'online') game.applyOnlineSnapshot(message);
    renderStandings(); renderRespawn(message);
    if (!$('roomOverlay').hidden) renderRoom();
  } else if (message.type === 'event') feed(live.mode === 'solo' ? 'SOLO PIT' : 'LIVE PIT', message.text);
  else if (message.type === 'preview_reward') {
    live.rewardFound = (live.rewardFound || 0) + 1;
    if (Number.isFinite(message.amount)) live.previewAmount = (live.previewAmount || 0) + message.amount;
    updateResultPreview();
    if (message.status === 'preview-credit') {
      if (state.rewardAccount?.toLowerCase() === message.account?.toLowerCase()) {
        state.previewBalance = message.previewBalance; renderPreviewWallet();
      }
      feed('HIDDEN BOX · TEST', `+${message.amount} simulated CHOG · ${message.previewBalance} preview total · NOT claimable`);
      toast(`+${message.amount} simulated CHOG. No tokens awarded or withdrawable.`);
    } else if (message.status === 'sample-only') {
      feed('HIDDEN BOX · SAMPLE', `${message.amount} simulated CHOG · NOT claimable`);
      toast(`Found a ${message.amount} CHOG sample. It cannot become real CHOG.`);
    } else if (message.status === 'daily-limit') toast('Preview wallet test limit: five hidden boxes per UTC day. No points credited.', true);
    else if (message.status === 'pool-empty') toast('The simulated 1,000 CHOG preview pool is full. No points credited.', true);
    else toast('Hidden box opened, but no preview points were recorded.', true);
  } else if (message.type === 'claim_pending') {
    live.rewardFound = (live.rewardFound || 0) + 1;
    updateResultPreview();
    feed('BOX · PENDING', 'An opening record is not a CHOG award. The opening raider would need an address before batching and current real Raider Pass holder proof before any real payout.');
    toast('Opening recorded; not a CHOG award. This game preview cannot pay CHOG.');
  } else if (message.type === 'reward_linked') toast(live.campaign
    ? 'Email session refreshed for this account.' : 'Optional preview test link refreshed. No real CHOG.');
  else if (message.type === 'result') showResult(message.summary, { live: true, payout: message.payout });
  else if (message.type === 'round_end') {
    live.phase = 'finished'; live.winnerId = message.winnerId; live.winnerName = message.winnerName; live.standings = message.standings;
    renderStandings();
    if (state.mode === 'live') showRoomScreen();
  } else if (message.type === 'scar_saved') {
    toast(`Your ${message.mark.toUpperCase()} scar now marks this arena.`);
    if (message.arena && state.id === message.arena.id) {
      state.arena = { ...state.arena, ...message.arena }; updateArenaLabels();
    }
    if (state.mode === 'result') $('resultDescription').textContent = `Banked locally! Your scar is saved on this arena host for later raids.`;
  }
}
async function connectRoom(action) {
  if (document.body.dataset.offline === 'true') return toast('Server solo and private PvP/co-op need the hosted game. Solo practice works offline.', true);
  if (state.live || state.loading) return toast('Finish loading your arena or leave your current room first.', true);
  // A funded future campaign must require an account session BEFORE joining.
  // The current hosted server always returns ready:false; preview play is free.
  let campaignStatus = { ready: false };
  try { campaignStatus = await API('/api/campaign/status'); }
  catch { /* Old preview hosts do not have account routes: never infer real payouts. */ }
  const campaign = campaignStatus.ready === true && campaignStatus.claimsEnabled === true;
  const accountSession = campaign ? sessionStorage.getItem('chogpit_campaign_email_session') : null;
  if (campaign && !accountSession)
    return toast('A future funded campaign requires a verified email session before entering; this game is currently sample-only.', true);
  const code = $('joinCodeInput').value.trim().toUpperCase();
  if (action === 'join' && !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return toast('Enter the six-character invite code.', true);
  const name = $('liveName').value.trim().slice(0, 16) || 'RAIDER';
  storage.write('chogpit.raiderName', name);
  audio.unlock();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  state.live = { ws, code: '', mode: action === 'solo' ? 'solo' : 'pvp', phase: 'connecting',
    arena: null, standings: [], roundStarted: false, resultShown: false, rewardFound: 0, previewAmount: 0 };
  showRoomScreen();
  const session = campaign ? accountSession : null;
  const hero = currentHero();
  ws.onopen = () => ws.send(JSON.stringify(action === 'join'
    ? { type: 'join', name, code, session, hero: hero ? { name: hero.name, color: hero.bgColor, weapon: hero.weapon, tokenId: hero.tokenId } : null }
    : { type: action === 'solo' ? 'solo' : 'create', name, arenaId: state.id, session, hero: hero ? { name: hero.name, color: hero.bgColor, weapon: hero.weapon, tokenId: hero.tokenId } : null }));
  ws.onmessage = event => {
    try { handleLiveMessage(JSON.parse(event.data)); }
    catch (error) { console.error('Live room message:', error); toast('A room update could not be read.', true); }
  };
  ws.onclose = () => {
    if (state.live?.ws !== ws) return;
    state.live = null; showLobby();
    toast('Connection lost. Rejoin with the invite code if the room is still waiting.', true);
  };
}

let lastLiveShotSound = 0;
const game = new PitGame($('gameCanvas'), {
  onStatus,
  onFinish: showResult,
  onFeed: feed,
  onOnlineInput: input => {
    if (!state.live || state.live.phase !== 'playing') return;
    if (game.orientationBlocked || !$('roomOverlay').hidden || !$('resultOverlay').hidden) input = { dx: 0, dy: 0, aim: input.aim, fire: false, interact: false, dash: false, reload: false };
    sendLive({ type: 'input', ...input });
    if (input.fire && performance.now() - lastLiveShotSound > 190) { lastLiveShotSound = performance.now(); audio.shoot(); }
  },
  onRoomMenu: showRoomScreen,
  onBuildChanged: traps => { $('trapCount').textContent = `${traps.length} / 8 PLACED`; if (state.mode === 'build' && (state.id === 'demo' || state.verified)) $('builderNote').textContent = `${traps.length}/8 traps placed · click a trap to remove it · save when ready.`; },
  onBuildError: text => toast(text, true),
  canUsePulse: () => state.id === 'demo' || (state.verified && state.chogBalance >= 100),
  onCacheOpen: () => audio.cache(), onLoot: () => audio.pickup(), onPickup: () => audio.pickup(),
  onShoot: () => audio.shoot(), onDash: () => audio.dash(), onHurt: () => audio.hurt(),
  onPause: paused => pauseRun(paused)
});

$('homeButton').addEventListener('click', showLobby);
$('playButton').addEventListener('click', () => {
  if (state.loading) return toast('Finish loading your pit first.', true);
  // The NFT primary action always enters an authoritative raid. The local
  // bot run is a tutorial, never a path to token-linked scars or raid records.
  if (state.id === 'demo') startRun(); else connectRoom('solo');
});
$('retryButton').addEventListener('click', () => state.live ? showRoomScreen() : startRun());
$('resultButton').addEventListener('click', claimRun);
$('resultMenuButton').addEventListener('click', showLobby);
$('pauseButton').addEventListener('click', () => state.live ? showRoomScreen() : pauseRun(game.mode !== 'paused'));
$('resumeButton').addEventListener('click', () => pauseRun(false));
$('pauseMenuButton').addEventListener('click', showLobby);
$('createRoomButton').addEventListener('click', () => connectRoom('create'));
$('soloBountyButton').addEventListener('click', () => connectRoom('solo'));
$('refreshClaimStatus').addEventListener('click', refreshClaimStatus);
const savedHero = storage.read('chogpit.heroId', null); // local hero pick doubles as preview payout hint until Privy register overwrites
function updatePayoutNote(){
  const a = storage.read('chogpit.privyPayoutAddress', null) || storage.read('chogpit.holderWallet', null);
  if(a) $('privyPayoutAddr').textContent = `Payout Privy wallet: ${shortAddress(a)} (sponsor pays gas to this address, holder check at payout)`;
  else $('privyPayoutAddr').textContent = 'Not registered yet — register with email first. No extra wallet needed.';
}
updatePayoutNote();
$('copySponsor').addEventListener('click', async () => { try{ await navigator.clipboard.writeText($('sponsorAddr').textContent.trim()); toast('Sponsor gas address copied'); } catch{ toast($('sponsorAddr').textContent.trim()); } });
$('copyVault').addEventListener('click', async () => { const v=$('vaultAddr').textContent.trim(); if(v.includes('NOT DEPLOYED')) return toast('Vault not deployed yet — holder-aware draft only.', true); try{ await navigator.clipboard.writeText(v); toast('Vault address copied'); } catch{ toast(v); } });
$('passJumpButton').addEventListener('click', () => {
  $('passPreviewButton').scrollIntoView({ block: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  $('passPreviewButton').focus({ preventScroll: true });
});
$('passPreviewButton').addEventListener('click', () => {
  if (!state.samplePass) {
    state.samplePass = true;
    storage.write('chogpit.sampleRaiderPass', true);
    renderSamplePass();
  }
  toast('Sample pass shown in this browser. It is NOT an NFT or a CHOG claim. Raid a minted Chog pit next!');
});
$('joinRoomButton').addEventListener('click', () => connectRoom('join'));
$('joinCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') connectRoom('join'); });
$('roomStartButton').addEventListener('click', () => sendLive({ type: 'start' }));
for (const button of document.querySelectorAll('[data-room-mode]')) button.addEventListener('click', () => {
  if (!button.disabled) sendLive({ type: 'set_mode', mode: button.dataset.roomMode });
});
$('roomResumeButton').addEventListener('click', resumeLivePit);
$('respawnRoomButton').addEventListener('click', showRoomScreen);
$('roomLeaveButton').addEventListener('click', leaveRoom);
setInterval(() => { if (state.live?.phase === 'countdown' && !$('roomOverlay').hidden) renderRoom(); }, 500);
$('copyRoomLink').addEventListener('click', async () => {
  if (!state.live?.code) return;
  const url = new URL(location.href); url.searchParams.set('room', state.live.code);
  if (state.live.arena?.id !== 'demo') url.searchParams.set('pit', state.live.arena?.id || state.id);
  else url.searchParams.delete('pit');
  try { await navigator.clipboard.writeText(url.toString()); toast(`Invite link copied · ${state.live.code}`); }
  catch { toast(`Invite code: ${state.live.code} · share this page URL with a friend.`); }
});
$('loadArenaButton').addEventListener('click', () => loadArena($('arenaInput').value));
$('arenaInput').addEventListener('keydown', e => { if (e.key === 'Enter') loadArena(e.target.value); });
for (const button of document.querySelectorAll('[data-featured-pit]'))
  button.addEventListener('click', () => loadArena(button.dataset.featuredPit));
$('sharePitButton').addEventListener('click', async () => {
  if (state.id === 'demo' || document.body.dataset.offline === 'true') return;
  const url = new URL(location.href); url.searchParams.delete('room'); url.searchParams.set('pit', state.id);
  try { await navigator.clipboard.writeText(url.toString()); toast(`CHOG NFT #${state.id} pit link copied!`); }
  catch { toast(`Share this pit: ${url}`); }
});
$('demoButton').addEventListener('click', () => loadArena('demo'));
if($('walletButton')) $('walletButton').addEventListener('click', connectWallet);
if($('verifyButton')) $('verifyButton').addEventListener('click', verifyOwner);
if($('buildButton')) $('buildButton').addEventListener('click', () => state.live ? showRoomScreen() : openBuilder());
if($('closeBuilder')) $('closeBuilder').addEventListener('click', closePanel);
if($('lockerButton')) $('lockerButton').addEventListener('click', openLocker);
if($('closeLocker')) $('closeLocker').addEventListener('click', closePanel);
if($('panelScrim')) $('panelScrim').addEventListener('click', closePanel);
if($('saveArenaButton')) $('saveArenaButton').addEventListener('click', saveArena);
if($('undoTrapButton')) $('undoTrapButton').addEventListener('click', () => game.undoTrap());
if($('openCrateButton')) $('openCrateButton').addEventListener('click', openCrate);
if($('closeCrateModal')) $('closeCrateModal').addEventListener('click', () => { $('crateModal').hidden = true; });
if($('claimRewardButton')) $('claimRewardButton').addEventListener('click', () => { $('crateModal').hidden = true; closePanel(); });
if($('crateModal')) $('crateModal').addEventListener('click', e => { if (e.target === $('crateModal')) $('crateModal').hidden = true; });
if($('cycleModButton')) $('cycleModButton').addEventListener('click', () => { const mods = [...new Set(state.collection)]; if (!mods.length) return; state.equipped = mods[(mods.indexOf(state.equipped) + 1) % mods.length]; updateLocker(); toast(`${state.equipped} equipped.`); });
// --- moved early to avoid hoist error in showRoomScreen ---
var firePointerId = null;
var shootButton = null;
function stopFiring(event){
  try{ if (event?.pointerId !== undefined && firePointerId !== event.pointerId) return;
  firePointerId = null; if(game && game.setFiring) game.setFiring(false); if(shootButton) shootButton.classList.remove('active'); }catch{}
};
shootButton = $('shootButton');
if(shootButton){
shootButton.addEventListener('pointerdown', e => {
  if (firePointerId !== null || !['play', 'online'].includes(game.mode)) return;
  e.preventDefault(); e.stopPropagation(); audio.unlock();
  firePointerId = e.pointerId; shootButton.setPointerCapture(e.pointerId);
  shootButton.classList.add('active'); game.setFiring(true, e.pointerType === 'touch');
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) shootButton.addEventListener(event, stopFiring);
window.addEventListener('blur', stopFiring);
}
if($('touchDash')) $('touchDash').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); game.dash(); });
const interactButton = $('interactPrompt');
interactButton.addEventListener('pointerdown', e => {
  if (!['play', 'online'].includes(game.mode) || interactButton.disabled || interactPointerId !== null) return;
  e.preventDefault(); e.stopPropagation();
  interactPointerId = e.pointerId; interactButton.setPointerCapture(e.pointerId);
  interactButton.classList.add('active'); game.keys.add('e'); game.interact();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) interactButton.addEventListener(event, e => releaseInteract(e.pointerId));
let keyboardInteract = false;
interactButton.addEventListener('keydown', e => {
  if (![' ', 'Enter'].includes(e.key) || interactButton.disabled) return;
  e.preventDefault(); e.stopPropagation();
  if (!keyboardInteract) { keyboardInteract = true; game.keys.add('e'); game.interact(); }
});
window.addEventListener('keyup', e => {
  if (keyboardInteract && [' ', 'Enter'].includes(e.key)) { keyboardInteract = false; game.keys.delete('e'); }
});
window.addEventListener('blur', () => { keyboardInteract = false; releaseInteract(); });

// Mobile browsers cannot reliably force screen rotation. Keep portrait menus
// usable, but gate active phone play with a rotate prompt. Practice freezes;
// the server-run room does not pause for other raiders, so input goes neutral.
const portraitPhone = matchMedia('(pointer:coarse) and (orientation:portrait) and (max-width:700px)');
function syncOrientationGate() {
  const overlay = $('rotateOverlay');
  const playing = ['play', 'online'].includes(game.mode) && !$('gameHud').hidden
    && $('lobbyOverlay').hidden && $('roomOverlay').hidden && $('resultOverlay').hidden
    && $('pauseOverlay').hidden && $('builderPanel').hidden && $('lockerPanel').hidden
    && $('crateModal').hidden;
  const blocked = portraitPhone.matches && playing;
  const entering = blocked && overlay.hidden;
  if (entering) { stopFiring(); releaseInteract(); keyboardInteract = false; }
  game.setOrientationBlocked(blocked);
  if (overlay.hidden !== !blocked) overlay.hidden = !blocked;
  if (entering) {
    $('rotateMatchNote').textContent = state.live
      ? 'LIVE ROOM CONTINUES · YOUR CONTROLS ARE HELD STILL'
      : 'SOLO PRACTICE PAUSES WHILE YOU ROTATE';
    $('rotateMenuButton').innerHTML = state.live ? 'OPEN LIVE ROOM <span>↗</span>' : 'BACK TO MENU <span>↗</span>';
    $('rotateMenuButton').focus({ preventScroll: true });
  } else if (!blocked && document.activeElement === $('rotateMenuButton')) $('rotateMenuButton').blur();
}
$('rotateMenuButton').addEventListener('click', () => state.live ? showRoomScreen() : showLobby());
const gateObserver = new MutationObserver(syncOrientationGate);
for (const id of ['gameHud', 'lobbyOverlay', 'roomOverlay', 'resultOverlay', 'pauseOverlay', 'builderPanel', 'lockerPanel', 'crateModal'])
  gateObserver.observe($(id), { attributes: true, attributeFilter: ['hidden'] });
if (portraitPhone.addEventListener) portraitPhone.addEventListener('change', syncOrientationGate);
else portraitPhone.addListener(syncOrientationGate);
window.addEventListener('resize', syncOrientationGate);
window.addEventListener('orientationchange', syncOrientationGate);
syncOrientationGate();

$('soundButton').addEventListener('click', () => { const enabled = audio.toggle(); $('soundButton').textContent = enabled ? '♫ ON' : '♫ OFF'; $('soundButton').setAttribute('aria-pressed', String(enabled)); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('crateModal').hidden) $('crateModal').hidden = true; else if (state.panel) closePanel(); else if (state.live?.phase === 'playing') { if ($('roomOverlay').hidden) showRoomScreen(); else resumeLivePit(); } } });
document.querySelectorAll('[data-trap]').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('[data-trap]').forEach(b => b.classList.toggle('selected', b === button)); game.setSelectedTrap(button.dataset.trap); toast(button.dataset.trap === 'pulse' ? 'Pulse Coil is a 100 $CHOG holder perk in real NFT arenas.' : `${button.querySelector('span').firstChild.textContent} selected. Click open terrain.`); }));
document.querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', () => { state.mark = button.dataset.mark; document.querySelectorAll('[data-mark]').forEach(b => b.classList.toggle('selected', b === button)); }));
if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', accounts => {
    const next = accounts?.[0] || null;
    if (state.wallet && next?.toLowerCase() !== state.wallet.toLowerCase()) {
      state.rewardSession = null; state.rewardAccount = null; state.previewBalance = 0;
      if (state.live && !state.live.campaign) leaveRoom(); // NFT wallet changes never change a separate prize account.
    }
    state.wallet = next; state.verified = false; state.chogBalance = 0;
    $('walletLabel').textContent = state.wallet ? shortAddress(state.wallet) : 'NFT OWNER TOOLS';
    updateArenaLabels(); renderPreviewWallet();
  });
  window.ethereum.on('chainChanged', () => { state.verified = false; state.chogBalance = 0; updateArenaLabels(); });
}
$('shootHint').textContent = matchMedia('(pointer:coarse)').matches ? 'TAP FIRE · HOLD TO SHOOT' : 'LEFT CLICK / F · SHOOT';
$('liveName').value = storage.read('chogpit.raiderName', `RAIDER-${10 + Math.floor(Math.random() * 90)}`);
if (document.body.dataset.offline === 'true') { $('liveEntry').hidden = true; $('offlineLiveNotice').hidden = false; }
else {
  API('/api/status').then(status => {
    if (status.gameOnly !== true) return;
    document.body.dataset.gameOnly = 'true';
    $('gameModeLabel').textContent = 'FREE LIVE GAME · NO CHOG PAYOUTS';
    renderPreviewWallet();
  }).catch(() => { /* A status fetch cannot enable rewards. */ });
  const invite = new URL(location.href).searchParams.get('room')?.toUpperCase();
  if (invite && /^[A-HJ-NP-Z2-9]{6}$/.test(invite)) { $('joinCodeInput').value = invite; $('liveEntry').open = true; }
}
updateLocker(); updateCareer(); updateArenaLabels(); renderPreviewWallet(); renderSamplePass(); renderHeroes(); applyHero();
// Pit links can be sent to anyone; they select a minted token without a wallet.
// Loading still requires a live ownerOf check. The demo is only the fallback.
const linkedPit = document.body.dataset.offline === 'true' ? null : new URL(location.href).searchParams.get('pit');
loadArena(linkedPit && /^[1-9]\d{0,6}$/.test(linkedPit) ? linkedPit : 'demo', true);
