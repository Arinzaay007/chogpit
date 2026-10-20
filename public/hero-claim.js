import { createRoot } from 'react-dom/client';
import React, { useEffect, useState } from 'react';
import { PrivyProvider, getIdentityToken, useLogin, usePrivy, useUser, useWallets } from '@privy-io/react-auth';
import { monad } from 'viem/chains';
const HEROES=["Aqua Depths","Lime Grid","Sky Blue","Red Sky","Lemon Yellow","Light Purple","Monad Purple","Void Black"];
function pickHero(seed){ return { background: HEROES[seed%8], color: ["#0ea5a0","#a3e635","#38bdf8","#f43f5e","#facc15","#c084fc","#6d28d9","#111827"][seed%8], name: `HERO #${seed%500}` } }
export function mountPrivyClaim(cfg){
  const root=document.getElementById('signup-mount'); if(!root) return;
  function App(){
    const {ready, authenticated, user, logout}=usePrivy(); const {ready:wReady,wallets}=useWallets(); const {refreshUser}=useUser();
    const [email,setEmail]=useState(''); const [req,setReq]=useState(null); const [hero,setHero]=useState(JSON.parse(localStorage.getItem('chogpit.hero')||'null'));
    const embedded=wallets.filter(w=>w.walletClientType==='privy'); const {login}=useLogin({onError:e=>setReq(null)});
    useEffect(()=>{ if(!req||!authenticated||!ready||!wReady) return; if(embedded.length!==1){ document.getElementById('heroMeta').textContent='Setting up your Privy wallet...'; return; }
      (async()=>{
        try{ await refreshUser(); const tok=await getIdentityToken(); if(!tok) throw Error('Enable identity token in Privy dashboard');
          const r=await fetch('/api/pass-portal/register',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${tok}`},body:JSON.stringify({emailHint:req, address:embedded[0].address})});
          const j=await r.json(); if(!r.ok) throw Error(j.error); const h=j.hero||pickHero(Date.now()); localStorage.setItem('chogpit.hero', JSON.stringify({...h, wallet: j.address})); localStorage.setItem('chogpit.privyPayoutAddress', j.address); setHero(h); document.getElementById('heroPreview').textContent=h.body||h.background; document.getElementById('heroPreview').style.background=h.color; document.getElementById('heroMeta').textContent=`HERO: ${h.body} / ${h.eyes} / ${h.aura} → ${j.address.slice(0,6)}...`; document.getElementById('claimBtn').disabled=true; document.getElementById('playBtn').style.display='block'; }catch(e){ document.getElementById('heroMeta').textContent=e.message; } finally{ setReq(null); }
      })();
    },[req,authenticated,ready,wReady,embedded.length]);
    function submit(e){ e.preventDefault(); const hint=email.trim().toLowerCase(); if(!hint) return; setReq(hint); if(!authenticated) login({loginMethods:['email'], prefill:{type:'email',value:hint}, walletChainType:'ethereum-only'}); }
    // local claim fallback (no Privy) for hackathon speed
    function localClaim(){ const h=pickHero(Math.floor(Math.random()*500)); const fake='0x'+Array.from({length:40},()=>Math.floor(Math.random()*16).toString(16)).join(''); localStorage.setItem('chogpit.hero', JSON.stringify({...h,wallet:fake})); setHero(h); document.getElementById('heroPreview').textContent=h.background; document.getElementById('heroPreview').style.background=h.color; document.getElementById('heroMeta').textContent=`LOCAL HERO (preview): ${h.background} → ${fake.slice(0,6)}...`; document.getElementById('playBtn').style.display='block'; }
    useEffect(()=>{ document.getElementById('claimBtn').onclick=localClaim; document.getElementById('playBtn').onclick=()=>location.href='/'; document.getElementById('goRaid')&&(document.getElementById('goRaid').onclick=()=>location.href='/#raid'); document.getElementById('goFriends')&&(document.getElementById('goFriends').onclick=()=>location.href='/#friends'); if(hero){ document.getElementById('heroPreview').textContent=hero.background||hero.body; document.getElementById('heroPreview').style.background=hero.color; document.getElementById('playBtn').style.display='block'; } },[]);
    return React.createElement('form',{onSubmit:submit, style:{display:'flex',gap:'6px',marginTop:'10px'}}, React.createElement('input',{type:'email', placeholder:'you@example.com', value:email, onChange:e=>setEmail(e.target.value), required:true, style:{flex:1,height:'38px',padding:'0 10px',border:'2px solid var(--ink)',borderRadius:'8px'}}), React.createElement('button',{type:'submit', style:{height:'38px',padding:'0 12px',background:'var(--yellow)',border:'2px solid var(--ink)',borderRadius:'8px',font:'900 9px var(--mono)' }}, req?'WAIT...':'REGISTER →'));
  }
  if(!cfg.publicAppId){ createRoot(root).render(React.createElement('div',{},'Portal not configured — use local CLAIM button below.')); return; }
  createRoot(root).render(React.createElement(PrivyProvider,{appId:cfg.publicAppId, config:{loginMethods:['email'], embeddedWallets:{ethereum:{createOnLogin:'users-without-wallets'}}, defaultChain:monad, supportedChains:[monad]}}, React.createElement(App)));
}
