// Localhost-only mock email account UI. Never embed a sender, claim path or
// mainnet prize activation here. The link fragment is not sent on GET and a
// human must deliberately press the confirmation button.
const $=id=>document.getElementById(id);
const storage='chogpit_mock_email_session';
let session=sessionStorage.getItem(storage);
let pending=null;
const notice=text=>{$('message').textContent=text;};
const api=async(route,data={},authorized=false)=>{
  const response=await fetch(`/api/email/${route}`,{method:'POST',
    headers:{'Content-Type':'application/json',
      ...(authorized?{Authorization:`Bearer ${session}`}:{})},
    body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Local account action failed.');
  return result;
};
const refresh=async()=>{
  if(!session){$('accountState').textContent='Not signed in';
    $('addressState').textContent='No address confirmed';$('openings').replaceChildren();return;}
  const response=await fetch('/api/email/me',{headers:{Authorization:`Bearer ${session}`}});
  if(!response.ok){session=null;sessionStorage.removeItem(storage);
    $('accountState').textContent='Session expired. Request another email link.';return;}
  const state=await response.json();
  $('accountState').textContent=`Signed in to account ${state.accountId.slice(0,8)}… (mock only)`;
  $('addressState').textContent=state.payoutAddress
    ? `${state.payoutAddress}${state.addressLocked?' · PERMANENTLY LOCKED':''}`
    : 'No address confirmed';
  $('openings').replaceChildren();
  for(const item of state.openings){const li=document.createElement('li');
    li.textContent=`${item.mode} · ${item.event_id} · ${item.batch_id===null?'pending':'candidate batch '+item.batch_id}`;
    $('openings').append(li);}
};
const loadFragment=()=>{
  const fragment=location.hash.slice(1).split('=');
  if(fragment.length===2&&/^(login|address)$/.test(fragment[0])&&/^[A-Za-z0-9_-]{43}$/.test(fragment[1])){
    pending={purpose:fragment[0],token:fragment[1]};
    $('linkState').textContent=`${pending.purpose==='login'?'Sign-in':'Address'} email link received. Press the button to use it once.`;
    $('completeLink').disabled=false;
    history.replaceState(null,'',location.pathname);
  }
};
window.addEventListener('hashchange',loadFragment);
loadFragment();
$('askLogin').addEventListener('click',async()=>{
  try{const result=await api('login/request',{email:$('email').value});
    notice(result.sent?'If delivery succeeds, follow the emailed link.':'Link request failed.');}
  catch(error){notice(error.message);}
});
$('completeLink').addEventListener('click',async()=>{
  if(!pending)return;
  try{
    if(pending.purpose==='login'){
      const result=await api('login/complete',{token:pending.token});
      session=result.session;sessionStorage.setItem(storage,session);
      notice('Inbox confirmed for this account. This does not prove unique identity.');
    }else{
      if(!session)throw Error('Sign in to this account before confirming its address.');
      const result=await api('address/complete',{token:pending.token},true);
      notice(`Mock address confirmed: ${result.payoutAddress}. Verify wallet ownership yourself.`);
    }
    pending=null;$('completeLink').disabled=true;
    $('linkState').textContent='One-time email link used.';
    await refresh();
  }catch(error){notice(error.message);}
});
$('askAddress').addEventListener('click',async()=>{
  try{
    if(!session)throw Error('Sign in before confirming an address.');
    const result=await api('address/request',{address:$('address').value,
      confirmAddress:$('confirmAddress').value},true);
    notice(result.sent?'Check the inbox for a separate address-confirmation link.':'No link sent.');
  }catch(error){notice(error.message);}
});
$('logout').addEventListener('click',async()=>{
  try{if(session)await api('logout',{},true);}catch{}
  session=null;sessionStorage.removeItem(storage);await refresh();notice('Signed out.');
});
refresh().catch(()=>notice('Could not load the local mock account.'));
