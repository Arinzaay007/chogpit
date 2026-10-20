// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// HACKATHON OWNER-RECOVER DRAFT - NOT AUDITED
// Same holder-gated 50 CHOG auto-pay as before, but owner CAN reclaim unreserved CHOG when paused.
// For a real public campaign you would replace this with a timelocked/community custody vault.
interface IChogTokenR { function balanceOf(address) external view returns(uint256); function transfer(address,uint256) external returns(bool); }
interface IEntropyR { function getFeeV2(address,uint32) external view returns(uint128); function requestV2(address,bytes32,uint32) external payable returns(uint64); }
interface IRaiderPassR { function balanceOf(address) external view returns(uint256); }
contract ChogRewardVaultHolderAwareOwnerRecoverDraft {
    uint256 public constant PAYOUT_THRESHOLD = 50 ether;
    uint256 public constant MAX_BOX = 25 ether;
    address public immutable owner;
    address public immutable operator;
    IChogTokenR public immutable chog;
    IEntropyR public immutable entropy;
    address public immutable entropyProvider;
    IRaiderPassR public immutable raiderPass;
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
    event OwnerRecovered(address indexed to, uint256 amount);
    event AutoPaid(address indexed to, uint256 amount);
    error NotOwner(); error Paused(); error BadProof(); error NoRecoverable();
    modifier onlyOwner(){ if(msg.sender!=owner) revert NotOwner(); _; }
    constructor(address owner_, address operator_, address chog_, address entropy_, address provider_, address raiderPass_){
        owner=owner_; operator=operator_; chog=IChogTokenR(chog_); entropy=IEntropyR(entropy_); entropyProvider=provider_; raiderPass=IRaiderPassR(raiderPass_);
    }
    function setPaused(bool p) external onlyOwner { batchesPaused=p; }
    function isHolder(address who) public view returns(bool){ return raiderPass.balanceOf(who)>0; }
    function leafFor(uint256 b,uint256 i,address r,bytes32 e) public view returns(bytes32){ return keccak256(abi.encode(block.chainid,address(this),b,i,r,e)); }
    function redeem(uint256 bid,uint256 idx,address rec,bytes32 eid,bytes32[] calldata proof) external returns(uint256 amt){
        if(batchesPaused) revert Paused();
        Batch storage b=batches[bid]; if(!b.seeded) revert NotOwner();
        if(redeemed[bid][idx]||usedEvent[eid]) revert NotOwner();
        bytes32 c=leafFor(bid,idx,rec,eid); for(uint i;i<proof.length;i++){ bytes32 s=proof[i]; c=c<s?keccak256(abi.encodePacked(c,s)):keccak256(abi.encodePacked(s,c)); }
        if(c!=b.root) revert BadProof();
        uint256 roll=uint256(keccak256(abi.encode(b.seed,bid,idx,rec,eid)))%100; amt=(roll<70?5:roll<95?10:25)*1 ether;
        redeemed[bid][idx]=true; usedEvent[eid]=true; creditOf[rec]+=amt; outstanding+=amt;
        if(creditOf[rec]>=PAYOUT_THRESHOLD){
            if(!isHolder(rec)) return amt; // stays until they get pass
            _pay(rec, creditOf[rec]);
        }
    }
    function _pay(address to,uint256 a) internal { if(locked) revert NotOwner(); locked=true; creditOf[to]-=a; outstanding-=a; require(chog.transfer(to,a),"xfer"); emit AutoPaid(to,a); locked=false; }
    // OWNER CAN PULL BACK unreserved CHOG when paused - hackathon convenience
    function ownerRecover(address to, uint256 amount) external onlyOwner {
        if(!batchesPaused) revert Paused(); // only when campaign off
        uint256 bal=chog.balanceOf(address(this));
        uint256 recoverable = bal > outstanding ? bal - outstanding : 0;
        if(amount==0 || amount > recoverable) revert NoRecoverable();
        require(chog.transfer(to, amount),"xfer");
        emit OwnerRecovered(to, amount);
    }
}
