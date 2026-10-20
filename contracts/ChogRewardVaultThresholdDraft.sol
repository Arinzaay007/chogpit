// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CHOGPIT threshold-and-carry vault — UNREVIEWED DESIGN, NOT DEPLOYED.
 *
 * A box earns 5/10/25 CHOG with 70/25/5 odds from a precommitted Merkle batch
 * and one Pyth Entropy seed. Credits below 50 CHOG remain reserved for the
 * recipient across owner-funded epochs in THIS SAME VAULT. A permissionless
 * redeem automatically transfers the ENTIRE accumulated balance once it
 * reaches 50 CHOG; a gas sponsor may submit it. The only sub-50 payout is an
 * owner-signed final settlement to that same recipient while batches are
 * paused. No arbitrary withdrawal, recipient change or owner sweep exists.
 *
 * Before opening, an owner-signed operator transaction purchases a 25-CHOG
 * worst-case slot; an unaddressed opening stays OFF-CHAIN but its slot stays
 * ring-fenced ON-CHAIN in its original epoch. That epoch may close to NEW
 * openings while remaining available to batch the already-backed late event.
 * The server MUST durably enforce that the count of admitted events never
 * exceeds the purchased on-chain slots. Timing and proof for final close-out,
 * callback failures, abandoned proofs and unused CHOG require reviewed rules.
 * Do not deploy or transfer real CHOG to this draft.
 */
interface IChogThresholdToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}
interface IThresholdEntropyV2 {
    function getFeeV2(address provider, uint32 gasLimit) external view returns (uint128);
    function requestV2(address provider, bytes32 userRandomNumber, uint32 gasLimit)
        external payable returns (uint64);
}

