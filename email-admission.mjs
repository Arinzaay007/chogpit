// Isolated proposed EMAIL-only admission. No person, age, residency or
// jurisdiction attestation is performed. Capacity still requires a confirmed
// independently checked vault bytecode hash, 1,000 CHOG initial funding, up
// to 40 backed 25-CHOG slots, and an exact UTC window. This is a candidate,
// NOT an approval of public token giveaways or a deployed payout service.
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

export class EmailAdmissionCandidate {
  constructor(intake, { publicClient, expectedRuntimeCodeHash, startAt, endAt,
    confirmationDepth = 12, snapshotMaxAgeMs = 5000,
    now = () => Date.now(), allowMockToken = false } = {}) {
    if (intake?.accountMethod !== 'email' || !intake?.db
      || !publicClient?.getBlock || !publicClient?.readContract
      || !H32.test(expectedRuntimeCodeHash) || /^0x0{64}$/i.test(expectedRuntimeCodeHash)
      || !Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt <= startAt
      || !Number.isSafeInteger(confirmationDepth) || confirmationDepth < 1 || confirmationDepth > 128
      || !Number.isSafeInteger(snapshotMaxAgeMs) || snapshotMaxAgeMs < 1000 || snapshotMaxAgeMs > 60000
      || !allowMockToken && intake.token.toLowerCase() !== TOKEN.toLowerCase())
      throw new Error('Email admission needs an exact UTC window, confirmed funded-chain reader and reviewed runtime hash.');
    this.intake=intake;this.db=intake.db;this.rpc=publicClient;
    this.codeHash=expectedRuntimeCodeHash.toLowerCase();
    this.startAt=startAt;this.endAt=endAt;this.depth=confirmationDepth;
    this.maxAge=snapshotMaxAgeMs;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS email_admission_config(
        campaign_id TEXT PRIMARY KEY, vault TEXT NOT NULL, token TEXT NOT NULL,
        rules_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
        start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
        confirmation_depth INTEGER NOT NULL, halted INTEGER NOT NULL DEFAULT 0 CHECK(halted IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS email_capacity_snapshots(
        epoch_id INTEGER NOT NULL, block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL, purchased_slots INTEGER NOT NULL,
        pending_capacity TEXT NOT NULL, vault_balance TEXT NOT NULL,
        verified_at INTEGER NOT NULL, PRIMARY KEY(epoch_id,block_number)
      );
      CREATE INDEX IF NOT EXISTS idx_email_snapshots_recent
        ON email_capacity_snapshots(verified_at DESC,block_number DESC);
    `);
    const values=[intake.campaignId,intake.vault.toLowerCase(),intake.token.toLowerCase(),
      intake.rulesHash,this.codeHash,startAt,endAt,confirmationDepth];
    const existing=this.db.prepare('SELECT * FROM email_admission_config').all();
    if (!existing.length) this.db.prepare(`INSERT INTO email_admission_config
      (campaign_id,vault,token,rules_hash,code_hash,start_at,end_at,confirmation_depth)
      VALUES(?,?,?,?,?,?,?,?)`).run(...values);
    else if (existing.length !== 1 || [existing[0].campaign_id,existing[0].vault,
      existing[0].token,existing[0].rules_hash,existing[0].code_hash,
      existing[0].start_at,existing[0].end_at,existing[0].confirmation_depth]
      .some((value,i)=>value!==values[i]))
      throw new Error('Email admission settings changed; start a fresh campaign journal.');
  }
  #halted() {
    return this.db.prepare('SELECT halted FROM email_admission_config').get()?.halted===1;
  }
  #halt(reason) {
    this.db.prepare('UPDATE email_admission_config SET halted=1').run();
    throw new Error(`Email admission halted: ${reason}. Independent investigation required.`);
  }
  #recent() {
    if (this.#halted()) throw new Error('Email admission halted.');
    const row=this.db.prepare(`SELECT * FROM email_capacity_snapshots
      ORDER BY verified_at DESC,block_number DESC LIMIT 1`).get();
    const age=row && this.now()-row.verified_at;
    if (!row || age < 0 || age > this.maxAge)
      throw new Error('No recent confirmed, funded vault capacity snapshot.');
    return row;
  }
  currentEpochId() { return this.#recent().epoch_id; }
  maxOpeningsForEpoch(epochId) {
    const row=this.#recent();
    return row.epoch_id===epochId ? row.purchased_slots : 0;
  }
  canOpen(event, db=this.db) {
    const time=this.now();
    if (time < this.startAt || time >= this.endAt || !event
      || !ACCOUNT.test(event.accountId) || !Number.isSafeInteger(event.openedAt)
      || Math.abs(event.openedAt-time)>1000
      || event.openedAt < this.startAt || event.openedAt >= this.endAt)
      return false;
    const snapshot=this.#recent();
    if (snapshot.epoch_id!==event.epochId || event.priorEpochEvents>=snapshot.purchased_slots
      || !Number.isSafeInteger(event.priorEvents) || event.priorEvents>=40)
      return false;
    // No person graph: one normalized inbox is one account. Distinct emails
    // may belong to the same human and can each use TWO of the 40 slots.
    const identity=db.prepare(`SELECT normalized_email FROM email_identities
      WHERE account_id=? AND verified_at>0`).get(event.accountId);
    if (!identity) return false;
    const prior=db.prepare(`SELECT COUNT(*) AS n FROM openings o
      JOIN email_identities e ON e.account_id=o.account_id
      WHERE e.normalized_email=?`).get(identity.normalized_email).n;
    return prior < 2;
  }
  async refreshConfirmedCapacity() {
    if (this.#halted()) throw new Error('Email admission halted.');
    if (await this.rpc.getChainId()!==143) this.#halt('wrong chain');
    const head=await this.rpc.getBlockNumber();
    if (head<BigInt(this.depth)) throw new Error('Wait for confirmed vault blocks.');
    const number=head-BigInt(this.depth);
    const previous=this.db.prepare(`SELECT * FROM email_capacity_snapshots
      ORDER BY verified_at DESC,block_number DESC LIMIT 1`).get();
    if (previous) {
      const old=await this.rpc.getBlock({blockNumber:BigInt(previous.block_number)});
      if (old.hash?.toLowerCase()!==previous.block_hash)
        this.#halt('confirmed block history changed');
      if (number<BigInt(previous.block_number)) this.#halt('confirmed height moved backward');
    }
    const block=await this.rpc.getBlock({blockNumber:number});
    if (!H32.test(block.hash) || block.number!==number)
      throw new Error('RPC returned an inconsistent confirmed block.');
    const code=await this.rpc.getBytecode({address:this.intake.vault,blockNumber:number});
    if (!code || keccak256(code).toLowerCase()!==this.codeHash)
      this.#halt('vault runtime differs from reviewed hash');
    const read=(functionName,args=[],address=this.intake.vault,contractAbi=abi)=>
      this.rpc.readContract({address,abi:contractAbi,functionName,args,blockNumber:number});
    const [token,epochBig,paused,outstanding,reserved,pending]=await Promise.all([
      read('chog'),read('currentEpochId'),read('newBatchesPaused'),
      read('outstandingCredits'),read('totalReserved'),read('totalPendingCapacity')
    ]);
    if (getAddress(token).toLowerCase()!==this.intake.token.toLowerCase())
      this.#halt('vault token differs from campaign');
    if (epochBig>BigInt(Number.MAX_SAFE_INTEGER)) this.#halt('epoch ID unsafe');
    const epochId=Number(epochBig);
    const [epoch,balance]=await Promise.all([
      read('epochs',[epochBig]),read('balanceOf',[this.intake.vault],this.intake.token,tokenAbi)
    ]);
    if (epoch[0]===0n || epoch[0]>1000n*10n**18n ||
      epochId===0 && (epoch[0]!==1000n*10n**18n || balance<1000n*10n**18n)
      || epoch[4]>40 || epoch[3]>BigInt(epoch[4])*25n*10n**18n
      || balance<outstanding+reserved+pending)
      this.#halt('funding or purchased-slot invariant failed');
    if (previous && (epochId<previous.epoch_id ||
      epochId===previous.epoch_id && Number(epoch[4])<previous.purchased_slots))
      this.#halt('epoch or purchased slots decreased');
    const [latestPaused,latestEpoch,latestState]=await Promise.all([
      this.rpc.readContract({address:this.intake.vault,abi,functionName:'newBatchesPaused'}),
      this.rpc.readContract({address:this.intake.vault,abi,functionName:'currentEpochId'}),
      this.rpc.readContract({address:this.intake.vault,abi,functionName:'epochs',args:[epochBig]})
    ]);
    if (paused || epoch[5] || latestPaused || latestState[5] || latestEpoch!==epochBig)
      throw new Error('Opening admission paused, stale, or closed.');
    const snapshot={epochId,blockNumber:Number(number),blockHash:block.hash.toLowerCase(),
      purchasedSlots:Number(epoch[4]),pendingCapacity:epoch[3].toString(),
      vaultBalance:balance.toString(),verifiedAt:this.now()};
    this.db.prepare(`INSERT INTO email_capacity_snapshots
      (epoch_id,block_number,block_hash,purchased_slots,pending_capacity,vault_balance,verified_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(epoch_id,block_number) DO UPDATE SET
      verified_at=excluded.verified_at`).run(snapshot.epochId,snapshot.blockNumber,
        snapshot.blockHash,snapshot.purchasedSlots,snapshot.pendingCapacity,
        snapshot.vaultBalance,snapshot.verifiedAt);
    return snapshot;
  }
}
