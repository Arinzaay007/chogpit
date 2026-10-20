// Localhost/mock-token EMAIL + private-room service for disposable tests only.
// NOT imported by server.mjs, the game-only Worker or any payout deployment.
// No mainnet CHOG, live oracle, claims or outbound mail provider is configured.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { EmailAccounts } from './email-accounts.mjs';
import { LiveRooms } from './live-rooms.mjs';

const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const PAGES=new Map([
  ['/campaign-email-account.html',['campaign-email-account.html','text/html; charset=utf-8']],
  ['/campaign-email-account.js',['campaign-email-account.js','application/javascript; charset=utf-8']]
]);
const headers={ 'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY' };
const json=(res,status,data)=>{res.writeHead(status,headers);res.end(JSON.stringify(data));};
const error=(res,status,message)=>json(res,status,{error:message});
const bodyJson=async req=>{
  if(!req.headers['content-type']?.startsWith('application/json'))throw Error('JSON required.');
  let text='';
  for await(const part of req){text+=part;if(text.length>16000)throw Error('Body too large.');}
  const data=JSON.parse(text||'{}');
  if(!data||Array.isArray(data)||typeof data!=='object')throw Error('JSON object required.');
  return data;
};

export function createLocalEmailCampaignServer({intake,origin,sendMagicLink,
  resolveArena,now=()=>Date.now(),port=0}={}){
  const url=new URL(origin);
  if(process.env.CHOGPIT_LOCAL_CANDIDATE_TEST!=='1' || url.protocol!=='http:'
    || url.hostname!=='localhost' || url.origin!==origin || intake?.accountMethod!=='email'
    || typeof sendMagicLink!=='function' || typeof resolveArena!=='function'
    || intake.token.toLowerCase()==='0x350035555e10d9afaf1566aaebfced5ba6c27777')
    throw Error('The email service requires an explicitly isolated localhost/mock-token test.');
  const accounts=new EmailAccounts(intake,{origin,sendMagicLink,now});
  const rate=new Map();
  const limited=req=>{
    const ip=isIP(req.socket.remoteAddress)?req.socket.remoteAddress:'unknown';
    const current=rate.get(ip)||{start:now(),n:0};
    if(now()-current.start>60000){current.start=now();current.n=0;}
    if(rate.size>1000)rate.clear();
    current.n++;rate.set(ip,current);return current.n>90;
  };
  const bearer=req=>{
    const value=req.headers.authorization;
    if(typeof value!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(value))
      throw Error('Sign in with a one-time email link.');
    return value.slice(7);
  };
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url||'/',origin).pathname;
    if(pathname==='/api/campaign/status'&&req.method==='GET')
      return json(res,200,{ready:false,localCandidateTestOnly:true,claimsEnabled:false,
        registrationsOpen:false,message:'LOCAL MOCK-TOKEN TEST ONLY. The public game has no real CHOG prize.'});
    if(pathname==='/api/email/me'&&req.method==='GET'){
      try{
        const account=accounts.account(bearer(req));
        const openings=intake.db.prepare(`SELECT event_id,mode,arena_id,opened_at,
          recipient,epoch_id,batch_id,position FROM openings WHERE account_id=?
          ORDER BY opened_at,event_id`).all(account.accountId);
        return json(res,200,{...account,openings,localCandidateTestOnly:true,
          note:'Only a separately funded, published on-chain batch could create a real award.'});
      }catch{return error(res,401,'Email session expired or missing.');}
    }
    if(pathname.startsWith('/api/email/')){
      if(req.method!=='POST')return error(res,405,'Method not allowed.');
      if(req.headers.origin!==origin)return error(res,403,'Wrong or missing request origin.');
      if(limited(req))return error(res,429,'Too many requests.');
      let body;
      try{body=await bodyJson(req);}catch{return error(res,400,'Invalid or oversized JSON request.');}
      try{
        switch(pathname){
          case '/api/email/login/request':
            return json(res,200,await accounts.requestLogin(body.email));
          case '/api/email/login/complete':
            return json(res,200,accounts.finishLogin(body.token));
          case '/api/email/address/request':
            return json(res,200,await accounts.requestAddressConfirmation({
              session:bearer(req),address:body.address,confirmAddress:body.confirmAddress}));
          case '/api/email/address/complete':
            return json(res,200,accounts.finishAddressConfirmation({
              session:bearer(req),token:body.token}));
          case '/api/email/logout':
            accounts.signOut(bearer(req));return json(res,200,{signedOut:true});
          default:return error(res,404,'Unknown email account action.');
        }
      }catch(cause){return error(res,400,String(cause.message||'Email operation failed.').slice(0,200));}
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return error(res,405,'Method not allowed.');
    if(pathname==='/'||pathname==='/claim.html'){
      res.writeHead(302,{Location:'/campaign-email-account.html','Cache-Control':'no-store'});
      return res.end();
    }
    const file=PAGES.get(pathname);
    if(!file)return error(res,404,'Only the email-account local test page is available.');
    const data=await readFile(path.join(ROOT,file[0]));
    res.writeHead(200,{'Content-Type':file[1],'Content-Length':data.length,
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
    if(req.method==='HEAD')return res.end();res.end(data);
  });
  const rooms=new LiveRooms({rewardMode:'campaign',accountKind:'email',resolveArena,
    resolveSession:session=>accounts.account(session),
    onVerifiedOpening:(room,identity,box)=>intake.recordServerOpening({
      accountId:identity.accountId,runId:room.instanceId,
      round:room.roundNumber,boxId:box.id,mode:room.mode,arenaId:room.arena.id}),
    onReward:(_room,_identity,_box,recorded)=>({status:'address-required',
      eventId:recorded.eventId,
      note:'LOCAL TEST ONLY: mock opening recorded. Email-confirm an address for a mock batch; no CHOG can be paid.'})
  });
  rooms.attach(server);
  return {server,rooms,accounts,listen:()=>new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'localhost',()=>resolve(server.address()));
  }),close:async()=>{rooms.close();await new Promise(resolve=>server.close(resolve));}};
}
