import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { createLocalEmailCampaignServer } from '../email-candidate-service.mjs';

const dir=mkdtempSync(path.join(os.tmpdir(),'chogpit-email-api-'));
const probe=net.createServer();probe.listen(0,'localhost');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://localhost:${port}`;
delete process.env.CHOGPIT_LOCAL_CANDIDATE_TEST;
let intake,service,browser,ws,host,guest;
try {
  const rulesHash=`0x${'e2'.repeat(32)}`;
  intake=new LateBoundCampaignIntake(path.join(dir,'test.sqlite'),{
    campaignId:'CHOGPIT_EMAIL_BROWSER_TEST',vault:`0x${'53'.repeat(20)}`,
    token:`0x${'54'.repeat(20)}`,rulesHash,allowMockToken:true,
    accountMethod:'email',admissionPolicy:{rulesHash,canOpen:()=>true,
      currentEpochId:()=>0,maxOpeningsForEpoch:()=>4}
  });
  const outbox=[];
  assert.throws(()=>createLocalEmailCampaignServer({intake,origin,
    sendMagicLink:async()=>{},resolveArena:async()=>({id:'demo'})}),
    /localhost\/mock-token/);
  process.env.CHOGPIT_LOCAL_CANDIDATE_TEST='1';
  service=createLocalEmailCampaignServer({intake,origin,port,
    sendMagicLink:async mail=>outbox.push(mail),
    resolveArena:async()=>({id:'demo',genome:'demo-training',traps:[],scars:[]})});
  await service.listen();
  const status=await (await fetch(`${origin}/api/campaign/status`)).json();
  assert.equal(status.ready,false);assert.equal(status.claimsEnabled,false);
  const post=(path,body={},token=null,sameOrigin=true)=>fetch(`${origin}${path}`,{
    method:'POST',headers:{'Content-Type':'application/json',
      ...(sameOrigin?{Origin:origin}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},
    body:JSON.stringify(body)});
  assert.equal((await post('/api/email/login/request',{email:'alice@example.org'},null,false)).status,403);
  const response=await (await post('/api/email/login/request',{email:'alice@example.org'})).json();
  assert.equal(response.sent,true);
  assert.equal(JSON.stringify(response).includes('login='),false);
  const loginUrl=outbox.pop().url;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  await page.goto(loginUrl);
  await page.waitForFunction(()=>document.getElementById('completeLink').disabled===false);
  assert.equal(intake.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,0,
    'Visiting the link (or an email scanner GET) does not use it.');
  await page.locator('#completeLink').click();
  await page.waitForFunction(()=>document.getElementById('accountState').textContent.includes('Signed in'));
  assert.equal(intake.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,1);
  const session=await page.evaluate(()=>sessionStorage.getItem('chogpit_mock_email_session'));
  const alice=service.accounts.account(session);
  assert.throws(()=>service.accounts.finishLogin(loginUrl.split('#login=')[1]),/already used/);
  const bad=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(bad,'open');const badMessages=[];
  bad.on('message',chunk=>badMessages.push(JSON.parse(chunk.toString())));
  bad.send(JSON.stringify({type:'solo',arenaId:'demo',name:'FORGED'}));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(badMessages.some(msg=>/account/.test(msg.message||'')));
  bad.close();
  ws=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(ws,'open');const messages=[];
  ws.on('message',chunk=>messages.push(JSON.parse(chunk.toString())));
  ws.send(JSON.stringify({type:'solo',arenaId:'demo',name:'EMAIL PLAYER',session}));
  await new Promise(resolve=>setTimeout(resolve,110));
  const room=[...service.rooms.rooms.values()][0];
  assert.equal(room.players[0].rewardAccountId,alice.accountId);
  const player=room.players[0],box=room.rewardBoxes[0];
  player.x=box.x;player.y=box.y;
  service.rooms.receiveInput(player.ws,{dx:0,dy:0,interact:true},Date.now());
  await new Promise(resolve=>setTimeout(resolve,135));
  assert.equal(intake.audit().openings,1);
  assert.ok(messages.some(msg=>msg.type==='claim_pending'&&msg.status==='address-required'));
  const address=`0x${'48'.repeat(20)}`;
  assert.equal((await post('/api/email/address/request',{address,
    confirmAddress:`0x${'49'.repeat(20)}`},session)).status,400);
  assert.equal((await post('/api/email/address/request',{address,confirmAddress:address},session)).status,200);
  const addressUrl=outbox.pop().url;
  await page.goto(addressUrl);
  await page.waitForFunction(()=>document.getElementById('completeLink').disabled===false);
  assert.equal(service.accounts.account(session).payoutAddress,null);
  await page.locator('#completeLink').click();
  await page.waitForFunction(()=>document.getElementById('addressState').textContent.includes('0x4848'));
  assert.equal(service.accounts.account(session).payoutAddress,address.toLowerCase());
  assert.equal(intake.sealNextBatch({epochId:0,batchId:0}).count,1);
  assert.equal((await post('/api/email/address/request',{address,confirmAddress:address},session)).status,400);
  const bobLink=await post('/api/email/login/request',{email:'bob@example.org'});
  assert.equal(bobLink.status,200);
  const bob=(await (await post('/api/email/login/complete',{
    token:outbox.pop().url.split('#login=')[1]})).json());
  assert.notEqual(bob.accountId,alice.accountId);
  host=new WebSocket(`${origin.replace('http','ws')}/ws`);await once(host,'open');
  host.send(JSON.stringify({type:'create',arenaId:'demo',name:'HOST',session}));
  await new Promise(resolve=>setTimeout(resolve,110));
  const coop=[...service.rooms.rooms.values()].find(r=>r.phase==='waiting');
  guest=new WebSocket(`${origin.replace('http','ws')}/ws`);await once(guest,'open');
  guest.send(JSON.stringify({type:'join',code:coop.code,name:'GUEST',session:bob.session}));
  await new Promise(resolve=>setTimeout(resolve,100));
  host.send(JSON.stringify({type:'set_mode',mode:'coop'}));
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(coop.mode,'coop');
  service.rooms.countdownMs=10;host.send(JSON.stringify({type:'start'}));
  await new Promise(resolve=>setTimeout(resolve,75));service.rooms.tickAll();
  assert.equal(coop.phase,'playing');
  assert.deepEqual(coop.players.map(p=>p.livesLeft),[5,5]);
  const shared=coop.rewardBoxes[0],a=coop.players[0],b=coop.players[1];
  a.x=shared.x;a.y=shared.y;b.x=shared.x;b.y=shared.y;
  const at=Date.now();
  service.rooms.receiveInput(a.ws,{dx:0,dy:0,interact:true},at);
  service.rooms.receiveInput(b.ws,{dx:0,dy:0,interact:true},at);
  await new Promise(resolve=>setTimeout(resolve,135));
  assert.equal(shared.opened,true);assert.equal(intake.audit().openings,2);
  const second=coop.rewardBoxes[1];b.x=second.x;b.y=second.y;
  service.rooms.receiveInput(b.ws,{dx:0,dy:0,interact:true},Date.now());
  await new Promise(resolve=>setTimeout(resolve,135));
  assert.equal(intake.audit().openings,3);
  assert.equal(intake.audit().unaddressed,1);
  assert.equal(intake.sealNextBatch({epochId:0,batchId:1}).count,1,
    'Addressed co-op host is batched while the unaddressed teammate remains reserved.');
  assert.equal(intake.audit().pending,1);
  assert.equal((await (await fetch(`${origin}/api/email/me`,{
    headers:{Authorization:`Bearer ${bob.session}`}})).json()).openings.length,1);
  assert.equal((await post('/api/campaign/claim',{})).status,405,
    'The mock service has no POST claim route.');
  console.log('PASS: localhost-only email browser/manual magic link, server-owned solo and co-op shared box, audited post-opening address and pending guest; no real claim endpoint');
} finally {
  if(ws)ws.close();if(host)host.close();if(guest)guest.close();
  if(browser)await browser.close();
  if(service)await service.close();
  if(intake)intake.close();rmSync(dir,{recursive:true,force:true});
}
