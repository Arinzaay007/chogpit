const NAMES=[["Aqua Sentinel","Aqua Depths","Peashooter"],["Lime Striker","Lime Grid","Burst Rifle"],["Sky Drifter","Sky Blue","Shotgun"],["Crimson Raider","Red Sky","Laser"],["Lemon Spark","Lemon Yellow","Plasma"],["Violet Phantom","Light Purple","Peashooter"],["Void Walker","Void Black","Burst Rifle"],["Monad Prime","Monad Purple","Shotgun"],["Ember Maw","Red Sky","Laser"],["Frost Fang","Sky Blue","Plasma"],["Jade Warden","Lime Grid","Peashooter"],["Neon Pulse","Lemon Yellow","Burst Rifle"],["Obsidian Claw","Void Black","Shotgun"],["Solar Flare","Lemon Yellow","Laser"],["Abyss Seer","Aqua Depths","Plasma"],["Gilded Jaws","Lemon Yellow","Peashooter"],["Terra Titan","Lime Grid","Burst Rifle"],["Storm Howler","Sky Blue","Shotgun"],["Inferno Core","Red Sky","Laser"],["Crystal Veil","Light Purple","Plasma"],["Shadow Lancer","Void Black","Peashooter"],["Nova Burn","Red Sky","Burst Rifle"],["Tide Breaker","Aqua Depths","Shotgun"],["Iron Hull","Void Black","Laser"],["Prism Edge","Light Purple","Plasma"],["Blitz Fang","Lime Grid","Peashooter"],["Thunder Maw","Sky Blue","Burst Rifle"],["Dune Stalker","Lemon Yellow","Shotgun"],["Frost Giant","Sky Blue","Laser"],["Magma Heart","Red Sky","Plasma"],["Specter Eye","Void Black","Peashooter"],["Pulse Runner","Monad Purple","Burst Rifle"],["Sun Shepherd","Lemon Yellow","Shotgun"],["Night Razor","Void Black","Laser"],["Aqua Monarch","Aqua Depths","Plasma"],["Banana Bandit","Lemon Yellow","Peashooter"],["Gangster Chog","Void Black","Burst Rifle"],["Pixel Marauder","Lime Grid","Shotgun"],["Chromatic Ghost","Light Purple","Laser"],["Monad Genesis","Monad Purple","Plasma"]];
const POSES=["/assets/chog-pose1.png","/assets/chog-pose2.png","/assets/chog-pose3.png","/assets/chog-pose4.png","/assets/chog1.jpg","/assets/chog-pose1.png","/assets/chog-pose2.png","/assets/chog-pose3.png"]; const COLORS=["#0ea5a0","#a3e635","#38bdf8","#f43f5e","#facc15","#c084fc","#111827","#6d28d9"];
const TRAITS=["Aqua","Lime","Sky","Crimson","Lemon","Violet","Void","Monad"];
function hero(i){ const n=NAMES[i%40]; return { id:i+1, name:n[0], bg:n[1], wep:n[2], color:COLORS[i%8], trait:TRAITS[i%8], speed:(3.8+(i%5)*0.3).toFixed(1), body:["Bulky","Slim","Armored","Spiked"][i%4], eyes:["Laser","Void","Neon","Pixel"][i%4], aura:["Fire","Ice","Storm","Void"][i%4]}; }
const grid=document.getElementById('grid'); let sel=null;
let claimedSet=new Set();
// Load claimed list (any wallet) → mark CLAIMED, not clickable
fetch('/api/pass/claims').then(r=>r.json()).then(j=>{
  claimedSet=new Set(j.claimedIds||[]);
  renderGrid();
}).catch(()=>renderGrid());

