// Browser-only claim UI for the separately reviewed claim service. It never
// constructs a transaction from a caller-supplied proof, vault or recipient.
// A signed wallet session is held in memory, not localStorage/cookies.
const $ = id => document.getElementById(id);
let campaign = null, wallet = null, bearer = null, proofs = [], credit = 0n, busy = false;
const short = value => typeof value === 'string' && value.length > 17
  ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
const formatChog = wei => {
  const n = BigInt(wei), whole = n / 10n ** 18n, rem = n % 10n ** 18n;
  const decimal = rem ? `.${rem.toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6)}` : '';
  return `${whole}${decimal} CHOG`;
};
const message = (text, error = false) => {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
};
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', headers: {
    'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...(options.headers || {})
  } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Claim service returned HTTP ${response.status}.`);
  return result;
}
function renderStatus() {
  const available = campaign?.ready === true && campaign?.claimsEnabled === true && campaign?.mockOnly !== true;
  const configured = Boolean(campaign?.campaignId && campaign?.vault && campaign.mockOnly !== true);
  $('statusBadge').className = `badge ${available ? '' : configured ? 'waiting' : 'blocked'}`;
  $('statusBadge').textContent = available ? 'CLAIMS READY · SPONSOR PAYS GAS'
    : configured ? 'CAMPAIGN CONFIGURED · AWAITING FUNDING / ORACLE / PUBLICATION'
      : 'REAL CLAIMS NOT LIVE';
  $('campaignName').textContent = campaign?.campaignId || 'Not configured';
  $('vaultAddress').textContent = configured ? short(campaign.vault) : 'Not deployed';
  $('vaultAddress').title = configured ? campaign.vault : '';
  $('fundingState').textContent = configured
    ? `${campaign.funded ? 'FUNDED' : 'NOT FUNDED'} · ${campaign.rootsCommitted ? 'ROOT COMMITTED' : 'ROOT PENDING'} · ${campaign.oracleSeedsReady ? 'ORACLE READY' : 'ORACLE PENDING'}`
    : 'No reviewed, funded vault available';
  $('campaignNote').textContent = configured
    ? `Publisher-verified manifest ${short(campaign.manifestDigest)}. ${available ? 'Claim only proofs bound to your signed wallet.' : 'Do not treat pending proofs as withdrawable CHOG.'}`
    : 'This page cannot turn shooter preview points into real CHOG. A separate funded campaign must first publish eligible fresh-game-event proofs.';
  $('connectButton').disabled = busy || !configured || !window.ethereum?.request;
  $('refreshButton').disabled = busy || !bearer;
  $('withdrawButton').disabled = busy || !bearer || credit <= 0n || !campaign?.funded;
  $('linkedWallet').textContent = wallet ? `${short(wallet)} · signed campaign session` : 'WALLET NOT LINKED';
  $('creditAmount').textContent = formatChog(credit);
  renderProofs();
}
function renderProofs() {
  const list = $('proofList');
  list.replaceChildren();
  if (!bearer || !proofs.length) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = !bearer ? 'Link a wallet to check for fresh-campaign proofs.'
      : 'No published fresh-campaign boxes for this wallet yet. Preview points never appear here.';
    list.append(p); return;
  }
  for (const proof of proofs) {
    const row = document.createElement('div'); row.className = 'proof';
    const meta = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `BOX ${proof.index + 1} · BATCH ${proof.batchId} · PUBLISHED PROOF`;
    const detail = document.createElement('small'); detail.textContent = short(proof.eventId);
    const control = document.createElement('button'); control.type = 'button';
    control.textContent = campaign?.ready ? 'SPONSOR REDEEM ↗' : 'AWAITING ON-CHAIN SEED';
    control.disabled = busy || !campaign?.ready;
    control.addEventListener('click', () => redeem(proof.eventId));
    meta.append(title, detail); row.append(meta, control); list.append(row);
  }
}
async function refreshStatus() {
  try { campaign = await api('/api/claims/status'); }
  catch (error) {
    campaign = null;
    message(`Real claims unavailable: ${error.message}`, true);
  }
  renderStatus();
}
async function refreshProofs() {
  if (!bearer) return;
  try {
    const response = await api('/api/claims/proofs');
    if (response.recipient?.toLowerCase() !== wallet?.toLowerCase()) throw new Error('Wallet mismatch; sign in again.');
    proofs = Array.isArray(response.proofs) ? response.proofs : [];
    credit = BigInt(response.onchainCreditWei || '0');
    renderStatus();
  } catch (error) { message(error.message, true); }
}
async function linkWallet() {
  if (!window.ethereum?.request || !campaign?.vault || busy) return;
  busy = true; renderStatus();
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) throw new Error('Choose your wallet first.');
    const chain = await window.ethereum.request({ method: 'eth_chainId' });
    if (chain.toLowerCase() !== '0x8f') {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x8f' }] });
    }
    const selected = accounts[0];
    const challenge = await api(`/api/claims/challenge?wallet=${encodeURIComponent(selected)}`);
    const signature = await window.ethereum.request({ method: 'personal_sign',
      params: [challenge.message, selected] });
    const session = await api('/api/claims/session', { method: 'POST',
      body: JSON.stringify({ wallet: selected, nonce: challenge.nonce, signature }) });
    wallet = selected; bearer = session.bearer; proofs = []; credit = 0n;
    message('Wallet linked for this specific published campaign. No wallet transaction was sent.');
  } catch (error) { message(error?.message || 'Wallet connection cancelled.', true); }
  finally { busy = false; renderStatus(); }
  if (bearer) await refreshProofs();
}
async function redeem(eventId) {
  if (!bearer || !campaign?.ready || busy) return;
  busy = true; renderStatus(); message('Sponsor is verifying the on-chain proof and submitting the transaction…');
  try {
    const receipt = await api('/api/claims/redeem', { method: 'POST', body: JSON.stringify({ eventId }) });
    message(`Confirmed sponsored redemption: ${short(receipt.txHash)}. Refreshing on-chain credit.`);
    await refreshProofs();
  } catch (error) { message(`Redemption was not confirmed: ${error.message}`, true); }
  finally { busy = false; renderStatus(); }
}
async function withdraw() {
  if (!bearer || credit <= 0n || !campaign?.funded || busy) return;
  busy = true; renderStatus(); message(`Sponsor is sending ${formatChog(credit)} directly to your linked wallet…`);
  try {
    const receipt = await api('/api/claims/withdraw', { method: 'POST', body: '{}' });
    message(`CHOG transfer confirmed for ${short(wallet)}: ${short(receipt.txHash)}. No withdrawal minimum or player MON was required.`);
    await refreshProofs();
  } catch (error) { message(`Withdrawal was not confirmed: ${error.message}`, true); }
  finally { busy = false; renderStatus(); }
}
function clearSession() { wallet = null; bearer = null; proofs = []; credit = 0n; renderStatus(); }
$('connectButton').addEventListener('click', linkWallet);
$('refreshButton').addEventListener('click', async () => { await refreshStatus(); await refreshProofs(); });
$('withdrawButton').addEventListener('click', withdraw);
window.ethereum?.on?.('accountsChanged', clearSession);
window.ethereum?.on?.('chainChanged', clearSession);
renderStatus(); refreshStatus();
