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
    async function submit(e){ e.preventDefault(); const hint=email.trim().toLowerCase(); if(!hint) return; localStorage.setItem('chogpit.email', hint); setBusy(hint); if(!authenticated) login({loginMethods:['email'], prefill:{type:'email', value:hint}, walletChainType:'ethereum-only'}); }
    useEffect(()=>{ if(!busy||!authenticated||!ready||!wR) return; if(embedded.length!==1) return;
      (async()=>{ try{ await refreshUser(); const tok=await getIdentityToken(); if(!tok) throw Error('Enable identity token in Privy dashboard');
        const r=await fetch('/api/pass-portal/register',{method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${tok}`}, body:JSON.stringify({emailHint: busy, address: embedded[0].address})});
        const j=await r.json(); if(!r.ok) throw Error(j.error); location.href='/choose.html'; } catch(e){ alert(e.message); setBusy(null);} })();
    },[busy,authenticated,ready,wR,embedded.length]);
    function guest(){ localStorage.setItem('chogpit.guest','1'); location.href='/choose.html?guest=1'; }
    return React.createElement('div',{}, React.createElement('form',{onSubmit:submit, style:{display:'flex',gap:'6px',marginTop:'10px'}}, React.createElement('input',{type:'email', placeholder:'you@example.com', value:email, onChange:e=>setEmail(e.target.value), required:true, style:{flex:1,height:'38px',padding:'0 10px',border:'2px solid var(--ink)',borderRadius:'8px'}}), React.createElement('button',{type:'submit', style:{height:'38px',padding:'0 12px',background:'var(--yellow)',border:'2px solid var(--ink)',borderRadius:'8px',font:'900 9px var(--mono)'}}, busy?'WAIT…':'SIGN UP / SIGN IN →')), React.createElement('button',{type:'button', onClick:guest, style:{width:'100%',marginTop:'8px',height:'36px',background:'white',border:'2px solid var(--ink)',borderRadius:'8px',font:'900 9px var(--mono)'}}, 'Continue as Guest →'));
  }
  if(!cfg.publicAppId) { createRoot(root).render(React.createElement('div',{style:{padding:'8px',background:'#fff7d6',border:'1px solid var(--ink)',borderRadius:'8px',font:'900 9px var(--mono)'}}, 'Privy not configured — use Guest →')); }
  createRoot(root).render(React.createElement(PrivyProvider,{appId:cfg.publicAppId, config:{loginMethods:['email'], embeddedWallets:{ethereum:{createOnLogin:'users-without-wallets'}}, defaultChain:monad, supportedChains:[monad]}}, React.createElement(App)));
}
