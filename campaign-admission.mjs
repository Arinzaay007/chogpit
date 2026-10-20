// Candidate production admission boundary — NOT mounted by the hosted game.
// A passkey is an account credential, not proof of one human. This module
// requires a separately reviewed verifier, exact UTC window, confidential
// HMAC key, independently approved deployed-code hash and confirmed on-chain
// slot snapshot. Without ALL of them openings fail closed. It does not itself
// certify that a verifier or rules are lawful, audited or running in prod.
import { createHash, createHmac } from 'node:crypto';
import { getAddress, keccak256, parseAbi } from 'viem';

const TOKEN = getAddress('0x350035555e10d9afaf1566aaebfced5ba6c27777');
const H32 = /^0x[a-fA-F0-9]{64}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const abi = parseAbi([
  'function chog() view returns (address)',
  'function currentEpochId() view returns (uint256)',
  'function epochs(uint256) view returns (uint256 budget,uint256 awarded,uint256 reserved,uint256 pendingCapacity,uint32 purchasedSlots,bool closed)',
  'function newBatchesPaused() view returns (bool)',
  'function outstandingCredits() view returns (uint256)',
  'function totalReserved() view returns (uint256)',
  'function totalPendingCapacity() view returns (uint256)'
]);
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const sha = text => createHash('sha256').update(text).digest('hex');

