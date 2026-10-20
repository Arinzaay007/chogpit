"""Bundle the current solo shooter into a self-contained, network-free HTML file.

The bundle uses an in-memory demo-arena API. Wallets, NFT owner checks, and
shared server-side persistence exist only in the Node application.
"""
from pathlib import Path
import base64

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUTPUT = ROOT.parent / "CHOGPIT_Playable_Demo.html"

html = (PUBLIC / "index.html").read_text()
css = (PUBLIC / "style.css").read_text()
world = (PUBLIC / "arena-world.js").read_text()
game = (PUBLIC / "game.js").read_text()
audio = (PUBLIC / "audio.js").read_text()
app = (PUBLIC / "app.js").read_text()

badge = "data:image/jpeg;base64," + base64.b64encode((PUBLIC / "assets/chogbadge.jpg").read_bytes()).decode("ascii")
html = html.replace('<link rel="icon" type="image/jpeg" href="/assets/chogbadge.jpg" />', f'<link rel="icon" type="image/jpeg" href="{badge}" />')
html = html.replace('<link rel="stylesheet" href="/style.css" />', "<style>\n" + css + "\n</style>")
html = html.replace('src="/assets/chogbadge.jpg"', f'src="{badge}"')
html = html.replace('<body>', '<body data-offline="true">')
html = html.replace('FREE PLAYTEST <i>', 'OFFLINE PLAYTEST <i>')
html = html.replace('<title>CHOGPIT — Build. Raid. Scar. Rebuild.</title>', '<title>CHOGPIT — Offline training pit</title>')
html = html.replace('CHOGATHON / LIVING NFT ARENAS', 'OFFLINE TRAINING / HOSTED NFT GAME')
html = html.replace('These public examples were minted when checked. Opening one rechecks its on-chain owner; they are not owned or endorsed by CHOGPIT.',
                    'Offline tutorial only. Open the hosted game to select a minted Chog NFT, verify its on-chain owner and raid its living arena.')
html = html.replace('TRAINING PIT · CHOOSE A MINTED NFT TO RAID', 'OFFLINE TRAINING · MINTED NFT PITS REQUIRE THE HOSTED APP')
html = html.replace('Demo edits use the playtest server. No real tokens are spent.', 'Offline edits last for this file session. No tokens are spent.')
html = html.replace('id="walletButton" type="button"', 'id="walletButton" type="button" disabled')
html = html.replace('id="walletLabel">NFT OWNER TOOLS', 'id="walletLabel">LIVE APP ONLY')
html = html.replace('<a class="claim-portal-link" href="/claim.html">READ FUTURE REWARD PROPOSAL ↗</a>',
                    '<span class="claim-portal-link">NO REAL CHOG PAYOUTS IN THIS OFFLINE TUTORIAL</span>')
html = html.replace('id="arenaInput" type="text"', 'id="arenaInput" type="text" disabled')
html = html.replace('id="loadArenaButton" type="button"', 'id="loadArenaButton" type="button" disabled')
html = html.replace('id="verifyButton" class="verify-button" type="button"', 'id="verifyButton" class="verify-button" type="button" disabled')

# Convert the ES modules into one ordered inline script. No runtime CDN.
world = world.replace('export const ', 'const ').replace('export function ', 'function ')
game = game.replace("import { WORLD_W, WORLD_H, clamp, hash, circleRect, BOT_STARTS, LIVE_SPAWNS, buildArenaWorld } from './arena-world.js';", '')
game = game.replace('export class PitGame', 'class PitGame').replace('export { formatClock, WEAPONS, REQUIRED_SUPPLIES, payoutForRun };', '')
audio = audio.replace('export class AudioFX', 'class AudioFX')
app = app.replace("import { PitGame, formatClock, WEAPONS, REQUIRED_SUPPLIES, payoutForRun } from './game.js';", '')
app = app.replace("import { AudioFX } from './audio.js';", '')
app = app.replace("'/assets/chogbadge.jpg'", 'OFFLINE_BADGE')

shim = r'''
const OFFLINE_BADGE = __BADGE__;
(() => {
  let arena = { id: 'demo', genome: 'demo-training', traitLabel: 'TRAINING PIT', imageUrl: null,
    traps: [{type:'turret',x:1888,y:992},{type:'mine',x:2400,y:1248},{type:'slime',x:1632,y:1440}],
    raids: 0, clears: 0, scars: [], lastRun: null, recentRuns: [] };
  const spots = [{x:1450,y:1300},{x:2180,y:1050},{x:1120,y:1480},{x:1910,y:740},{x:2570,y:1690},{x:810,y:1260}];
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {'content-type':'application/json'} });
  window.fetch = async (input, options = {}) => {
    const url = String(input), method = (options.method || 'GET').toUpperCase();
    if (url === '/api/arena/demo' && method === 'GET') return reply(arena);
    if (url === '/api/arena/demo/traps' && method === 'POST') {
      const body = JSON.parse(options.body || '{}'), seen = new Set();
      if (!Array.isArray(body.traps) || body.traps.length > 8 || body.traps.some(t => {
        const key = `${t.x}:${t.y}`;
        if (!['turret','mine','slime','pulse'].includes(t.type) || !Number.isInteger(t.x) || !Number.isInteger(t.y) || t.x < 160 || t.x > 3040 || t.y < 160 || t.y > 2080 || t.x % 64 !== 32 || t.y % 64 !== 32 || seen.has(key)) return true;
        seen.add(key); return false;
      })) return reply({error:'Invalid trap layout. Maximum 8 traps on the builder grid.'}, 400);
      arena = {...arena, traps:body.traps.map(t=>({type:t.type,x:t.x,y:t.y}))};
      return reply(arena);
    }
    if (url === '/api/arena/demo/raid' && method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      arena.raids++;
      if (body.won && body.loot >= 2) {
        arena.clears++;
        if (['acid','static','spores'].includes(body.mark)) {
          const point = spots[(arena.clears - 1) % spots.length];
          arena.scars = [...arena.scars.slice(-4), {type:body.mark, ...point}];
        }
      }
      const escaped = body.won === true && body.loot >= 2;
      const tier = !escaped ? 'lost' : body.loot >= 6 && body.kills >= 2 ? 'legend' : body.loot >= 4 || body.kills >= 2 ? 'heist' : 'safe';
      const score = escaped ? body.loot * 150 + body.kills * 100 + Math.round(body.timeLeft || 0) : 0;
      arena.lastRun = {won:escaped,loot:body.loot||0,kills:body.kills||0,tier,score,timeLeft:body.timeLeft||0,
        mode:'solo-unverified',at:new Date().toISOString()};
      arena.recentRuns = [arena.lastRun, ...arena.recentRuns.slice(0, 4)];
      return reply(arena);
    }
    return reply({error:'NFT wallet and $CHOG features require the live Node app. This file is an offline solo demo.'}, 503);
  };
})();
'''.replace('__BADGE__', repr(badge))

script = '<script>\n' + shim + '\n' + world + '\n' + game + '\n' + audio + '\n' + app + '\n</script>'
html = html.replace('<script type="module" src="/app.js"></script>', script)
if 'src="/assets/' in html or 'href="/assets/' in html or '<script type="module"' in html or 'src="/app.js"' in html:
    raise RuntimeError('External app assets remain in offline bundle')
OUTPUT.write_text(html)
print(f'Wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)')
