// Isolated LOCAL TEST ONLY account + room API for the unreviewed threshold
// campaign. Not mounted by server.mjs, cannot authorize mainnet payouts and
// cannot be enabled for a hosted campaign through an environment shortcut.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { LiveRooms } from './live-rooms.mjs';
import { PasskeyAccounts } from './passkey-accounts.mjs';
const PUBLIC=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const PAGES=new Map([
  ['/campaign-account.html',['campaign-account.html','text/html; charset=utf-8']],
  ['/campaign-account.js',['campaign-account.js','application/javascript; charset=utf-8']]
]);
const sameOrigin=(req,origin)=>!req.headers.origin||req.headers.origin===origin;
const json=(res,status,obj)=>{
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer'});
  res.end(JSON.stringify(obj));
};
const fail=(res,status,message)=>json(res,status,{error:message});
const bodyJson=async req=>{
  if(!req.headers['content-type']?.startsWith('application/json')) throw Error('Use JSON.');
  let body='';
  for await(const part of req){body+=part;if(body.length>16000) throw Error('Request too large.');}
  const data=JSON.parse(body||'{}');
  if(!data||typeof data!=='object'||Array.isArray(data)) throw Error('Invalid JSON body.');
  return data;
};
export function createLocalCandidateCampaignServer({intake,origin,resolveArena,
  now=()=>Date.now(),port=0}={}){
  const url=new URL(origin);
  if(process.env.CHOGPIT_LOCAL_CANDIDATE_TEST!=='1'||url.protocol!=='http:'
    ||url.hostname!=='localhost'||typeof resolveArena!=='function'
    ||intake?.token?.toLowerCase()==='0x350035555e10d9afaf1566aaebfced5ba6c27777')
    throw Error('This candidate service is for an isolated localhost mock-token test ONLY.');
  const accounts=new PasskeyAccounts(intake,{rpID:'localhost',origin,now});
  const rate=new Map();
  const limited=req=>{
    const ip=isIP(req.socket.remoteAddress)?req.socket.remoteAddress:'unknown';
    const current=rate.get(ip)||{start:now(),n:0};
    if(now()-current.start>60000){current.start=now();current.n=0;}
    if(rate.size>1000) rate.clear();
    current.n++;rate.set(ip,current);return current.n>90;
  };
  const bearer=req=>{
    const value=req.headers.authorization;
    if(typeof value!=='string'||!/^Bearer [A-Za-z0-9_-]{20,128}$/.test(value))
      throw Error('Sign in with a passkey first.');
    return value.slice(7);
  };
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url||'/',origin).pathname;
    if(pathname==='/api/campaign/status'&&req.method==='GET')
      return json(res,200,{ready:false,localCandidateTestOnly:true,
        registrationsOpen:true,claimsEnabled:false,
        message:'LOCAL MOCK-CHAIN TEST ONLY. No real CHOG campaign, vault funding or public claim exists.'});
    if(pathname==='/api/campaign/me'&&req.method==='GET'){
      try{
        const account=accounts.account(bearer(req));
        const openings=intake.db.prepare(`SELECT event_id,mode,arena_id,opened_at,
          recipient,epoch_id,batch_id,position FROM openings WHERE account_id=?
          ORDER BY opened_at,event_id LIMIT 200`).all(account.accountId);
        return json(res,200,{...account,openings,localCandidateTestOnly:true,
          note:'Only a confirmed address before publication can receive a later seeded on-chain award.'});
      }catch{return fail(res,401,'Passkey account session expired or missing.');}
    }
    if(pathname.startsWith('/api/campaign/')){
      if(req.method!=='POST') return fail(res,405,'Method not allowed.');
      if(!sameOrigin(req,origin)) return fail(res,403,'Wrong request origin.');
      if(limited(req)) return fail(res,429,'Too many requests.');
      let body;
      try{body=await bodyJson(req);}catch{return fail(res,400,'Invalid or oversized JSON request.');}
      try{
        let result;
        switch(pathname){
          case '/api/campaign/register/options':result=await accounts.beginRegistration();break;
          case '/api/campaign/register/verify':result=await accounts.finishRegistration(body);break;
          case '/api/campaign/login/options':result=await accounts.beginAuthentication();break;
          case '/api/campaign/login/verify':result=await accounts.finishAuthentication(body);break;
          case '/api/campaign/address/options':{
            if(body.address!==body.confirmAddress)
              throw Error('Enter the same payout address twice.');
            result=await accounts.beginAddressConfirmation({
              session:bearer(req),address:body.address});break;
          }
          case '/api/campaign/address/verify':result=await accounts.finishAddressConfirmation({
            session:bearer(req),requestId:body.requestId,response:body.response});break;
          case '/api/campaign/logout':accounts.signOut(bearer(req));result={signedOut:true};break;
          default:return fail(res,404,'Unknown campaign account action.');
        }
        return json(res,200,result);
      }catch(error){return fail(res,400,String(error.message||'Passkey operation failed.').slice(0,200));}
    }
    if(req.method!=='GET'&&req.method!=='HEAD') return fail(res,405,'Method not allowed.');
    if(pathname==='/'||pathname==='/claim.html'){
      res.writeHead(302,{Location:'/campaign-account.html','Cache-Control':'no-store'});
      return res.end();
    }
    const file=PAGES.get(pathname);
    if(!file) return fail(res,404,'Only the passkey-account test page exists on this isolated server.');
    const data=await readFile(path.join(PUBLIC,file[0]));
    res.writeHead(200,{'Content-Type':file[1],'Content-Length':data.length,
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
    if(req.method==='HEAD') return res.end();res.end(data);
  });
  const rooms=new LiveRooms({rewardMode:'campaign',resolveArena,
    resolveSession:session=>accounts.account(session),
    onVerifiedOpening:(room,identity,box)=>intake.recordServerOpening({
      accountId:identity.accountId,runId:room.instanceId,
      round:room.roundNumber,boxId:box.id,mode:room.mode,arenaId:room.arena.id}),
    onReward:(_room,_identity,_box,recorded)=>({status:'address-required',
      eventId:recorded.eventId,
      note:'Opening recorded. Confirm your payout address with your passkey before this batch is published.'})
  });
  rooms.attach(server);
  // Caller explicitly starts this localhost-only test service.
  return {server,rooms,accounts,listen:()=>new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(port,'localhost',()=>resolve(server.address()));
  }),close:async()=>{rooms.close();await new Promise(resolve=>server.close(resolve));}};
}
