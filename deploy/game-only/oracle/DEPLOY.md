# CHOGPIT on Oracle Cloud Always Free — game only

**Target:** keep `https://chogpit.tech` playable through at least **2026-11-02 15:00 UTC** (ten days after the hackathon deadline). This is an operating goal, **not a 10-day uptime guarantee**: Oracle can reclaim an idle Always Free VM, the requested shape can be out of capacity, and networks or certificates can fail. Oracle's current Always Free Ampere allowance is 2 OCPUs / 12 GB RAM in the account's **home region**, plus a 200 GB combined block/boot-volume allowance [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm). Most sign-ups need a phone and card for identity verification; Oracle says the card is not charged unless the account is upgraded [Oracle Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm). Do **not** upgrade or select a paid image/resource to follow this guide. Check the estimate in your own console; availability and policy can change.

The VM runs **one** Node server with server-authoritative private PvP or co-op bot raids (five lives total per player), solo play and persistent NFT arena data on its boot volume. Caddy terminates HTTPS and proxies WebSockets. It is the **no-real-CHOG-payout** export; no claims or keys are involved. Unlike the Render Blueprint, this path needs **no Git repository**. You will still need an Oracle account and a computer from which you can transfer the ZIP with SSH. Never share your login, payment information, SSH private key or wallet seed.

## 1 — Create the VM in your own Oracle console

1. Sign up at [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/) if necessary. Choose the **home region** carefully; Always Free VMs must be in that region and capacity is not guaranteed. In **Compute → Instances → Create instance**, select **Ubuntu 24.04 ARM64 (aarch64)** and the **VM.Standard.A1.Flex / Always Free-eligible** shape, **1 OCPU and 6 GB RAM**, in the home region. Set a **50 GB boot volume**, within the free combined volume allowance. Before clicking Create, confirm the console's estimated charges and free eligibility; do not create a trial-only or paid VM. Oracle documents the A1 shape and public-IP setup [here](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm). If there is no A1 capacity, try another availability domain in the same home region or wait; **do not** silently substitute a paid shape.
2. Use a **public subnet and public IPv4**. Generate/download the SSH key through your own console and save the **private key only on your computer**. OCI's Ubuntu account name is `ubuntu` [Oracle images](https://docs.oracle.com/en-us/iaas/Content/Compute/References/images.htm).
3. In the VCN security list or attached network security group add **stateful inbound TCP 80 and 443 from `0.0.0.0/0`**. Limit SSH/TCP 22 to your own IP if practical. If the Ubuntu firewall is active, also allow 80/443 there. **Do not expose port 4173**: the game binds that port to `127.0.0.1`, behind Caddy. Oracle describes public-subnet and firewall rules [here](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/scenarioa.htm).

## 2 — Upload the reviewed ZIP and install

Download `CHOGPIT_Game_Only_Deploy.zip` from this workspace onto your own computer. Check its SHA-256 against the hash provided alongside the download. Do not upload `node_modules/`, the local `data/` testing folder, draft contracts or the parent project. On your computer (replace the angle-bracket placeholders **locally**):

```sh
scp -i /path/to/YOUR_PRIVATE_SSH_KEY CHOGPIT_Game_Only_Deploy.zip ubuntu@YOUR_VM_PUBLIC_IP:/home/ubuntu/
ssh -i /path/to/YOUR_PRIVATE_SSH_KEY ubuntu@YOUR_VM_PUBLIC_IP
```

On the **VM**, inspect the included `oracle/install-on-ubuntu.sh`, then run:

```sh
sudo apt-get update && sudo apt-get install -y unzip
unzip -q CHOGPIT_Game_Only_Deploy.zip
cd CHOGPIT_Game_Only_Deploy
sudo bash oracle/install-on-ubuntu.sh
```

The installer rejects the wrong architecture/OS and accidental reward-code uploads; verifies the checksum of the official **Node 22.22.0 ARM64** download against [Node's published SHA-256 list](https://nodejs.org/dist/v22.22.0/SHASUMS256.txt); installs production dependencies as an unprivileged `chogpit` user; and installs a `systemd` game service plus [Caddy's official signed package](https://caddyserver.com/docs/install). It runs the local HTTP/locked-claims/two-client-WebSocket smoke test. The game data lives at `/var/lib/chogpit/arenas.json`, not in the uploaded ZIP. Caddy automatically handles HTTPS and WebSocket upgrades once DNS and public ports work [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## 3 — Point the domain's DNS **after the VM starts**

Once `chogpit.tech` appears Active in your Get.Tech account, open DNS management at the domain's **current authoritative DNS provider** (Get.Tech until you change nameservers; Cloudflare if you have already delegated the domain there). Remove conflicting default parking/forwarding **root** A, ALIAS or AAAA records and add a **root/apex A record** pointing to `YOUR_VM_PUBLIC_IP`. Enter the root label exactly as your registrar specifies (often `@` or blank). Preserve unrelated MX/TXT records if you use domain email. Do not change nameservers or add a `www` record unless you also configure `www` in Caddy. A brand-new purchase may take time to appear in DNS. Wait for DNS, then Caddy's certificate [Caddy HTTPS](https://caddyserver.com/docs/automatic-https).

From **your own computer**, test `https://chogpit.tech/healthz`. It must return `"mode":"GAME_ONLY"` and `"rewardPayoutsEnabled":false`. For the full verification, in the unpacked ZIP folder run `npm ci --omit=dev` and then `npm run smoke -- https://chogpit.tech`, or ask for help reading the VM logs. The smoke opens two private WebSocket clients and checks locked reward endpoints. Also try a room in two browsers and inspect NFT arena changes.

## 4 — Keep it running and keep the data

- Check `https://chogpit.tech/healthz`, a real two-player room, and Oracle VM/usage alerts daily through **2026-11-02 15:00 UTC**. Do not fake resource activity to avoid Oracle's idle-reclamation rules; plan a fallback if it is reclaimed. Restarting/redeploying drops active matches because rooms are in memory.
- Back up `/var/lib/chogpit/arenas.json` **off the VM** after arena data exists, at least daily for the ten-day window. It contains recent player display names; keep copies private. One option on your computer: `ssh -i /path/to/YOUR_PRIVATE_SSH_KEY ubuntu@YOUR_VM_PUBLIC_IP 'sudo cat /var/lib/chogpit/arenas.json' > chogpit-arenas-backup.json`. A VM or boot volume can be lost. Backups and an independent uptime check are your responsibility.
- Troubleshoot on the VM with `sudo systemctl status chogpit caddy --no-pager` and `sudo journalctl -u chogpit -u caddy -n 80 --no-pager`. `curl http://127.0.0.1:4173/healthz` tests Node locally; failure over HTTPS with local health working usually means DNS, firewall or certificate setup.
- Before updating or reinstalling, make a backup and schedule downtime outside active rooms. Keep Ubuntu, Node, Caddy and npm dependencies updated after testing; the pinned Node release is a starting snapshot, not an automatic security-update service. The Caddy package renews TLS automatically; it needs working DNS and public 80/443 access.

**No CHOG or MON needs to be sent anywhere. Real claims remain disabled.**
