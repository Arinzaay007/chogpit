// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOT DEPLOYED. The issuer/sponsor pays to mint; claimants sign a non-spending
// EIP-712 authorization and never send a mint transaction or MON.
// This is a participation NFT, NOT an official Chog NFT or a CHOG entitlement.
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

// Pure/view metadata only. Avoid Cancun-only MCOPY so this draft can be
// compiled for the conservative Paris EVM target used by the game prototypes.
library PassBase64 {
    bytes internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function encode(bytes memory input) internal pure returns (string memory) {
        bytes memory output = new bytes(4 * ((input.length + 2) / 3));
        uint256 j;
        for (uint256 i; i < input.length; i += 3) {
            uint256 n = uint256(uint8(input[i])) << 16;
            if (i + 1 < input.length) n |= uint256(uint8(input[i + 1])) << 8;
            if (i + 2 < input.length) n |= uint256(uint8(input[i + 2]));
            output[j++] = TABLE[(n >> 18) & 63];
            output[j++] = TABLE[(n >> 12) & 63];
            output[j++] = i + 1 < input.length ? TABLE[(n >> 6) & 63] : bytes1("=");
            output[j++] = i + 2 < input.length ? TABLE[n & 63] : bytes1("=");
        }
        return string(output);
    }
}

contract ChogpitRaiderPassDraft is ERC721, Ownable, EIP712 {
    error InvalidIssuer();
    error NotMinted();
    error InvalidBatch();
    error SoldOut();
    error AlreadyClaimed(address recipient);
    error Expired();
    error InvalidClaimSignature();

    event PassClaimed(address indexed recipient, uint256 indexed tokenId);

    // One issue per wallet ever, even if that NFT is later transferred away.
    // This is NOT a one-per-person guarantee: fresh wallets can still farm.
    mapping(address => bool) public everClaimed;
    mapping(address => uint256) public nonces;
    uint256 public totalSupply;
    // Forty player passes is a different cap from forty CHOG-backed openings.
    // A later distributor cannot raise this supply on the deployed contract.
    uint256 public constant maxSupply = 40;
    uint256 public constant MAX_BATCH = 20;
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("Claim(address recipient,uint256 nonce,uint256 deadline)");

    constructor(address initialIssuer)
        ERC721("CHOGPIT Raider Pass", "PITPASS")
        EIP712("CHOGPIT Raider Pass", "1")
        Ownable(initialIssuer)
    {
        if (initialIssuer == address(0)) revert InvalidIssuer();
    }

    // The same signer who will receive the NFT authorizes its mint. EIP-712
    // commits to this contract and chain, a single-use nonce and an expiry.
    // Only the issuer can submit the transaction and pay gas. An external
    // wallet connecting to the game is NOT a CHOG payout or a token transfer.
    function mintWithConsent(address recipient, uint256 deadline, bytes calldata signature)
        external onlyOwner returns (uint256)
    {
        return _mintWithConsent(recipient, deadline, signature);
    }

    function mintBatchWithConsent(
        address[] calldata recipients,
        uint256[] calldata deadlines,
        bytes[] calldata signatures
    ) external onlyOwner {
        uint256 length = recipients.length;
        if (length == 0 || length > MAX_BATCH || length != deadlines.length || length != signatures.length)
            revert InvalidBatch();
        if (totalSupply + length > maxSupply) revert SoldOut();
        for (uint256 i; i < length; ++i)
            _mintWithConsent(recipients[i], deadlines[i], signatures[i]);
    }

    function _mintWithConsent(address recipient, uint256 deadline, bytes memory signature)
        internal returns (uint256 tokenId)
    {
        if (totalSupply >= maxSupply) revert SoldOut();
        if (recipient == address(0) || everClaimed[recipient]) revert AlreadyClaimed(recipient);
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_TYPEHASH, recipient, nonces[recipient], deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(recipient, digest, signature))
            revert InvalidClaimSignature();
        everClaimed[recipient] = true;
        nonces[recipient]++;
        tokenId = ++totalSupply;
        _safeMint(recipient, tokenId);
        emit PassClaimed(recipient, tokenId);
    }

    // No gateway or project server is needed for basic wallet artwork. The
    // immutable on-chain art deliberately promises no prize and is distinct
    // from the real Chog NFTs that seed CHOGPIT's owner-built battlefields.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert NotMinted();
        string memory serial = Strings.toString(tokenId);
        bytes memory svg = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">',
            '<defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#152a27"/>',
            '<stop offset="1" stop-color="#40214b"/></linearGradient></defs>',
            '<rect width="720" height="720" rx="58" fill="url(#g)"/>',
            '<rect x="36" y="36" width="648" height="648" rx="40" fill="none" stroke="#a7edaa" stroke-width="8"/>',
            '<circle cx="360" cy="296" r="142" fill="#b5ef71"/>',
            '<path d="M290 296h140m-70-70v140" stroke="#27342a" stroke-width="28" stroke-linecap="round"/>',
            '<text x="360" y="116" text-anchor="middle" fill="#f7eedb" font-family="monospace" font-size="38">CHOGPIT</text>',
            '<text x="360" y="509" text-anchor="middle" fill="#f7eedb" font-family="monospace" font-size="42">RAIDER PASS</text>',
            '<text x="360" y="586" text-anchor="middle" fill="#ffadca" font-family="monospace" font-size="46">#', serial, '</text>',
            '<text x="360" y="644" text-anchor="middle" fill="#f7eedb" font-family="monospace" font-size="21">FREE CLAIM - NO CHOG PROMISE</text>',
            '</svg>'
        );
        bytes memory description = abi.encodePacked(
            '{"name":"CHOGPIT Raider Pass #', serial,
            '","description":"A free participation NFT for CHOGPIT on Monad. It is not an official Chog NFT or a CHOG prize entitlement. Chog NFT owner deeds still power the arenas.",',
            '"image":"data:image/svg+xml;base64,', PassBase64.encode(svg), '",',
            '"attributes":[{"trait_type":"Role","value":"Raider"},',
            '{"trait_type":"Mint price","value":"Free to player"}]}'
        );
        return string.concat("data:application/json;base64,", PassBase64.encode(description));
    }
}
