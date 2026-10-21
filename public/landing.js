import { createRoot } from 'react-dom/client';
import React, { useEffect, useState } from 'react';
import { PrivyProvider, getIdentityToken, useLogin, usePrivy, useWallets, useUser } from '@privy-io/react-auth';
import { monad } from 'viem/chains';
export function mountLanding(cfg){
  const root=document.getElementById('authMount'); if(!root) return;
  function App(){
    const {ready, authenticated, user, logout}=usePrivy(); const {ready:wR,wallets}=useWallets(); const {refreshUser}=useUser();
    const [email,setEmail]=useState(localStorage.getItem('chogpit.email')||''); const [busy,setBusy]=useState(null);
    const embedded=wallets.filter(w=>w.walletClientType==='privy'); const {login}=useLogin({onError:()=>setBusy(null)});
    useEffect(()=>{ if(ready&&authenticated&&wR&&embedded.length===1){ localStorage.setItem('chogpit.privyPayoutAddress', embedded[0].address); } },[ready,authenticated,wR,embedded.length]);
    async function submit(e){ e.preventDefault(); const hint=email.trim().toLowerCase(); if(!hint) return; localStorage.setItem('chogpit.email', hint); localStorage.setItem('chogpit.signedUpAt', new Date().toISOString()); setBusy(hint); if(!authenticated) login({loginMethods:['email'], prefill:{type:'email', value:hint}, walletChainType:'ethereum-only'}); }
    useEffect(()=>{ if(!busy||!authenticated||!ready||!wR) return; if(embedded.length!==1) return;
      (async()=>{ try{ await refreshUser(); const tok=await getIdentityToken(); if(!tok) throw Error('Enable identity token in Privy dashboard');
        const r=await fetch('/api/pass-portal/register',{method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${tok}`}, body:JSON.stringify({emailHint: busy, address: embedded[0].address})});
        const j=await r.json(); if(!r.ok) throw Error(j.error); location.href='/choose.html'; } catch(e){ alert(e.message); setBusy(null);} })();
    },[busy,authenticated,ready,wR,embedded.length]);
    function guest(){ localStorage.setItem('chogpit.guest','1'); location.href='/choose.html?guest=1'; }
    return React.createElement('div',{}, React.createElement('form',{onSubmit:submit, style:{display:'flex',gap:'8px',marginTop:'12px'}}, React.createElement('input',{type:'email', placeholder:'you@example.com — Sign Up / Sign In', value:email, onChange:e=>setEmail(e.target.value), required:true, style:{flex:1,height:'50px',padding:'0 14px',border:'3px solid #111',borderRadius:'10px',font:'700 11px system-ui'}}), React.createElement('button',{type:'submit', style:{height:'50px',padding:'0 18px',background:'#ffec47',border:'3px solid #111',borderRadius:'10px',font:'1000 11px var(--mono)',boxShadow:'0 5px 0 #111',cursor:'pointer'}}, busy?'WAIT…':'ENTER THE PIT →')), React.createElement('div',{style:{marginTop:'8px',font:'700 9px var(--mono)',textAlign:'center'}}, React.createElement('a',{href:'/game.html?guest=1', style:{color:'#111'}}, 'Guest demo — no wallet needed')));
  }
  if(!cfg.publicAppId) { 
    root.innerHTML=`<form id="fallbackForm" style="display:flex;gap:8px;margin-top:12px"><input id="fbEmail" type="email" placeholder="you@example.com — Sign Up / Sign In (demo)" required style="flex:1;height:50px;padding:0 14px;border:3px solid #111;border-radius:10px;font:700 11px system-ui"><button type="submit" style="height:50px;padding:0 18px;background:#ffec47;border:3px solid #111;border-radius:10px;font:1000 11px var(--mono);box-shadow:0 5px 0 #111;cursor:pointer">ENTER THE PIT →</button></form><div style="margin-top:8px;font:700 9px var(--mono);text-align:center"><a href="/game.html?guest=1" style="color:#111">Guest demo — no wallet needed</a> · Privy not configured (demo wallet)</div>`;
    document.getElementById('fallbackForm').onsubmit=(e)=>{ e.preventDefault(); const v=document.getElementById('fbEmail').value.trim().toLowerCase(); if(!v) return; localStorage.setItem('chogpit.email',v); localStorage.setItem('chogpit.privyPayoutAddress','0x'+Array.from({length:40},()=>Math.floor(Math.random()*16).toString(16)).join('')); location.href='/choose.html'; };
    return;
  }
  createRoot(root).render(React.createElement(PrivyProvider,{appId:cfg.publicAppId, config:{loginMethods:['email'], embeddedWallets:{ethereum:{createOnLogin:'users-without-wallets'}}, defaultChain:monad, supportedChains:[monad]}}, React.createElement(App)));
}
