import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { LateBoundCampaignIntake } from '../late-bound-intake.mjs';
import { createLocalCandidateCampaignServer } from '../campaign-candidate-service.mjs';

// Mock-token, localhost-only end-to-end: browser WebAuthn registration and
// address confirmation, authenticated real WebSocket game opening, batch lock.
const temp=mkdtempSync(path.join(os.tmpdir(),'chogpit-candidate-api-'));
const probe=net.createServer();probe.listen(0,'localhost');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://localhost:${port}`;
process.env.CHOGPIT_LOCAL_CANDIDATE_TEST='1';
const rulesHash=`0x${'c5'.repeat(32)}`;
let intake,service,browser,ws,hostWs,guestWs,coopHostWs,coopGuestWs;
try{
  intake=new LateBoundCampaignIntake(path.join(temp,'account.sqlite'),{
    campaignId:'CHOGPIT_LOCAL_BROWSER_TEST',vault:`0x${'6a'.repeat(20)}`,
    token:`0x${'2b'.repeat(20)}`,rulesHash,allowMockToken:true,
    admissionPolicy:{rulesHash,canOpen:()=>true,
      currentEpochId:()=>0,maxOpeningsForEpoch:()=>40}
  });
  service=createLocalCandidateCampaignServer({intake,origin,port,
    resolveArena:async()=>({id:'demo',genome:'demo-training',traps:[],scars:[]})});
  await service.listen();
  const isolatedStatus=await (await fetch(`${origin}/api/campaign/status`)).json();
  assert.deepEqual({ready:isolatedStatus.ready,claimsEnabled:isolatedStatus.claimsEnabled,
    localCandidateTestOnly:isolatedStatus.localCandidateTestOnly},
    {ready:false,claimsEnabled:false,localCandidateTestOnly:true});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/campaign-account.html`);
  await page.waitForFunction(()=>document.getElementById('campaignBadge').textContent==='LOCAL TEST ONLY');
  assert.match(await page.locator('#statusTitle').innerText(),/MOCK-CHAIN TEST/);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',
    transport:'internal',hasResidentKey:true,hasUserVerification:true,
    isUserVerified:true,automaticPresenceSimulation:true}});
  await page.locator('#registerButton').click();
  await page.waitForFunction(()=>document.getElementById('accountState').textContent.includes('PASSKEY ACCOUNT'));
  const session=await page.evaluate(()=>sessionStorage.getItem('chogpit_candidate_passkey_session'));
  assert.ok(session);
  const account=service.accounts.account(session);
  const bad=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(bad,'open');
  bad.send(JSON.stringify({type:'solo',arenaId:'demo',name:'UNAUTHENTICATED'}));
  const badMessages=[];
  bad.on('message',chunk=>badMessages.push(JSON.parse(chunk.toString())));
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.ok(badMessages.some(message=>/passkey account/.test(message.message||'')));
  bad.close();
  ws=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(ws,'open');
  const messages=[];ws.on('message',chunk=>messages.push(JSON.parse(chunk.toString())));
  ws.send(JSON.stringify({type:'solo',arenaId:'demo',name:'PASSKEY RAIDER',session}));
  await new Promise(resolve=>setTimeout(resolve,100));
  const room=[...service.rooms.rooms.values()][0];
  assert.ok(room);assert.equal(room.mode,'solo');assert.equal(room.phase,'playing');
  assert.equal(room.players[0].rewardAccountId,account.accountId);
  const player=room.players[0];
  const box=room.rewardBoxes[0];assert.ok(box);
  player.x=box.x;player.y=box.y;
  service.rooms.receiveInput(player.ws,{dx:0,dy:0,interact:true},Date.now());
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(box.opened,true);
  assert.equal(intake.audit().openings,1);
  assert.ok(messages.some(message=>message.type==='claim_pending'
    && message.status==='address-required'));
  const before=await page.evaluate(async token=>{
    const r=await fetch('/api/campaign/me',{headers:{Authorization:`Bearer ${token}`}});
    return r.json();
  },session);
  assert.equal(before.openings.length,1);
  assert.equal(before.openings[0].recipient,null);
  await page.locator('#payoutAddress').fill(`0x${'42'.repeat(20)}`);
  await page.locator('#payoutConfirm').fill(`0x${'43'.repeat(20)}`);
  page.on('dialog',dialog=>dialog.accept());
  await page.locator('#confirmAddressButton').click();
  await page.waitForFunction(()=>document.getElementById('message').textContent.includes('do not match'));
  await page.locator('#payoutConfirm').fill(`0x${'42'.repeat(20)}`);
  await page.locator('#confirmAddressButton').click();
  await page.waitForFunction(()=>document.getElementById('addressState').textContent.includes('0x4242'));
  const candidate=intake.sealNextBatch({epochId:0,batchId:0});
  assert.equal(candidate.count,1);
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('addressState').textContent.includes('PERMANENTLY LOCKED'));
  assert.equal(await page.locator('#confirmAddressButton').isDisabled(),true);
  const manifest=intake.exportUnsignedManifest();
  assert.equal(manifest.batches[0].entries[0].recipient,`0x${'42'.repeat(20)}`);
  // Create a second passkey account in the same virtual authenticator. The
  // first session remains valid so two independent WebSockets can join PvP.
  await page.locator('#registerButton').click();
  await page.waitForFunction(old=>sessionStorage.getItem('chogpit_candidate_passkey_session')!==old,session);
  const guestSession=await page.evaluate(()=>sessionStorage.getItem('chogpit_candidate_passkey_session'));
  const guestAccount=service.accounts.account(guestSession);
  assert.notEqual(guestAccount.accountId,account.accountId);
  hostWs=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(hostWs,'open');
  hostWs.send(JSON.stringify({type:'create',arenaId:'demo',name:'HOST',session}));
  await new Promise(resolve=>setTimeout(resolve,90));
  const pvp=[...service.rooms.rooms.values()].find(value=>value.mode==='pvp');
  assert.ok(pvp);
  guestWs=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(guestWs,'open');
  guestWs.send(JSON.stringify({type:'join',code:pvp.code,name:'GUEST',session:guestSession}));
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(pvp.players.length,2);
  assert.equal(pvp.players[1].rewardAccountId,guestAccount.accountId);
  service.rooms.countdownMs=10;
  service.rooms.startCountdown(pvp.players[0].ws);
  await new Promise(resolve=>setTimeout(resolve,50));
  service.rooms.tickAll();
  assert.equal(pvp.phase,'playing');
  const guest=pvp.players[1],pvpBox=pvp.rewardBoxes[0];
  guest.x=pvpBox.x;guest.y=pvpBox.y;
  service.rooms.receiveInput(guest.ws,{dx:0,dy:0,interact:true},Date.now());
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(pvpBox.opened,true);
  assert.equal(intake.audit().openings,2);
  assert.equal(intake.audit().unaddressed,1);
  assert.throws(()=>intake.exportUnsignedManifest(),/inclusion/,
    'The second PvP player has not confirmed an address; their event persists without blocking the solo batch.');

  // Separate fresh private room: the host switches to co-op while the guest
  // observes, and the FIRST server-checked opening of a shared box wins. This
  // is a mock-token localhost service, not the deployed game-only Worker.
  const priorClosed=[once(hostWs,'close'),once(guestWs,'close')];
  hostWs.close(); guestWs.close(); await Promise.all(priorClosed);
  coopHostWs=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(coopHostWs,'open');
  const coopHostMessages=[];
  coopHostWs.on('message',chunk=>coopHostMessages.push(JSON.parse(chunk.toString())));
  coopHostWs.send(JSON.stringify({type:'create',arenaId:'demo',name:'CO-OP HOST',session}));
  await new Promise(resolve=>setTimeout(resolve,90));
  const coop=[...service.rooms.rooms.values()].find(value=>value.phase==='waiting' && value.mode==='pvp');
  assert.ok(coop);
  coopGuestWs=new WebSocket(`${origin.replace('http','ws')}/ws`);
  await once(coopGuestWs,'open');
  const coopGuestMessages=[];
  coopGuestWs.on('message',chunk=>coopGuestMessages.push(JSON.parse(chunk.toString())));
  coopGuestWs.send(JSON.stringify({type:'join',code:coop.code,name:'CO-OP GUEST',session:guestSession}));
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(coop.players.length,2);
  coopGuestWs.send(JSON.stringify({type:'set_mode',mode:'coop'}));
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(coop.mode,'pvp','Guest cannot change a private room to co-op.');
  assert.ok(coopGuestMessages.some(message=>message.type==='error'
    && /Only the private-room host/.test(message.message)));
  coopHostWs.send(JSON.stringify({type:'set_mode',mode:'coop'}));
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(coop.mode,'coop');
  assert.ok(coopGuestMessages.some(message=>message.type==='room' && message.mode==='coop'));
  service.rooms.countdownMs=10;
  coopHostWs.send(JSON.stringify({type:'start'}));
  await new Promise(resolve=>setTimeout(resolve,60));
  service.rooms.tickAll();
  assert.equal(coop.phase,'playing');assert.equal(coop.bots.length,9);
  assert.deepEqual(coop.players.map(raider=>raider.livesLeft),[5,5]);
  const cohost=coop.players[0],coguest=coop.players[1],sharedBox=coop.rewardBoxes[0];
  cohost.x=sharedBox.x;cohost.y=sharedBox.y;
  coguest.x=sharedBox.x;coguest.y=sharedBox.y;
  // Both players hold OPEN in the same tick; only the first account gets the
  // server-owned shared opening, and neither a simultaneous nor a later retry
  // can mint another journal entry for that box.
  const attemptAt=Date.now();
  service.rooms.receiveInput(cohost.ws,{dx:0,dy:0,interact:true},attemptAt);
  service.rooms.receiveInput(coguest.ws,{dx:0,dy:0,interact:true},attemptAt);
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(sharedBox.opened,true);
  assert.equal(intake.audit().openings,3);
  assert.ok(coopHostMessages.some(message=>message.type==='claim_pending'
    && message.status==='address-required'));
  assert.equal(coopGuestMessages.filter(message=>message.type==='claim_pending').length,0);
  service.rooms.receiveInput(coguest.ws,{dx:0,dy:0,interact:true},Date.now());
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(intake.audit().openings,3,'The same co-op box cannot be claimed again by a teammate.');
  const secondCoopBox=coop.rewardBoxes[1];
  coguest.x=secondCoopBox.x;coguest.y=secondCoopBox.y;
  service.rooms.receiveInput(coguest.ws,{dx:0,dy:0,interact:true},Date.now());
  await new Promise(resolve=>setTimeout(resolve,130));
  assert.equal(intake.audit().openings,4);
  assert.equal(intake.audit().unaddressed,2);
  assert.ok(coopGuestMessages.some(message=>message.type==='claim_pending'
    && message.status==='address-required'));
  const coopBatch=intake.sealNextBatch({epochId:0,batchId:1});
  assert.equal(coopBatch.count,1,'The already-confirmed host can be batched without waiting for their teammate.');
  assert.equal(coopBatch.pendingOutsideBatch,2);
  assert.equal(coopBatch.unaddressedOutsideBatch,2);
  assert.equal(intake.exportUnsignedBatch(1).entries[0].mode,'coop');
  const hostState=await page.evaluate(async token=>{
    const response=await fetch('/api/campaign/me',{headers:{Authorization:`Bearer ${token}`}});
    return response.json();
  },session);
  assert.equal(hostState.openings.filter(opening=>opening.mode==='coop').length,1);
  assert.throws(()=>intake.exportUnsignedManifest(),/inclusion/,
    'Unaddressed PvP/co-op openings must stay pending; neither blocks an addressed host batch.');
  assert.deepEqual(errors,[]);
  console.log('PASS: isolated browser passkeys, server-owned solo/PvP/co-op openings, host mode lock, shared-box dedupe, late addresses and nonblocking batches; no live CHOG');
}finally{
  if(ws)ws.close();if(hostWs)hostWs.close();if(guestWs)guestWs.close();
  if(coopHostWs)coopHostWs.close();if(coopGuestWs)coopGuestWs.close();
  if(browser)await browser.close();
  if(service)await service.close();
  if(intake)intake.close();
  rmSync(temp,{recursive:true,force:true});
}
