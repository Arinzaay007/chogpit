// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// HOLDER-AWARE DRAFT - NOT DEPLOYED. Enforces: payout address must hold a genuine
// CHOGPIT Raider Pass (40 supply, Monad 143) at the moment of transfer.
// Extends threshold logic (50 CHOG auto-pay, final sub-50 settlement) with
// an on-chain holder check at every value movement.

interface IChogToken { function balanceOf(address) external view returns(uint256); function transfer(address,uint256) external returns(bool); }
interface IEntropy { function getFeeV2(address,uint32) external view returns(uint128); function requestV2(address,bytes32,uint32) external payable returns(uint64); }
interface IRaiderPass { function balanceOf(address owner) external view returns(uint256); }

contract ChogRewardVaultHolderAwareDraft {
    uint256 public constant PAYOUT_THRESHOLD = 50 ether;
    uint256 public constant MAX_BOX = 25 ether;
    uint32 public constant MAX_BATCH = 40;

    address public immutable owner;
    address public immutable operator;
    IChogToken public immutable chog;
    IEntropy public immutable entropy;
    address public immutable entropyProvider;
    IRaiderPass public immutable raiderPass; // 0xc... verified Raider Pass, Monad 143 - must be the REAL 40-cap

    bool public batchesPaused = true;
    bool private locked;

    struct Batch { bytes32 root; bytes32 seed; uint64 seq; uint32 entries; bool seeded; }
    uint256 public nextBatchId;
    mapping(uint256=>Batch) public batches;
    mapping(uint64=>uint256) seqToBatch;
    mapping(uint256=>mapping(uint256=>bool)) public redeemed;
    mapping(bytes32=>bool) public usedEvent;
    mapping(address=>uint256) public creditOf;
    uint256 public outstanding;
    uint256 public totalReserved;

    event HolderRejected(address indexed recipient, uint256 credit, string reason);
    event AutoPaid(address indexed recipient, uint256 amount);
    event FinalSettled(address indexed recipient, uint256 amount);

    error NotHolder(address);
    error Paused();
    error NotOwner();
    error BadProof();

    modifier onlyOwner(){ if(msg.sender!=owner) revert NotOwner(); _; }

    constructor(address owner_, address operator_, address chog_, address entropy_, address provider_, address raiderPass_){
        owner=owner_; operator=operator_; chog=IChogToken(chog_); entropy=IEntropy(entropy_); entropyProvider=provider_; raiderPass=IRaiderPass(raiderPass_);
    }

    function setPaused(bool p) external onlyOwner { batchesPaused=p; }

    // Simplified holder check - must be called before any CHOG movement
    function isHolder(address who) public view returns(bool){ return raiderPass.balanceOf(who) > 0; }

    function leafFor(uint256 batchId,uint256 idx,address recv,bytes32 evt) public view returns(bytes32){
        return keccak256(abi.encode(block.chainid, address(this), batchId, idx, recv, evt));
    }

    function redeem(uint256 batchId,uint256 idx,address recipient,bytes32 eventId,bytes32[] calldata proof) external returns(uint256 amount){
        if(batchesPaused) revert Paused();
        Batch storage b=batches[batchId];
        if(!b.seeded) revert NotOwner();
        if(redeemed[batchId][idx]||usedEvent[eventId]) revert NotOwner();
        bytes32 c=leafFor(batchId,idx,recipient,eventId);
        for(uint i;i<proof.length;i++){ bytes32 s=proof[i]; c=c<s? keccak256(abi.encodePacked(c,s)):keccak256(abi.encodePacked(s,c)); }
        if(c!=b.root) revert BadProof();
        uint256 roll=uint256(keccak256(abi.encode(b.seed,batchId,idx,recipient,eventId)))%100;
        amount = (roll<70?5: roll<95?10:25) * 1 ether;
        redeemed[batchId][idx]=true; usedEvent[eventId]=true;
        creditOf[recipient]+=amount; outstanding+=amount;
        // Auto-pay ONLY if holder at this exact block
        if(creditOf[recipient] >= PAYOUT_THRESHOLD){
            if(!isHolder(recipient)){
                emit HolderRejected(recipient, creditOf[recipient], "Raider Pass not held at threshold");
                // credit stays until they acquire pass, not forfeited
                return amount;
            }
            _payout(recipient, creditOf[recipient]);
        }
    }

    function _payout(address to,uint256 amt) internal {
        if(locked) revert NotOwner(); locked=true;
        creditOf[to]-=amt; outstanding-=amt;
        require(chog.transfer(to,amt),"xfer fail");
        emit AutoPaid(to,amt);
        locked=false;
    }

    // Owner-signed final sub-50 settlement - also holder-gated
    function finalSettle(address recipient) external onlyOwner {
        uint256 amt=creditOf[recipient];
        require(amt>0 && amt < PAYOUT_THRESHOLD,"not eligible");
        if(!isHolder(recipient)) revert NotHolder(recipient);
        _payout(recipient, amt);
        emit FinalSettled(recipient, amt);
    }
}