function renderGrid(){
  grid.innerHTML='';
  for(let i=0;i<40;i++){
    const h=hero(i); const pose=POSES[i%POSES.length]; const isClaimed=claimedSet.has(h.id);
    const el=document.createElement('div'); el.className='card'+(isClaimed?' claimed':'');
    el.style.opacity=isClaimed?'0.45':''; el.style.pointerEvents=isClaimed?'none':'';
    el.innerHTML=`<div class="art"><img src="${pose}" alt=""><div class="tint" style="background:${h.color}"></div><span class="badge">${h.trait}</span><span class="num">#${String(h.id).padStart(2,'0')}/40</span>${isClaimed?'<span style="position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,0.7);color:#a3e635;border:2px solid #a3e635;font:1000 12px system-ui">CLAIMED</span>':''}<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);color:white;padding:4px 6px;font:700 7px system-ui;display:flex;justify-content:space-between"><span>${h.body}</span><span>♥ ${h.speed}spd</span></div></div><div class="meta"><b>${h.name}</b><br><small>${h.bg} · ${h.eyes} eyes · ${h.aura} aura</small><br><small>⚔ ${h.wep}</small></div>`;
    if(!isClaimed){
      el.onclick=()=>{
        document.querySelectorAll('.card').forEach(x=>x.classList.remove('selected')); el.classList.add('selected'); sel=h;
        document.getElementById('claimBtn').disabled=false; document.getElementById('claimBtn').textContent=`CLAIM ${h.name.toUpperCase()} #${h.id} → ENTER PIT`;
        document.getElementById('status').textContent=`Selected: ${h.name} — ${h.bg} / ${h.body} / ${h.eyes} / ${h.aura} → ${h.wep} · ${h.speed}spd`;
      };
    }
    grid.appendChild(el);
  }
}

document.getElementById('claimBtn').onclick=async()=>{
  if(!sel) return;
  const wallet = localStorage.getItem('chogpit.wallet');
  if(!wallet){ alert('Connect wallet first'); location.href='/'; return; }
  const btn=document.getElementById('claimBtn'); btn.textContent='MINTING TO '+wallet.slice(0,6)+'... →'; btn.disabled=true;
  document.getElementById('status').textContent='Signing free claim (sponsor pays gas)…';
  try{
    const existing=localStorage.getItem('chogpit.claimToken:'+wallet.toLowerCase());
    if(existing){ const data={...sel, id:Number(existing), wallet, claimedAt:new Date().toISOString(), onChain:true}; localStorage.setItem('chogpit.hero', JSON.stringify(data)); localStorage.setItem('chogpit.heroId', String(data.id)); localStorage.setItem('chogpit.passHolder','1'); localStorage.setItem('chogpit.credit','0'); btn.textContent='ALREADY CLAIMED #'+data.id+' → ENTERING PIT…'; setTimeout(()=> location.href='/game.html', 600); return; }
    const r=await fetch('/api/pass/claim',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({wallet, heroId: sel.id})});
    const j=await r.json();
    if(!r.ok) throw Error(j.error || 'Claim failed');
    const tokenId=j.tokenId || sel.id;
    const data={...sel, id: tokenId, wallet, claimedAt:new Date().toISOString(), onChain: j.onChain ?? false, txHash: j.txHash || null};
    localStorage.setItem('chogpit.hero', JSON.stringify(data)); localStorage.setItem('chogpit.heroId', String(tokenId)); localStorage.setItem('chogpit.claimToken:'+wallet.toLowerCase(), String(tokenId)); localStorage.setItem('chogpit.passHolder','1'); localStorage.setItem('chogpit.credit','0');
    document.getElementById('status').textContent = j.onChain ? `Minted CHOG #${tokenId} to ${wallet.slice(0,6)}... — entering pit` : `Reserved CHOG #${tokenId} for ${wallet.slice(0,6)}... (sponsor will mint) — entering pit`;
    btn.textContent='CLAIMED #'+tokenId+' ✓ ENTERING PIT…';
    setTimeout(()=> location.href='/game.html', 700);
  }catch(e){ btn.disabled=false; btn.textContent=`CLAIM ${sel.name.toUpperCase()} #${sel.id} → ENTER PIT`; document.getElementById('status').textContent=e.message; alert(e.message); }
};
