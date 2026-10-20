// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CHOGPIT reward vault — UNREVIEWED DRAFT, NOT DEPLOYED
 * @notice No preview-ledger points are eligible. This contract is NOT wired to
 *         the game. Never activate/fund/deploy for public prizes without legal
 *         eligibility review, independent security audit, and operator runbooks.
 *
 * An independent backend must validate real server events, bind each to a
 * signed player wallet, publish a publicly inspectable eligibility Merkle root
 * BEFORE requesting one Pyth Entropy seed for the batch, and sponsor players'
 * redemption/withdrawal gas if participation and claims must remain free.
 * The contract cannot prove an off-chain game event actually happened, cannot
 * stop Sybil/multiple-wallet farming, and cannot guarantee the operator includes
 * every eligible player. Those are LAUNCH-BLOCKING problems, not solved here.
 */
interface IChogTokenDraft {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IEntropyV2Draft {
    function getFeeV2(address provider, uint32 gasLimit) external view returns (uint128);
    function requestV2(address provider, bytes32 userRandomNumber, uint32 gasLimit)
        external payable returns (uint64);
}

contract ChogRewardVaultDraft {
    uint256 public constant MAX_CAMPAIGN = 1_000 ether; // CHOG has 18 decimals on Monad.
    uint256 public constant MAX_BOX = 25 ether;
    uint32 public constant MAX_ENTRIES_PER_BATCH = 40;

    address public immutable owner;
    IChogTokenDraft public immutable chog;
    IEntropyV2Draft public immutable entropy;
    address public immutable provider;
    bool public newBatchesPaused = true; // OFF by default; no auto-enable switch.
    bool private transferring;

    struct Batch {
        bytes32 root;
        bytes32 seed;
        uint64 sequence;
        uint32 entries;
        uint32 redeemedCount;
        bool seeded;
    }
    uint256 public nextBatchId;
    uint256 public reservedMaximum;
    uint256 public lifetimeCredited;
    uint256 public outstandingCredits;
    mapping(uint256 => Batch) public batches;
    mapping(uint64 => uint256) private batchForSequencePlusOne;
    mapping(uint256 => mapping(uint256 => bool)) public redeemed;
    mapping(bytes32 => bool) public usedGameEvent;
    mapping(address => uint256) public creditOf;

    event BatchCommitted(uint256 indexed batchId, bytes32 indexed root, uint32 entries, uint64 sequence);
    event BatchSeeded(uint256 indexed batchId, uint64 sequence, bytes32 seed);
    event BoxCredited(uint256 indexed batchId, uint256 index, bytes32 indexed eventId, address indexed recipient, uint256 amount);
    event Withdrawal(address indexed recipient, uint256 amount, address indexed gasSponsor);
    event NewBatchesPaused(bool paused);

    error NotOwner();
    error Paused();
    error Invalid();
    error PoolExceeded();
    error InsufficientFunding();
    error NotReady();
    error AlreadyUsed();
    error BadProof();
    error NoCredit();
    error TransferFailed();
    error Reentrant();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address owner_, address chog_, address entropy_, address provider_) {
        if (owner_ == address(0) || chog_ == address(0) || entropy_ == address(0) || provider_ == address(0)) revert Invalid();
        owner = owner_;
        chog = IChogTokenDraft(chog_);
        entropy = IEntropyV2Draft(entropy_);
        provider = provider_;
    }

    // This manual switch is NOT proof of a legal review or audit. An unreviewed
    // owner could call it, so deployment must be controlled outside this code.
    function setNewBatchesPaused(bool paused) external onlyOwner {
        newBatchesPaused = paused;
        emit NewBatchesPaused(paused);
    }

    function currentEntropyFee() external view returns (uint256) {
        return entropy.getFeeV2(provider, 0);
    }

