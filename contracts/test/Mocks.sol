// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockChog {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "not funded");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface IDraftCallback {
    function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) external;
}
contract MockEntropy {
    uint128 public fee = 1.4 ether; // Observed on mainnet at a read-only check; variable.
    uint64 public nextSequence = 1;
    mapping(uint64 => address) public requester;
    mapping(uint64 => address) public chosenProvider;
    function getFeeV2(address, uint32) external view returns (uint128) { return fee; }
    function requestV2(address provider, bytes32, uint32) external payable returns (uint64 sequence) {
        require(msg.value == fee, "fee changed");
        sequence = nextSequence++;
        requester[sequence] = msg.sender;
        chosenProvider[sequence] = provider;
    }
    function fulfill(uint64 sequence, bytes32 seed) external {
        IDraftCallback(requester[sequence])._entropyCallback(sequence, chosenProvider[sequence], seed);
    }
}