contract ChogRewardVaultThresholdDraft {
    uint256 public constant MAX_EPOCH_BUDGET = 1_000 ether;
    uint256 public constant MAX_BOX = 25 ether;
    uint256 public constant PAYOUT_THRESHOLD = 50 ether;
    uint32 public constant MAX_ENTRIES_PER_BATCH = 40;
    uint256 private constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "BatchPermit(uint256 epochId,uint256 batchId,bytes32 root,uint32 entries,bytes32 userRandomNumber,uint256 deadline)");
    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "FinalSettlement(address recipient,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 private constant CAPACITY_TYPEHASH = keccak256(
        "CapacityPermit(uint256 epochId,uint32 slots,uint256 nonce,uint256 deadline)");

    address public immutable owner;
    address public immutable batchOperator; // separate owner-authorized, sponsor-funded publisher
    IChogThresholdToken public immutable chog;
    IThresholdEntropyV2 public immutable entropy;
    address public immutable provider;
    bool public newBatchesPaused = true;
    bool private transferring;

    struct Epoch {
        uint256 budget;
        uint256 awarded;
        uint256 reserved; // on-chain Merkle proofs not yet redeemed
        uint256 pendingCapacity; // backed slots for address-unconfirmed/unpublished openings
        uint32 purchasedSlots; // lifetime admission limit for this funded epoch
        bool closed; // stops buying NEW slots, not publication of already-backed openings
    }
    struct Batch {
        uint256 epochId;
        bytes32 root;
        bytes32 seed;
        uint64 sequence;
        uint32 entries;
        uint32 redeemedCount;
        bool seeded;
    }
    uint256 public currentEpochId;
    uint256 public nextEpochId;
    uint256 public nextBatchId;
    uint256 public totalReserved;
    uint256 public totalPendingCapacity;
    uint256 public capacityPermitNonce;
    uint256 public outstandingCredits;
    uint256 public totalPaidOut;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => Batch) public batches;
    mapping(uint64 => uint256) private batchForSequencePlusOne;
    mapping(uint256 => mapping(uint256 => bool)) public redeemed;
    mapping(bytes32 => bool) public usedGameEvent;
    mapping(address => uint256) public creditOf;
    mapping(address => uint256) public settlementNonces;

    event EpochOpened(uint256 indexed epochId, uint256 budget);
    event EpochClosed(uint256 indexed epochId);
    event CapacityPurchased(uint256 indexed epochId, uint32 slots, uint32 purchasedSlots,
        uint256 totalPendingCapacity, address indexed gasSponsor);
    event NewBatchesPaused(bool paused);
    event BatchCommitted(uint256 indexed epochId, uint256 indexed batchId, bytes32 root, uint32 entries, uint64 sequence);
    event BatchSeeded(uint256 indexed batchId, uint64 sequence, bytes32 seed);
    event BoxCredited(uint256 indexed epochId, uint256 indexed batchId, uint256 index, bytes32 eventId, address indexed recipient, uint256 amount, uint256 runningCredit);
    event AutoPaid(address indexed recipient, uint256 amount, address indexed gasSponsor);
    event FinalSettled(address indexed recipient, uint256 amount, address indexed gasSponsor);

    error NotOwner();
    error NotBatchOperator();
    error Paused();
    error Invalid();
    error PoolExceeded();
    error InsufficientFunding();
    error NotReady();
    error AlreadyUsed();
    error BadProof();
    error TransferFailed();
    error Reentrant();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyBatchOperator() {
        if (msg.sender != batchOperator && msg.sender != owner) revert NotBatchOperator();
        _;
    }

    constructor(address owner_, address batchOperator_, address chog_, address entropy_, address provider_) {
        if (owner_ == address(0) || batchOperator_ == address(0) || owner_ == batchOperator_
            || chog_ == address(0) || entropy_ == address(0) || provider_ == address(0)) revert Invalid();
        owner = owner_;
        batchOperator = batchOperator_;
        chog = IChogThresholdToken(chog_);
        entropy = IThresholdEntropyV2(entropy_);
        provider = provider_;
        epochs[0] = Epoch({ budget: MAX_EPOCH_BUDGET, awarded: 0, reserved: 0,
            pendingCapacity: 0, purchasedSlots: 0, closed: false });
        nextEpochId = 1;
        emit EpochOpened(0, MAX_EPOCH_BUDGET);
    }

    function setNewBatchesPaused(bool paused) external onlyOwner {
        newBatchesPaused = paused;
        emit NewBatchesPaused(paused);
    }
    function currentEntropyFee() external view returns (uint256) {
        return entropy.getFeeV2(provider, 0);
    }

    // Closing an epoch stops buying NEW opening slots, not publication of its
    // already ring-fenced late openings, redemption or automatic payouts.
    // Small credits stay in this vault.
    function closeCurrentEpoch() external onlyOwner {
        Epoch storage epoch = epochs[currentEpochId];
        if (epoch.closed) revert Invalid();
        epoch.closed = true;
        emit EpochClosed(currentEpochId);
    }

    // Future epochs need an explicitly funded budget; no old credit, seeded
    // proof reserve, or unaddressed opening slot can fund the new epoch.
    // Any surplus NOT allocated to an old slot/credit may count toward a new
    // epoch, but the legal treatment of unused CHOG is still NOT specified.
    function openNextEpoch(uint256 budget) external onlyOwner returns (uint256 epochId) {
        if (!epochs[currentEpochId].closed || budget == 0 || budget > MAX_EPOCH_BUDGET) revert Invalid();
        if (chog.balanceOf(address(this)) < outstandingCredits + totalReserved
            + totalPendingCapacity + budget) revert InsufficientFunding();
        epochId = nextEpochId++;
        currentEpochId = epochId;
        epochs[epochId] = Epoch({ budget: budget, awarded: 0, reserved: 0,
            pendingCapacity: 0, purchasedSlots: 0, closed: false });
        newBatchesPaused = true; // Every new campaign requires an explicit owner unpause.
        emit EpochOpened(epochId, budget);
        emit NewBatchesPaused(true);
    }

    // The operator pays the Entropy fee and transaction gas, but cannot choose
    // or replace recipients without an EIP-712 owner signature over the exact
    // root, epoch, batch ID, entry count and Entropy user commitment.
    function _domainHash() private view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("CHOGPIT Threshold")), keccak256(bytes("2")), block.chainid, address(this)));
    }
    function capacityPermitDigest(uint256 epochId, uint32 slots, uint256 deadline)
        public view returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(CAPACITY_TYPEHASH, epochId,
            slots, capacityPermitNonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domainHash(), structHash));
    }
    // Purchase fully backed opening slots BEFORE admitting players. A slot is
    // 25 CHOG, the maximum possible award; it stays ring-fenced even when a
    // player never confirms an address. Only actually used slots move to a
    // Merkle batch. Unused slots have no owner-release/sweep in this draft.
    function purchaseCapacity(uint256 epochId, uint32 slots, uint256 deadline,
        bytes calldata ownerSignature) external onlyBatchOperator
    {
        if (epochId != currentEpochId || epochs[epochId].closed || slots == 0
            || slots > MAX_ENTRIES_PER_BATCH || deadline < block.timestamp
            || deadline > block.timestamp + 7 days) revert Invalid();
        Epoch storage epoch = epochs[epochId];
        uint256 maximum = uint256(slots) * MAX_BOX;
        if (uint256(epoch.purchasedSlots) + slots > MAX_ENTRIES_PER_BATCH
            || epoch.awarded + epoch.reserved + epoch.pendingCapacity + maximum > epoch.budget)
            revert PoolExceeded();
        if (chog.balanceOf(address(this)) < outstandingCredits + totalReserved
            + totalPendingCapacity + maximum) revert InsufficientFunding();
        if (!_validOwnerSignature(capacityPermitDigest(epochId, slots, deadline), ownerSignature))
            revert NotOwner();
        capacityPermitNonce++;
        epoch.purchasedSlots += slots;
        epoch.pendingCapacity += maximum;
        totalPendingCapacity += maximum;
        emit CapacityPurchased(epochId, slots, epoch.purchasedSlots,
            totalPendingCapacity, msg.sender);
    }
    function batchPermitDigest(uint256 epochId, bytes32 root, uint32 entries,
        bytes32 userRandomNumber, uint256 deadline) public view returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(BATCH_TYPEHASH, epochId,
            nextBatchId, root, entries, userRandomNumber, deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domainHash(), structHash));
    }
    function finalSettlementDigest(address recipient, uint256 amount, uint256 deadline)
        public view returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(SETTLEMENT_TYPEHASH,
            recipient, amount, settlementNonces[recipient], deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domainHash(), structHash));
    }
    function _validOwnerSignature(bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return (v == 27 || v == 28) && uint256(s) <= SECP256K1_HALF_N
            && ecrecover(digest, v, r, s) == owner;
    }
    function _verifyOwnerPermit(uint256 epochId, bytes32 root, uint32 entries,
        bytes32 userRandomNumber, uint256 deadline, bytes calldata ownerSignature) private view
    {
        if (root == bytes32(0) || entries == 0 || entries > MAX_ENTRIES_PER_BATCH
            || userRandomNumber == bytes32(0) || deadline < block.timestamp
            || deadline > block.timestamp + 7 days) revert Invalid();
        if (!_validOwnerSignature(batchPermitDigest(epochId, root, entries,
            userRandomNumber, deadline), ownerSignature)) revert NotOwner();
    }

    function commitBatch(uint256 epochId, bytes32 root, uint32 entries,
        bytes32 userRandomNumber, uint256 deadline, bytes calldata ownerSignature)
        external payable onlyBatchOperator returns (uint256 batchId)
    {
        if (newBatchesPaused || epochId >= nextEpochId) revert Paused();
        Epoch storage epoch = epochs[epochId];
        _verifyOwnerPermit(epochId, root, entries, userRandomNumber, deadline, ownerSignature);
        uint256 maximum = uint256(entries) * MAX_BOX;
        if (epoch.pendingCapacity < maximum) revert PoolExceeded();
        if (chog.balanceOf(address(this)) < outstandingCredits + totalReserved
            + totalPendingCapacity) revert InsufficientFunding();
        uint256 fee = entropy.getFeeV2(provider, 0); // Query current on-chain fee per request.
        if (msg.value != fee) revert Invalid();
        batchId = nextBatchId++;
        batches[batchId] = Batch({ epochId: epochId, root: root,
            seed: bytes32(0), sequence: 0, entries: entries, redeemedCount: 0, seeded: false });
        epoch.pendingCapacity -= maximum;
        totalPendingCapacity -= maximum;
        epoch.reserved += maximum;
        totalReserved += maximum;
        uint64 sequence = entropy.requestV2{value: fee}(provider, userRandomNumber, 0);
        if (batchForSequencePlusOne[sequence] != 0) revert Invalid();
        batchForSequencePlusOne[sequence] = batchId + 1;
        batches[batchId].sequence = sequence;
        emit BatchCommitted(epochId, batchId, root, entries, sequence);
    }

    function _entropyCallback(uint64 sequence, address callbackProvider, bytes32 randomNumber) external {
        if (msg.sender != address(entropy) || callbackProvider != provider) revert Invalid();
        uint256 plusOne = batchForSequencePlusOne[sequence];
        if (plusOne == 0) revert Invalid();
        Batch storage batch = batches[plusOne - 1];
        if (batch.seeded || batch.sequence != sequence) revert AlreadyUsed();
        batch.seed = randomNumber;
        batch.seeded = true;
        emit BatchSeeded(plusOne - 1, sequence, randomNumber);
    }

    function leafFor(uint256 batchId, uint256 index, address recipient, bytes32 eventId)
        public view returns (bytes32)
    {
        if (batchId >= nextBatchId) revert Invalid();
        return keccak256(abi.encode(block.chainid, address(this), batches[batchId].epochId,
            batchId, index, recipient, eventId));
    }

    // The sponsor/anyone may redeem; only the precommitted recipient can ever
    // receive the token. This does NOT validate an off-chain game event.
    function redeem(uint256 batchId, uint256 index, address recipient, bytes32 eventId, bytes32[] calldata proof)
        external returns (uint256 amount)
    {
        if (transferring) revert Reentrant();
        if (batchId >= nextBatchId || recipient == address(0) || eventId == bytes32(0) || proof.length > 6) revert Invalid();
        Batch storage batch = batches[batchId];
        if (!batch.seeded || index >= batch.entries) revert NotReady();
        if (redeemed[batchId][index] || usedGameEvent[eventId]) revert AlreadyUsed();
        bytes32 computed = leafFor(batchId, index, recipient, eventId);
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        if (computed != batch.root) revert BadProof();
        uint256 roll = uint256(keccak256(abi.encode(batch.seed, batch.epochId,
            batchId, index, recipient, eventId))) % 100;
        uint256 units = roll < 70 ? uint256(5) : roll < 95 ? uint256(10) : uint256(25);
        amount = units * 1 ether;
        redeemed[batchId][index] = true;
        usedGameEvent[eventId] = true;
        batch.redeemedCount++;
        Epoch storage epoch = epochs[batch.epochId];
        epoch.reserved -= MAX_BOX;
        totalReserved -= MAX_BOX;
        epoch.awarded += amount;
        outstandingCredits += amount;
        uint256 running = creditOf[recipient] + amount;
        creditOf[recipient] = running;
        emit BoxCredited(batch.epochId, batchId, index, eventId, recipient, amount, running);
        if (running >= PAYOUT_THRESHOLD) {
            transferring = true;
            creditOf[recipient] = 0;
            outstandingCredits -= running;
            totalPaidOut += running;
            bool success = chog.transfer(recipient, running);
            if (!success) revert TransferFailed();
            transferring = false;
            emit AutoPaid(recipient, running, msg.sender);
        }
    }

    // Off-chain final-close-out review is required before the owner signs this
    // narrow exception. It pays ONLY an already credited small balance to its
    // already published recipient; the owner/operator cannot redirect it.
    // Pausing new batches does not block old proofs or later deferred batches.
    function settleFinalCredit(address recipient, uint256 deadline, bytes calldata ownerSignature)
        external returns (uint256 amount)
    {
        if (transferring) revert Reentrant();
        if (!newBatchesPaused || recipient == address(0) || deadline < block.timestamp
            || deadline > block.timestamp + 7 days) revert Invalid();
        amount = creditOf[recipient];
        if (amount == 0 || amount >= PAYOUT_THRESHOLD) revert NotReady();
        if (!_validOwnerSignature(finalSettlementDigest(recipient, amount, deadline), ownerSignature))
            revert NotOwner();
        transferring = true;
        settlementNonces[recipient]++;
        creditOf[recipient] = 0;
        outstandingCredits -= amount;
        totalPaidOut += amount;
        if (!chog.transfer(recipient, amount)) revert TransferFailed();
        transferring = false;
        emit FinalSettled(recipient, amount, msg.sender);
    }
}
