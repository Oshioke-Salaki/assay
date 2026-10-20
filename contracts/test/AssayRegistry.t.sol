// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AssayRegistry} from "../src/AssayRegistry.sol";

contract AssayRegistryTest is Test {
    AssayRegistry internal registry;
    uint256 internal attesterKey = 0xA11CE;
    address internal attester;
    address internal owner = makeAddr("owner");
    address internal subject = makeAddr("subject");

    function setUp() public {
        attester = vm.addr(attesterKey);
        registry = new AssayRegistry(attester, owner);
        vm.warp(1_800_000_000);
    }

    function _score(uint8 rating, uint64 issuedAt) internal view returns (AssayRegistry.Score memory s) {
        s = AssayRegistry.Score({
            subject: subject,
            score: 72,
            rating: rating,
            organicUsdMicros: 9_000_000,
            grossUsdMicros: 10_000_000,
            effectivePayersX100: 1_150,
            asOfBlock: 80_000_000,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 7 days
        });
    }

    function _sign(uint256 key, AssayRegistry.Score memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(key, registry.hashScore(s));
        return abi.encodePacked(r, sig, v);
    }

    function test_publishAndRead() public {
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        vm.expectEmit(true, true, false, true);
        emit AssayRegistry.ScorePublished(subject, 72, 6, s.issuedAt, s.expiresAt, address(this));
        registry.publish(s, _sign(attesterKey, s));
        (AssayRegistry.Score memory stored, bool fresh) = registry.scoreOf(subject);
        assertEq(stored.score, 72);
        assertEq(stored.rating, 6);
        assertTrue(fresh);
        assertTrue(registry.isInvestmentGrade(subject));
    }

    function test_anyoneMayPublish() public {
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        bytes memory sig = _sign(attesterKey, s);
        vm.prank(makeAddr("stranger"));
        registry.publish(s, sig);
        (, bool fresh) = registry.scoreOf(subject);
        assertTrue(fresh);
    }

    function test_belowInvestmentGrade() public {
        AssayRegistry.Score memory s = _score(4, uint64(block.timestamp));
        registry.publish(s, _sign(attesterKey, s));
        assertFalse(registry.isInvestmentGrade(subject));
    }

    function test_unknownSubject() public {
        (AssayRegistry.Score memory s, bool fresh) = registry.scoreOf(makeAddr("nobody"));
        assertEq(s.issuedAt, 0);
        assertFalse(fresh);
        assertFalse(registry.isInvestmentGrade(makeAddr("nobody")));
    }

    function test_rejectsWrongSigner() public {
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        bytes memory sig = _sign(0xBAD, s);
        assertFalse(registry.verify(s, sig));
        vm.expectRevert(AssayRegistry.InvalidSignature.selector);
        registry.publish(s, sig);
    }

    function test_rejectsTamperedScore() public {
        AssayRegistry.Score memory s = _score(4, uint64(block.timestamp));
        bytes memory sig = _sign(attesterKey, s);
        s.rating = 8;
        vm.expectRevert(AssayRegistry.InvalidSignature.selector);
        registry.publish(s, sig);
    }

    function test_rejectsExpired() public {
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp - 8 days));
        bytes memory sig = _sign(attesterKey, s);
        assertFalse(registry.verify(s, sig));
        vm.expectRevert(AssayRegistry.Expired.selector);
        registry.publish(s, sig);
    }

    function test_expiresAfterPublishing() public {
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        registry.publish(s, _sign(attesterKey, s));
        vm.warp(block.timestamp + 7 days);
        (, bool fresh) = registry.scoreOf(subject);
        assertFalse(fresh);
        assertFalse(registry.isInvestmentGrade(subject));
    }

    function test_rejectsStaleOrReplayed() public {
        AssayRegistry.Score memory newer = _score(6, uint64(block.timestamp));
        AssayRegistry.Score memory older = _score(8, uint64(block.timestamp - 1 days));
        bytes memory newerSig = _sign(attesterKey, newer);
        registry.publish(newer, newerSig);
        bytes memory olderSig = _sign(attesterKey, older);
        vm.expectRevert(AssayRegistry.Stale.selector);
        registry.publish(older, olderSig);
        vm.expectRevert(AssayRegistry.Stale.selector);
        registry.publish(newer, newerSig);
    }

    function _expectInvalid(AssayRegistry.Score memory s) internal {
        bytes memory sig = _sign(attesterKey, s);
        assertFalse(registry.verify(s, sig));
        vm.expectRevert(AssayRegistry.InvalidScore.selector);
        registry.publish(s, sig);
    }

    function test_rejectsMalformed() public {
        _expectInvalid(_score(9, uint64(block.timestamp)));

        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        s.score = 101;
        _expectInvalid(s);

        s = _score(6, uint64(block.timestamp));
        s.organicUsdMicros = s.grossUsdMicros + 1;
        _expectInvalid(s);

        s = _score(6, uint64(block.timestamp));
        s.subject = address(0);
        _expectInvalid(s);

        s = _score(6, uint64(block.timestamp));
        s.expiresAt = s.issuedAt;
        _expectInvalid(s);
    }

    function test_rejectsGarbageSignature() public {
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        assertFalse(registry.verify(s, hex"1234"));
        vm.expectRevert();
        registry.publish(s, hex"1234");
    }

    function test_rotateAttester() public {
        uint256 nextKey = 0xB0B;
        vm.prank(owner);
        registry.setAttester(vm.addr(nextKey));
        AssayRegistry.Score memory s = _score(6, uint64(block.timestamp));
        bytes memory oldSig = _sign(attesterKey, s);
        bytes memory newSig = _sign(nextKey, s);
        vm.expectRevert(AssayRegistry.InvalidSignature.selector);
        registry.publish(s, oldSig);
        registry.publish(s, newSig);
    }

    function test_onlyOwnerRotates() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.setAttester(address(1));
        vm.prank(owner);
        vm.expectRevert(AssayRegistry.ZeroAddress.selector);
        registry.setAttester(address(0));
    }

    function test_constructorRejectsZeroAttester() public {
        vm.expectRevert(AssayRegistry.ZeroAddress.selector);
        new AssayRegistry(address(0), owner);
    }

    /// The TypeScript Attester signed this fixture; the contract must accept it byte for byte.
    function test_acceptsSignatureFromTypescriptAttester() public {
        // The attestation domain commits to Celo mainnet.
        vm.chainId(42220);
        string memory json = vm.readFile("test/fixtures/attestation.json");
        address at = vm.parseJsonAddress(json, ".registry");
        address signer = vm.parseJsonAddress(json, ".signer");
        deployCodeTo("AssayRegistry.sol:AssayRegistry", abi.encode(signer, owner), at);
        AssayRegistry deployed = AssayRegistry(at);
        AssayRegistry.Score memory s = AssayRegistry.Score({
            subject: vm.parseJsonAddress(json, ".subject"),
            score: uint8(vm.parseJsonUint(json, ".score")),
            rating: uint8(vm.parseJsonUint(json, ".rating")),
            organicUsdMicros: uint64(vm.parseJsonUint(json, ".organicUsdMicros")),
            grossUsdMicros: uint64(vm.parseJsonUint(json, ".grossUsdMicros")),
            effectivePayersX100: uint32(vm.parseJsonUint(json, ".effectivePayersX100")),
            asOfBlock: uint64(vm.parseJsonUint(json, ".asOfBlock")),
            issuedAt: uint64(vm.parseJsonUint(json, ".issuedAt")),
            expiresAt: uint64(vm.parseJsonUint(json, ".expiresAt"))
        });
        bytes memory sig = vm.parseJsonBytes(json, ".signature");
        vm.warp(s.issuedAt + 1);
        assertTrue(deployed.verify(s, sig));
        deployed.publish(s, sig);
        assertTrue(deployed.isInvestmentGrade(s.subject));
    }

    function testFuzz_onlyAttesterSignaturesVerify(uint256 key, uint8 rating) public view {
        key = bound(key, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        rating = uint8(bound(rating, 0, 8));
        AssayRegistry.Score memory s = _score(rating, uint64(block.timestamp));
        bool ok = registry.verify(s, _sign(key, s));
        assertEq(ok, vm.addr(key) == attester);
    }
}
