// Isolated owner-preview signup ONLY. Privy's EMAIL-ONLY login modal triggers
// its documented createOnLogin behavior; whitelabel loginWithCode would NOT.
// No external-wallet connector, signature, transaction or mint is invoked.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, getIdentityToken, useLogin, usePrivy, useUser, useWallets } from '@privy-io/react-auth';
import { monad } from 'viem/chains';

function setState(title, detail) {
  document.getElementById('wallet-title').textContent = title;
  document.getElementById('wallet-message').textContent = detail;
}

async function register(identityToken, emailHint, address) {
  const response = await fetch('/api/pass-portal/register', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identityToken}` },
    body: JSON.stringify({ emailHint, address })
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Preview sign-up could not be verified.');
  if (result.state !== 'REGISTERED_NO_NFT' || !result.address || result.claimEnabled)
    throw Error('The local account binding could not be confirmed. No NFT was minted.');
  return result;
}

function EmailSignup() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { refreshUser } = useUser();
  const [email, setEmail] = useState('');
  const [requestedEmail, setRequestedEmail] = useState(null);
  const inflight = useRef(null);
  const { login } = useLogin({
    onError: error => {
      setRequestedEmail(null);
      setState('SIGN-UP NOT COMPLETED',
        `Privy email verification did not finish. ${error?.message || 'Try again.'} No NFT was minted.`);
    }
  });
  const normalizedUserEmail = typeof user?.email?.address === 'string'
    ? user.email.address.trim().toLowerCase() : '';
  // useWallets lists connected EVM wallets; only the Privy-owned embedded
  // wallet may be bound. The server also independently requires this address
  // in Privy's signed linked_accounts identity-token claim.
  const embedded = wallets.filter(wallet => wallet.walletClientType === 'privy');
  const walletKey = embedded.map(wallet => wallet.address).join('|');

  useEffect(() => {
    if (!requestedEmail || !authenticated || !ready || !user || !walletsReady) return;
    if (normalizedUserEmail !== requestedEmail) {
      setRequestedEmail(null);
      setState('WRONG EMAIL ACCOUNT', 'This Privy session uses another email. Sign out below and try the email you entered. No NFT was minted.');
      return;
    }
    if (embedded.length !== 1) {
      if (embedded.length > 1) {
        setRequestedEmail(null);
        setState('WALLET REVIEW NEEDED', 'More than one Privy EVM wallet is linked. Registration is paused for manual review; no NFT was minted.');
      } else {
        setState('SETTING UP YOUR WALLET', 'Privy is provisioning your user-controlled EVM wallet after email verification. Do not connect another wallet.');
      }
      return;
    }
    if (inflight.current === requestedEmail) return;
    inflight.current = requestedEmail;
    const address = embedded[0].address;
    (async () => {
      try {
        // Wallet creation can complete after the initial login token. Force a
        // refreshed signed identity so linked_accounts includes the wallet.
        await refreshUser();
        const idToken = await getIdentityToken();
        if (!idToken) throw Error('The signed Privy identity token is unavailable. Enable it in the owner dashboard.');
        const result = await register(idToken, requestedEmail, address);
        const h = result.hero;
        setState(h ? `HERO READY · ${h.body} #${h.background.slice(0,4).toUpperCase()}` : 'ACCOUNT READY · NO NFT',
          h ? `Your random CHOG-inspired hero: ${h.body} / ${h.eyes} / ${h.aura} on ${h.background} — color ${h.color}. Wallet: ${result.address}. No mint needed.` : `Privy set up your user-controlled wallet: ${result.address}. You did not connect or sign a wallet. No NFT, pass reservation or CHOG reward was issued.`);
      } catch (error) {
        setState('SIGN-UP NOT COMPLETED',
          `${error?.message || 'Unable to confirm the email and wallet.'} No NFT was minted. Check the owner preview settings and retry.`);
      } finally {
        inflight.current = null;
        setRequestedEmail(null);
      }
    })();
    // React session refresh may rerender, but inflight guards duplicate POSTs.
  }, [requestedEmail, authenticated, ready, user?.id, normalizedUserEmail, walletsReady, walletKey, refreshUser]);

  useEffect(() => {
    if (!requestedEmail || !authenticated || !walletsReady || embedded.length) return;
    const timeout = setTimeout(() => {
      setRequestedEmail(null);
      setState('WALLET NOT CONFIRMED',
        'Privy did not report an embedded EVM wallet yet. Confirm automatic wallet creation in the owner dashboard, then retry. No NFT was minted.');
    }, 45000);
    return () => clearTimeout(timeout);
  }, [requestedEmail, authenticated, walletsReady, walletKey]);

  function onSubmit(event) {
    event.preventDefault();
    if (!ready || requestedEmail || inflight.current) return;
    const hint = email.trim().toLowerCase();
    if (!hint || hint.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint)) {
      event.currentTarget.reportValidity();
      return;
    }
    if (authenticated && normalizedUserEmail !== hint) {
      setState('SWITCH EMAIL ACCOUNT', 'Sign out of the previous Privy email session below, then register with the email you entered.');
      return;
    }
    setRequestedEmail(hint);
    setState('VERIFY YOUR EMAIL', 'Privy may ask for an emailed code. Its email-only login modal then sets up your wallet automatically; no external wallet or registration signature.');
    if (!authenticated) {
      // The MODAL is important: createOnLogin does NOT apply to the whitelabel
      // useLoginWithEmail()/loginWithCode() flow.
      login({ loginMethods: ['email'], prefill: { type: 'email', value: hint },
        walletChainType: 'ethereum-only' });
    }
  }

  return <>
    <form id="signup-form" className="signup-form" onSubmit={onSubmit}>
      <label htmlFor="signup-email">YOUR EMAIL ADDRESS</label>
      <input id="signup-email" name="email" type="email" autoComplete="email" placeholder="you@example.com"
        maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} disabled={!ready || !!requestedEmail} />
      <button id="register" className="btn btn-primary" type="submit" disabled={!ready || !!requestedEmail}>
        {requestedEmail ? 'CHECKING EMAIL / WALLET…' : 'REGISTER WITH EMAIL ↗'}
      </button>
    </form>
    {ready && authenticated && <button id="sign-out" className="session-exit" type="button"
      onClick={async () => { setRequestedEmail(null); await logout(); setState('SIGNED OUT', 'You can try another email. The public game remains wallet-free.'); }}>
      SIGN OUT OF THIS EMAIL SESSION
    </button>}
  </>;
}

export function mountPrivyEmailFlow(config) {
  if (!config?.registrationReady || !config.publicAppId)
    throw Error('Owner Privy app is not configured for preview signup.');
  const root = document.getElementById('signup-mount');
  if (!root) throw Error('The email signup form is missing.');
  createRoot(root).render(
    <PrivyProvider appId={config.publicAppId} config={{
      loginMethods: ['email'],
      embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
      defaultChain: monad, supportedChains: [monad],
      appearance: { theme: 'dark', accentColor: '#c4fa76' }
    }}>
      <EmailSignup />
    </PrivyProvider>
  );
}