export class ReviewedAdmissionCandidate {
  constructor(intake, { publicClient, expectedRuntimeCodeHash, startAt, endAt,
    verificationProvider, verificationIssuer, personHmacKey, confirmationDepth = 12,
    snapshotMaxAgeMs = 5000, now = () => Date.now(), allowMockToken = false } = {}) {
    if (!intake?.db || !publicClient?.getBlock || !publicClient?.readContract ||
      !H32.test(expectedRuntimeCodeHash) || /^0x0{64}$/i.test(expectedRuntimeCodeHash) ||
      !Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt <= startAt ||
      !Number.isSafeInteger(confirmationDepth) || confirmationDepth < 1 || confirmationDepth > 128 ||
      !Number.isSafeInteger(snapshotMaxAgeMs) || snapshotMaxAgeMs < 1000 || snapshotMaxAgeMs > 60000 ||
      typeof verificationProvider?.verify !== 'function' ||
      typeof verificationIssuer !== 'string' || verificationIssuer.length < 4 ||
      !Buffer.isBuffer(personHmacKey) || personHmacKey.length < 32 ||
      (!allowMockToken && intake.token.toLowerCase() !== TOKEN.toLowerCase()))
      throw new Error('Admission requires a reviewed code hash, exact UTC window, funded-chain reader, independent person verifier and secure HMAC key.');
    this.intake = intake; this.db = intake.db; this.rpc = publicClient;
    this.codeHash = expectedRuntimeCodeHash.toLowerCase();
    this.startAt = startAt; this.endAt = endAt; this.verifier = verificationProvider;
    this.issuer = verificationIssuer; this.key = personHmacKey;
    this.depth = confirmationDepth; this.maxAge = snapshotMaxAgeMs; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS reviewed_admission_config(
        campaign_id TEXT PRIMARY KEY, vault TEXT NOT NULL, rules_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
        issuer TEXT NOT NULL, confirmation_depth INTEGER NOT NULL,
        halted INTEGER NOT NULL DEFAULT 0 CHECK(halted IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS reviewed_capacity_snapshots(
        epoch_id INTEGER NOT NULL, block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL, purchased_slots INTEGER NOT NULL,
        pending_capacity TEXT NOT NULL, vault_balance TEXT NOT NULL,
        verified_at INTEGER NOT NULL, PRIMARY KEY(epoch_id,block_number)
      );
      CREATE INDEX IF NOT EXISTS idx_reviewed_snapshot_recent
        ON reviewed_capacity_snapshots(verified_at DESC,block_number DESC);
      CREATE TABLE IF NOT EXISTS reviewed_persons(
        account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
        person_tag TEXT NOT NULL, issuer TEXT NOT NULL,
        evidence_hash TEXT NOT NULL UNIQUE,
        verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviewed_person_tag ON reviewed_persons(person_tag);
    `);
    const existing = this.db.prepare('SELECT * FROM reviewed_admission_config').all();
    const config = [intake.campaignId, intake.vault.toLowerCase(), intake.rulesHash,
      this.codeHash,startAt,endAt,this.issuer,this.depth];
    if (!existing.length) this.db.prepare(`INSERT INTO reviewed_admission_config
      (campaign_id,vault,rules_hash,code_hash,start_at,end_at,issuer,confirmation_depth)
      VALUES(?,?,?,?,?,?,?,?)`).run(...config);
    else if (existing.length !== 1 ||
      [existing[0].campaign_id,existing[0].vault,existing[0].rules_hash,
        existing[0].code_hash,existing[0].start_at,existing[0].end_at,
        existing[0].issuer,existing[0].confirmation_depth]
        .some((value,i)=>value!==config[i]))
      throw new Error('Admission config changed; do not reuse this campaign journal.');
  }
  #halted() {
    return this.db.prepare('SELECT halted FROM reviewed_admission_config').get()?.halted === 1;
  }
  #halt(reason) {
    this.db.prepare('UPDATE reviewed_admission_config SET halted=1').run();
    throw new Error(`Admission halted: ${reason}. Independent recovery is required.`);
  }
  #recent() {
    if (this.#halted()) throw new Error('Admission halted; independent recovery is required.');
    const row = this.db.prepare(`SELECT * FROM reviewed_capacity_snapshots
      ORDER BY verified_at DESC,block_number DESC LIMIT 1`).get();
    if (!row || this.now()-row.verified_at < 0 || this.now()-row.verified_at > this.maxAge)
      throw new Error('No recent confirmed, funded on-chain capacity snapshot.');
    return row;
  }
  currentEpochId() { return this.#recent().epoch_id; }
  maxOpeningsForEpoch(epochId) {
    const snapshot = this.#recent();
    return epochId === snapshot.epoch_id ? snapshot.purchased_slots : 0;
  }
  canOpen(event, db = this.db) {
    const time=this.now();
    if (time < this.startAt || time >= this.endAt || !event ||
      !Number.isSafeInteger(event.openedAt) ||
      Math.abs(event.openedAt-time)>1000 ||
      event.openedAt < this.startAt || event.openedAt >= this.endAt ||
      !ACCOUNT.test(event.accountId)) return false;
    const snapshot=this.#recent();
    if (snapshot.epoch_id !== event.epochId ||
      event.priorEpochEvents >= snapshot.purchased_slots) return false;
    const person=db.prepare(`SELECT person_tag,expires_at FROM reviewed_persons
      WHERE account_id=?`).get(event.accountId);
    if (!person || person.expires_at <= time) return false;
    const prior=db.prepare(`SELECT COUNT(*) AS n FROM openings o
      JOIN reviewed_persons p ON p.account_id=o.account_id
      WHERE p.person_tag=?`).get(person.person_tag).n;
    return prior < 2;
  }
  async verifyPerson(session, passkeyAccounts, assertion) {
    if (this.#halted()) throw new Error('Admission halted.');
    const accountId=passkeyAccounts.account(session).accountId;
    // The provider must perform real free age/location/unique-person checks.
    // Its implementation and evidence format are intentionally NOT invented.
    const verdict=await this.verifier.verify({accountId, assertion,
      campaignId:this.intake.campaignId, rulesHash:this.intake.rulesHash});
    const time=this.now();
    if (!verdict || verdict.issuer!==this.issuer || verdict.adult!==true ||
      verdict.eligibleJurisdiction!==true ||
      typeof verdict.stablePersonId!=='string' ||
      verdict.stablePersonId.length<8 || verdict.stablePersonId.length>512 ||
      typeof verdict.evidenceId!=='string' || verdict.evidenceId.length<8 ||
      verdict.evidenceId.length>512 || !Number.isSafeInteger(verdict.expiresAt) ||
      verdict.expiresAt<=time || verdict.expiresAt>time+366*24*3600*1000)
      throw new Error('Independent adult/location/unique-person verification failed.');
    const personTag=createHmac('sha256',this.key)
      .update(`CHOGPIT_PERSON_V1\n${this.intake.campaignId}\n${this.issuer}\n${verdict.stablePersonId}`)
      .digest('hex');
    const evidenceHash=sha(`CHOGPIT_EVIDENCE_V1\n${this.issuer}\n${verdict.evidenceId}`);
    this.db.transaction(()=>{
      const old=this.db.prepare('SELECT person_tag FROM reviewed_persons WHERE account_id=?')
        .get(accountId);
      if(old && old.person_tag!==personTag)
        throw new Error('An account cannot switch verified persons.');
      if(this.db.prepare('SELECT 1 FROM reviewed_persons WHERE evidence_hash=?').get(evidenceHash))
        throw new Error('Verifier evidence was already used.');
      this.db.prepare(`INSERT INTO reviewed_persons
        (account_id,person_tag,issuer,evidence_hash,verified_at,expires_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
        evidence_hash=excluded.evidence_hash,verified_at=excluded.verified_at,
        expires_at=excluded.expires_at`).run(accountId,personTag,this.issuer,
          evidenceHash,time,verdict.expiresAt);
    })();
    return {accountId,verified:true,expiresAt:verdict.expiresAt,
      note:'No raw identity or provider person ID was stored.'};
  }
  async refreshConfirmedCapacity() {
    if(this.#halted()) throw new Error('Admission halted; independent recovery is required.');
    if(await this.rpc.getChainId()!==143) this.#halt('wrong chain');
    const head=await this.rpc.getBlockNumber();
    if(head<BigInt(this.depth)) throw new Error('Wait for confirmed vault blocks.');
    const number=head-BigInt(this.depth);
    const previous=this.db.prepare(`SELECT * FROM reviewed_capacity_snapshots
      ORDER BY verified_at DESC,block_number DESC LIMIT 1`).get();
    if(previous){
      const oldBlock=await this.rpc.getBlock({blockNumber:BigInt(previous.block_number)});
      if(oldBlock.hash?.toLowerCase()!==previous.block_hash) this.#halt('confirmed chain history changed');
      if(number<BigInt(previous.block_number)) this.#halt('confirmed block height moved backward');
    }
    const block=await this.rpc.getBlock({blockNumber:number});
    if(!H32.test(block.hash)||block.number!==number)
      throw new Error('RPC did not return a consistent confirmed block.');
    const code=await this.rpc.getBytecode({address:this.intake.vault,blockNumber:number});
    if(!code||keccak256(code).toLowerCase()!==this.codeHash)
      this.#halt('deployed runtime code differs from independently approved hash');
    const read=(functionName,args=[],address=this.intake.vault,contractAbi=abi)=>
      this.rpc.readContract({address,abi:contractAbi,functionName,args,blockNumber:number});
    const [token,epochBig,paused,outstanding,reserved,pending]=await Promise.all([
      read('chog'),read('currentEpochId'),read('newBatchesPaused'),
      read('outstandingCredits'),read('totalReserved'),read('totalPendingCapacity')
    ]);
    if(getAddress(token).toLowerCase()!==this.intake.token.toLowerCase())
      this.#halt('vault token differs from campaign rules');
    if(epochBig>BigInt(Number.MAX_SAFE_INTEGER)) this.#halt('epoch ID is unsafe');
    const epochId=Number(epochBig);
    const [epoch,balance]=await Promise.all([
      read('epochs',[epochBig]),read('balanceOf',[this.intake.vault],
        this.intake.token,tokenAbi)
    ]);
    if(epoch[0]===0n || epoch[0]>1000n*10n**18n ||
      (epochId===0 && (epoch[0]!==1000n*10n**18n || balance<1000n*10n**18n)) ||
      epoch[4]>40 || epoch[3]>BigInt(epoch[4])*25n*10n**18n ||
      balance<outstanding+reserved+pending)
      this.#halt('funding or purchased-slot invariant failed');
    if(previous && (epochId<previous.epoch_id ||
      epochId===previous.epoch_id && Number(epoch[4])<previous.purchased_slots))
      this.#halt('epoch or purchased slots decreased');
    // A newly closed or paused epoch must not accept an opening, even if a
    // prior snapshot still had free slots. The next refresh fails closed.
    const [latestPaused,latestEpochId,latestEpoch]=await Promise.all([
      this.rpc.readContract({address:this.intake.vault,abi,functionName:'newBatchesPaused'}),
      this.rpc.readContract({address:this.intake.vault,abi,functionName:'currentEpochId'}),
      this.rpc.readContract({address:this.intake.vault,abi,functionName:'epochs',args:[epochBig]})
    ]);
    if(paused||epoch[5]||latestPaused||latestEpoch[5]||latestEpochId!==epochBig)
      throw new Error('New opening admission is paused, stale, or the epoch is closed.');
    const snapshot={epochId,blockNumber:Number(number),blockHash:block.hash.toLowerCase(),
      purchasedSlots:Number(epoch[4]),pendingCapacity:epoch[3].toString(),
      vaultBalance:balance.toString(),verifiedAt:this.now()};
    this.db.prepare(`INSERT INTO reviewed_capacity_snapshots
      (epoch_id,block_number,block_hash,purchased_slots,pending_capacity,vault_balance,verified_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(epoch_id,block_number) DO UPDATE SET
      verified_at=excluded.verified_at`).run(snapshot.epochId,snapshot.blockNumber,
        snapshot.blockHash,snapshot.purchasedSlots,snapshot.pendingCapacity,
        snapshot.vaultBalance,snapshot.verifiedAt);
    return snapshot;
  }
}
