// Separate owner preview, not the wallet-free public game's /claim.html.
// The default (unconfigured) page never imports the Privy SDK.
const headline = document.getElementById('wallet-title');
const details = document.getElementById('wallet-message');
const providerState = document.getElementById('provider-state');

function setState(title, detail) {
  headline.textContent = title;
  details.textContent = detail;
}

try {
  const response = await fetch('/api/pass-portal/status', { cache: 'no-store' });
  const config = await response.json();
  if (!response.ok) throw Error(config.error || 'Preview service unavailable.');
  if (config.registrationReady && config.publicAppId) {
    providerState.textContent = 'OWNER PREVIEW READY';
    setState('START EMAIL SIGN-UP',
      'Enter your email. Privy may request an email code, then automatically provisions your user-controlled EVM wallet. No external wallet connection, signup signature, NFT mint or payment.');
    const { mountPrivyEmailFlow } = await import('/vendor/provider.js');
    mountPrivyEmailFlow(config);
  } else {
    providerState.textContent = 'SETUP PENDING';
    setState('EMAIL SIGN-UP PENDING', config.message || 'Owner Privy app is not configured. No NFT can be claimed.');
  }
} catch (error) {
  providerState.textContent = 'SETUP PENDING';
  setState('EMAIL SIGN-UP PENDING',
    `Owner preview signup is unavailable. ${error?.message || 'Try later.'} Guests can still raid without a wallet.`);
}
// There is deliberately no API call here to mint or pay CHOG.
