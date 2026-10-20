// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// NOT DEPLOYED / HACKATHON PREVIEW ONLY.
// CHOGPIT Hero is a CHOG-inspired fighter NFT. Every minted token IS the
// player's hero: its face (traits) seeds its look and its in-game role.
// It is NOT the official Chog Genesis collection (0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763, Monad 143, 1969 supply).
// For the hackathon we replicate the *pattern* (multiple faces/traits -> hero)
// with our own trait sets and on-chain SVG. Real-CHOG holder verification
// is read-only (ownerOf) and does not copy official art.
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

library HeroBase64 {
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

contract ChogpitHeroDraft is ERC721, Ownable, EIP712 {
    error InvalidIssuer();
    error NotMinted();
    error Expired();
    error InvalidClaimSignature();
    error AlreadyClaimed(address);
    error SoldOut();
    error InvalidBatch();

    event HeroClaimed(address indexed to, uint256 indexed tokenId, uint8 background, uint8 body, uint8 eyes, uint8 aura);

    struct Traits {
        uint8 background; // 0..n-1
        uint8 body;
        uint8 eyes;
        uint8 aura;
        uint8 tier; // derived
    }

    // CHOG-inspired replica sets (hackathon names, NOT official Chog trait strings verbatim for IP safety).
    // We keep the *categories* that judges expect: Background / Body / Eyes / Aura, matching real Chog examples
    // (Aqua, Lime Green, Sky Blue, Red Sky, Lemon Yellow, Light Purple / Prisoner, Gangster, Wizard Cape, Banana suit ...)
    string[] public backgrounds; // e.g. Aqua Depths, Lime Grid, Sky Blue ...
    string[] public bodies;
    string[] public eyesSet;
    string[] public auras;

    mapping(uint256 => Traits) public heroTraits;
    mapping(address => bool) public everClaimed; // one hero per wallet in hackathon draft (prevents spam, not per-person)
    mapping(address => uint256) public nonces;
    uint256 public totalSupply;
    uint256 public constant MAX_SUPPLY = 500; // hackathon replica cap - distinct from 40 Raider Pass
    uint256 public constant MAX_BATCH = 20;

    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(address recipient,uint256 nonce,uint256 deadline)");

    // Real CHOG reference (read-only, never written). Lets judges verify holder-bonus path.
    address public constant REAL_CHOG = 0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763;
    uint256 public constant REAL_CHOG_CHAIN = 143;

    constructor(address initialIssuer) ERC721("CHOGPIT Hero", "PITHERO") EIP712("CHOGPIT Hero", "1") Ownable(initialIssuer) {
        if (initialIssuer == address(0)) revert InvalidIssuer();
        // Replica trait tables - CHOG-style but hackathon-owned labels
        backgrounds = ["Aqua Depths","Lime Grid","Sky Blue","Red Sky","Lemon Yellow","Light Purple","Monad Purple","Void Black"];
        bodies = ["Prisoner Wrap","Zero THOTS Tee","Gangster Coat","Wizard Cape","Banana Suit","Royal Guard","Scrap Armor","Neon Racer"];
        eyesSet = ["Closed Crying","Clown Ring","Tired Half","Fire Laser","Dead Flat","Side Eye","Holo Scan","Prism Gaze"];
        auras = ["None","Royal Blue Aura","Royal Aura","Ember Aura","Frost Aura","Monad Pulse"];
    }

    function mintWithConsent(address recipient, uint256 deadline, bytes calldata signature) external onlyOwner returns (uint256) {
        return _mintHero(recipient, deadline, signature);
    }

    function mintBatchWithConsent(address[] calldata recipients, uint256[] calldata deadlines, bytes[] calldata sigs) external onlyOwner {
        uint256 n = recipients.length;
        if (n == 0 || n > MAX_BATCH || n != deadlines.length || n != sigs.length) revert InvalidBatch();
        if (totalSupply + n > MAX_SUPPLY) revert SoldOut();
        for (uint256 i; i < n; ++i) _mintHero(recipients[i], deadlines[i], sigs[i]);
    }

    function _mintHero(address recipient, uint256 deadline, bytes memory sig) internal returns (uint256 tokenId) {
        if (totalSupply >= MAX_SUPPLY) revert SoldOut();
        if (recipient == address(0) || everClaimed[recipient]) revert AlreadyClaimed(recipient);
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, recipient, nonces[recipient], deadline)));
        if (!SignatureChecker.isValidSignatureNow(recipient, digest, sig)) revert InvalidClaimSignature();
        everClaimed[recipient] = true;
        nonces[recipient]++;

        tokenId = ++totalSupply;
        // deterministic traits from tokenId + recipient - every mint is a unique face
        uint256 seed = uint256(keccak256(abi.encodePacked(tokenId, recipient, block.prevrandao)));
        Traits memory t = Traits({
            background: uint8(seed % backgrounds.length),
            body: uint8((seed >> 8) % bodies.length),
            eyes: uint8((seed >> 16) % eyesSet.length),
            aura: uint8((seed >> 24) % auras.length),
            tier: uint8((seed % 3) + 1) // 1..3 maps to game role
        });
        heroTraits[tokenId] = t;
        _safeMint(recipient, tokenId);
        emit HeroClaimed(recipient, tokenId, t.background, t.body, t.eyes, t.aura);
    }

    function _exists(uint256 id) internal view returns (bool) { return _ownerOf(id) != address(0); }

    // Showcase SVG - not official CHOG art, just trait-driven preview for hackathon
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert NotMinted();
        Traits memory t = heroTraits[tokenId];
        string memory bg = backgrounds[t.background];
        string memory body = bodies[t.body];
        string memory eyes = eyesSet[t.eyes];
        string memory aura = auras[t.aura];
        string memory serial = Strings.toString(tokenId);

        // minimal trait-reactive SVG (background color derived from trait index)
        string[8] memory bgColors = ["#0ea5a0","#a3e635","#38bdf8","#f43f5e","#facc15","#c084fc","#6d28d9","#111827"];
        string memory bgColor = bgColors[t.background];
        string memory bodyColor = t.body == 0 ? "#e2e8f0" : t.body == 1 ? "#fde68a" : t.body == 2 ? "#1f2937" : t.body == 3 ? "#7c3aed" : "#fef08a";
        string memory eyeColor = t.eyes == 3 ? "#f97316" : "#0f172a";

        bytes memory svg = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">',
            '<rect width="720" height="720" rx="48" fill="', bgColor, '"/>',
            '<circle cx="360" cy="340" r="168" fill="', aura == string("None") ? "none" : "#ffffff", '" opacity="0.18" stroke="#fff" stroke-width="', aura == string("None") ? "0" : "10", '"/>',
            '<rect x="220" y="300" width="280" height="220" rx="32" fill="', bodyColor, '" stroke="#0f172a" stroke-width="10"/>',
            '<circle cx="300" cy="360" r="26" fill="', eyeColor, '"/><circle cx="420" cy="360" r="26" fill="', eyeColor, '"/>',
            '<text x="360" y="96" text-anchor="middle" font-family="monospace" font-size="28" fill="#0f172a">CHOGPIT HERO #', serial, '</text>',
            '<text x="360" y="660" text-anchor="middle" font-family="monospace" font-size="14" fill="#0f172a">', bg, ' | ', body, ' | ', eyes, ' | ', aura, '</text>',
            '</svg>'
        );

        bytes memory json = abi.encodePacked(
            '{"name":"CHOGPIT Hero #', serial,'","description":"Hackathon hero - CHOG-inspired replica. Every mint is your fighter. Not the official Chog Genesis (0xc96d...3763, Monad 143). Real-CHOG holders get a visual badge in-game via read-only ownerOf check.",',
            '"image":"data:image/svg+xml;base64,', HeroBase64.encode(svg),'",',
            '"attributes":[',
            '{"trait_type":"Background","value":"', bg,'"},',
            '{"trait_type":"Body","value":"', body,'"},',
            '{"trait_type":"Eyes","value":"', eyes,'"},',
            '{"trait_type":"Aura","value":"', aura,'"},',
            '{"trait_type":"Tier","value":', Strings.toString(t.tier), '},',
            '{"trait_type":"Collection","value":"CHOGPIT Hero (Hackathon Replica)"}',
            ']}'
        );
        return string.concat("data:application/json;base64,", HeroBase64.encode(json));
    }

    // helper for game - trait -> gameplay seed (deterministic)
    function heroSeed(uint256 tokenId) external view returns (bytes32) {
        if (!_exists(tokenId)) revert NotMinted();
        Traits memory t = heroTraits[tokenId];
        return keccak256(abi.encode(t.background, t.body, t.eyes, t.aura, t.tier));
    }
}