    function commitBatch(bytes32 root, uint32 entries, bytes32 userRandomNumber)
        external payable onlyOwner returns (uint256 batchId)
    {
        if (newBatchesPaused) revert Paused();
        if (root == bytes32(0) || entries == 0 || entries > MAX_ENTRIES_PER_BATCH || userRandomNumber == bytes32(0)) revert Invalid();
        uint256 maximum = uint256(entries) * MAX_BOX;
        if (lifetimeCredited + reservedMaximum + maximum > MAX_CAMPAIGN) revert PoolExceeded();
        // Reserve worst case 25 CHOG per leaf, and keep all previously earned
        // balances covered even after some winners withdraw.
        if (chog.balanceOf(address(this)) < outstandingCredits + reservedMaximum + maximum) revert InsufficientFunding();
        uint256 fee = entropy.getFeeV2(provider, 0); // Live fee varies; a read-only check showed 1.4 MON.
        if (msg.value != fee) revert Invalid();
        batchId = nextBatchId++;
        batches[batchId] = Batch({root: root, seed: bytes32(0), sequence: 0, entries: entries, redeemedCount: 0, seeded: false});
        reservedMaximum += maximum;
        uint64 sequence = entropy.requestV2{value: fee}(provider, userRandomNumber, 0);
        if (batchForSequencePlusOne[sequence] != 0) revert Invalid();
        batchForSequencePlusOne[sequence] = batchId + 1;
        batches[batchId].sequence = sequence;
        emit BatchCommitted(batchId, root, entries, sequence);
    }

    // Matches the current Pyth Entropy IEntropyConsumer callback selector.
    // The provider AND the caller AND sequence are checked. Any failure of the
    // oracle/callback leaves funds reserved until separately reviewed recovery.
    function _entropyCallback(uint64 sequence, address callbackProvider, bytes32 randomNumber) external {
        if (msg.sender != address(entropy) || callbackProvider != provider) revert Invalid();
        uint256 plusOne = batchForSequencePlusOne[sequence];
        if (plusOne == 0) revert Invalid();
        Batch storage batch = batches[plusOne - 1];
        if (batch.seeded || batch.sequence != sequence) revert AlreadyUsed();
        batch.seed = randomNumber;
        batch.seeded = true; // A zero-valued seed is still a valid outcome.
        emit BatchSeeded(plusOne - 1, sequence, randomNumber);
    }

    // Leaf domain separates chain, vault, batch and index. Use sorted-pair
    // Merkle proofs; a published root cannot be edited after the oracle request.
    function leafFor(uint256 batchId, uint256 index, address recipient, bytes32 eventId)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), batchId, index, recipient, eventId));
    }

    function redeem(uint256 batchId, uint256 index, address recipient, bytes32 eventId, bytes32[] calldata proof)
        external returns (uint256 amount)
    {
        // A tree of at most 40 leaves needs at most six sibling hashes.
        // Reject longer calldata before proof hashing; sponsors must not pay
        // for unbounded, attacker-supplied work even in this unreviewed draft.
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
        uint256 roll = uint256(keccak256(abi.encode(batch.seed, batchId, index, recipient, eventId))) % 100;
        // Explicit uint256 conversion matters: Solidity can infer a narrower
        // type for a numeric ternary, and 25 * 1e18 overflows uint64.
        uint256 units = roll < 70 ? uint256(5) : roll < 95 ? uint256(10) : uint256(25);
        amount = units * 1 ether;
        redeemed[batchId][index] = true;
        usedGameEvent[eventId] = true;
        batch.redeemedCount++;
        reservedMaximum -= MAX_BOX;
        lifetimeCredited += amount;
        outstandingCredits += amount;
        creditOf[recipient] += amount;
        emit BoxCredited(batchId, index, eventId, recipient, amount);
    }

    // Permissionless gas sponsorship: anybody may pay gas, CHOG ONLY goes to
    // the wallet whose proof was redeemed. No deposit, NFT or token holding is
    // required from a player to earn/open a box. A relayer is still needed to
    // actually make redemption and withdrawal free of blockchain gas to users.
    function withdrawFor(address recipient) external returns (uint256 amount) {
        if (transferring) revert Reentrant();
        amount = creditOf[recipient];
        if (amount == 0) revert NoCredit(); // Any positive credit may be withdrawn; sponsor pays gas.
        transferring = true;
        creditOf[recipient] = 0;
        outstandingCredits -= amount;
        bool success = chog.transfer(recipient, amount);
        if (!success) revert TransferFailed();
        transferring = false;
        emit Withdrawal(recipient, amount, msg.sender);
    }
}
