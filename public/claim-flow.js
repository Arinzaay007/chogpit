const CHOG = {70:5,95:10,100:25};
export function rollChog(){ const r=Math.random()*100; if(r<70) return 5; if(r<95) return 10; return 25; }
export function loadCredit(){ return Number(localStorage.getItem('chogpit.credit')||0); }
export function addCredit(n){ const v=loadCredit()+n; localStorage.setItem('chogpit.credit', String(v)); checkAutoCash(); return v; }
export function checkAutoCash(){
  const bal=loadCredit(); const holder=localStorage.getItem('chogpit.passHolder')==='1';
  const badge=document.getElementById('creditBadge'); if(badge) badge.textContent=`${bal} CHOG`;
  if(bal>=50 && holder){
    const addr=localStorage.getItem('chogpit.privyPayoutAddress')||localStorage.getItem('chogpit.heroWallet')||'—';
    document.getElementById('cashoutNote')&& (document.getElementById('cashoutNote').textContent=`✓ AUTO-PAY 50 CHOG → ${addr.slice(0,10)}... (sponsor gas)`);
    // real vault pay would be server POST /api/payout/auto with holder proof; here preview ledger
    if(!sessionStorage.getItem('autoPaid50')){ sessionStorage.setItem('autoPaid50','1'); addCredit(-50); alert('50 CHOG auto-paid to your Privy wallet! (preview ledger -50, vault pays on-chain when holder verified)'); }
  }
}
export function heroFor(address){
  const seeds=["Aqua Depths","Banana Peel","Gangster","Monad Pulse","Void Black","Lime Grid","Sky Blue","Red Sky"];
  const h=seeds[parseInt(address.slice(-2),16)%seeds.length];
  return h;
}
