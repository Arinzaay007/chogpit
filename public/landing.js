export function mountLanding(cfg){
  const root=document.getElementById('authMount'); if(!root) return;
  root.innerHTML = `
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button id="connectBtn" style="flex:1;min-width:160px;height:50px;padding:0 18px;background:#ffec47;border:3px solid #111;border-radius:10px;font:1000 11px var(--mono);box-shadow:0 5px 0 #111;cursor:pointer">Connect Wallet →</button>
      <button id="guestBtn" style="height:50px;padding:0 14px;background:#fff;border:3px solid #111;border-radius:10px;font:800 11px var(--mono);cursor:pointer">Guest demo</button>
    </div>
    <div id="addr" style="margin-top:8px;font:700 10px var(--mono);color:#111;min-height:14px;text-align:center"></div>
  `;
  const btn=document.getElementById('connectBtn'), guest=document.getElementById('guestBtn'), addrEl=document.getElementById('addr');
  const saved=localStorage.getItem('chogpit.wallet'); if(saved) addrEl.textContent='Connected: '+saved.slice(0,6)+'...'+saved.slice(-4)+' → pick your fighter';
  guest.onclick=()=>{ localStorage.setItem('chogpit.guest','1'); location.href='/choose.html?guest=1'; };
  btn.onclick=async()=>{
    try{
      if(!window.ethereum){ addrEl.textContent='No wallet found — install MetaMask / Rabby, then refresh.'; window.open('https://metamask.io/download/','_blank'); return; }
      btn.textContent='Connecting…'; btn.disabled=true;
      const accounts=await window.ethereum.request({method:'eth_requestAccounts'});
      const address=accounts[0];
      if(!address) throw Error('No account');
      // Switch to Monad 143 (add if missing)
      try{ await window.ethereum.request({method:'wallet_switchEthereumChain', params:[{chainId:'0x8f'}]}); }catch(e){
        if(e.code===4902){
          await window.ethereum.request({method:'wallet_addEthereumChain', params:[{chainId:'0x8f', chainName:'Monad Mainnet', nativeCurrency:{name:'MON',symbol:'MON',decimals:18}, rpcUrls:['https://rpc.monad.xyz'], blockExplorerUrls:['https://monadscan.com/']}]});
        }
      }
      localStorage.setItem('chogpit.wallet', address);
      localStorage.setItem('chogpit.signedUpAt', new Date().toISOString());
      localStorage.removeItem('chogpit.guest');
      addrEl.textContent='Connected: '+address.slice(0,6)+'...'+address.slice(-4)+' ✓';
      setTimeout(()=> location.href='/choose.html', 600);
    }catch(e){ btn.textContent='Connect Wallet →'; btn.disabled=false; addrEl.textContent=e.message || 'Connect failed — try again'; }
  };
}
