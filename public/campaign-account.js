// No wallet provider or chain transaction is used anywhere on this page.
// Hosted preview stays locked. The endpoints below are exercised only by the
// isolated LOCAL MOCK-CHAIN candidate test service until launch reviews pass.
const $=id=>document.getElementById(id);
const tokenKey='chogpit_candidate_passkey_session';
let session=sessionStorage.getItem(tokenKey)||'';
let testAvailable=false;
const say=(text,error=false)=>{$('message').textContent=text;$('message').classList.toggle('error',error);};
const fail=error=>say(error?.message||'That passkey action failed. Please try again.',true);
async function api(path,body,authenticated=false){
  const response=await fetch(`/api/campaign/${path}`,{
    method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(authenticated&&session?{Authorization:`Bearer ${session}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'
  });
  const data=await response.json();
  if(!response.ok) throw Error(data.error||`Request failed (${response.status}).`);
  return data;
}
const bytes=value=>{
  const text=value.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(text+'='.repeat((4-text.length%4)%4)),c=>c.charCodeAt(0));
};
const b64=buffer=>btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
function registrationOptions(options){
  return {...options,challenge:bytes(options.challenge),user:{...options.user,id:bytes(options.user.id)},
    excludeCredentials:options.excludeCredentials?.map(c=>({...c,id:bytes(c.id)}))};
}
function authenticationOptions(options){
  return {...options,challenge:bytes(options.challenge),
    allowCredentials:options.allowCredentials?.map(c=>({...c,id:bytes(c.id)}))};
}
async function register(options){
  const credential=await navigator.credentials.create({publicKey:registrationOptions(options)});
  if(!credential) throw Error('Passkey registration was cancelled.');
  return {id:credential.id,rawId:b64(credential.rawId),type:credential.type,
    response:{clientDataJSON:b64(credential.response.clientDataJSON),
      attestationObject:b64(credential.response.attestationObject),
      transports:credential.response.getTransports?.()||[]},
    clientExtensionResults:credential.getClientExtensionResults(),
    authenticatorAttachment:credential.authenticatorAttachment};
}
async function authenticate(options){
  const credential=await navigator.credentials.get({publicKey:authenticationOptions(options)});
  if(!credential) throw Error('Passkey sign-in was cancelled.');
  return {id:credential.id,rawId:b64(credential.rawId),type:credential.type,
    response:{clientDataJSON:b64(credential.response.clientDataJSON),
      authenticatorData:b64(credential.response.authenticatorData),
      signature:b64(credential.response.signature),
      userHandle:credential.response.userHandle?b64(credential.response.userHandle):undefined},
    clientExtensionResults:credential.getClientExtensionResults(),
    authenticatorAttachment:credential.authenticatorAttachment};
}
function setSession(value){session=value||'';
  if(session)sessionStorage.setItem(tokenKey,session);
  else sessionStorage.removeItem(tokenKey);
  $('logoutButton').hidden=!session;
  $('confirmAddressButton').disabled=!session||!testAvailable;
}
function renderAccount(me){
  $('accountState').textContent=me?`PASSKEY ACCOUNT ${me.accountId.slice(0,8).toUpperCase()} · ${me.openings.length} recorded opening(s)`:'Not signed in.';
  $('addressState').textContent=me?.payoutAddress
    ? `${me.payoutAddress} · ${me.addressLocked?'PERMANENTLY LOCKED':'confirmed but still changeable before first batch'}`
    :'No payout address confirmed.';
  $('payoutAddress').disabled=!!me?.addressLocked;
  $('payoutConfirm').disabled=!!me?.addressLocked;
  $('confirmAddressButton').disabled=!me||!!me.addressLocked||!testAvailable;
  $('openings').replaceChildren();
  if(!me){$('openings').textContent='Sign in to see your openings.';return;}
  if(!me.openings.length){$('openings').textContent='No new campaign openings recorded yet.';return;}
  for(const opening of me.openings){
    const item=document.createElement('div');item.className='event';
    const title=document.createElement('b');title.textContent=`${opening.mode.toUpperCase()} · ARENA ${opening.arena_id} · ${new Date(opening.opened_at).toLocaleString()}`;
    const state=document.createElement('p');state.textContent=opening.batch_id==null
      ? me.payoutAddress?'Address confirmed; waiting for a batch.':'Waiting for your address; other players can be batched.'
      :`Sealed candidate batch ${opening.batch_id}, epoch ${opening.epoch_id}; outcome requires on-chain publication and oracle seed.`;
    const event=document.createElement('code');event.textContent=opening.event_id;
    item.append(title,state,event);$('openings').append(item);
  }
}
async function refresh(){
  if(!session)return renderAccount(null);
  try{renderAccount(await api('me',undefined,true));}
  catch{setSession('');renderAccount(null);}
}
async function run(button,action){
  if(!testAvailable)return say('This hosted playtest does not accept passkey accounts or create CHOG claims.',true);
  button.disabled=true;
  try{await action();}catch(error){fail(error);}finally{button.disabled=false;await refresh();}
}
$('registerButton').addEventListener('click',()=>run($('registerButton'),async()=>{
  const {requestId,options}=await api('register/options',{});
  const response=await register(options);
  const created=await api('register/verify',{requestId,response});
  setSession(created.session);say('Passkey account created. Open a new campaign box before confirming an address.');
}));
$('loginButton').addEventListener('click',()=>run($('loginButton'),async()=>{
  const {requestId,options}=await api('login/options',{});
  const response=await authenticate(options);
  const signedIn=await api('login/verify',{requestId,response});
  setSession(signedIn.session);say('Signed in with your passkey. No payout wallet was connected.');
}));
$('confirmAddressButton').addEventListener('click',()=>run($('confirmAddressButton'),async()=>{
  if(!session)throw Error('Sign in first.');
  const address=$('payoutAddress').value.trim(),confirmAddress=$('payoutConfirm').value.trim();
  if(address!==confirmAddress)throw Error('Payout address entries do not match.');
  if(!window.confirm(`Verify this exact payout destination carefully:\n\n${address}\n\nA passkey confirms your account, NOT ownership of this address. Continue?`))
    return;
  const {requestId,options,destination}=await api('address/options',{address,confirmAddress},true);
  const response=await authenticate(options);
  await api('address/verify',{requestId,response},true);
  say(`Address ${destination} confirmed with your passkey. It locks at first batch publication.`);
  $('payoutAddress').value='';$('payoutConfirm').value='';
}));
$('logoutButton').addEventListener('click',async()=>{
  try{await api('logout',{},true);}catch{}setSession('');renderAccount(null);say('Signed out.');
});
setSession(session);
try{
  const status=await api('status');
  testAvailable=status.localCandidateTestOnly===true&&status.registrationsOpen===true;
  $('statusTitle').textContent=testAvailable?'LOCAL MOCK-CHAIN TEST · NO REAL CHOG':'No real CHOG claims are live.';
  $('statusText').textContent=status.message||'The owner has not activated a funded, reviewed campaign.';
  $('campaignBadge').textContent=testAvailable?'LOCAL TEST ONLY':'NOT LIVE';
  $('registerButton').disabled=!testAvailable;
  $('loginButton').disabled=!testAvailable;
  await refresh();
}catch(error){$('statusText').textContent='No verified campaign account service is available on this playtest.';fail(error);}
