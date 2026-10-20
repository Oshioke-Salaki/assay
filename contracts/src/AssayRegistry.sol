// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title AssayRegistry
/// @notice Onchain home for Assay credit scores on Celo. Assay signs an EIP-712 score
///         off chain; anyone can verify it statelessly or publish it here, and any
///         contract can then read `scoreOf(subject)` or gate on `isInvestmentGrade(subject)`.
/// @dev Ratings are ordered codes: 0 not rated, 1 D, 2 CCC, 3 B, 4 BB, 5 BBB, 6 A, 7 AA, 8 AAA.
contract AssayRegistry is EIP712, Ownable2Step {
    struct Score {
        address subject;
        uint8 score;
        uint8 rating;
        uint64 organicUsdMicros;
        uint64 grossUsdMicros;
        uint32 effectivePayersX100;
        uint64 asOfBlock;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    bytes32 public constant SCORE_TYPEHASH = keccak256(
        "Score(address subject,uint8 score,uint8 rating,uint64 organicUsdMicros,uint64 grossUsdMicros,uint32 effectivePayersX100,uint64 asOfBlock,uint64 issuedAt,uint64 expiresAt)"
    );

    uint8 public constant INVESTMENT_GRADE = 5;
    uint8 public constant MAX_RATING = 8;

    /// @notice Key that signs scores. Rotating it does not erase published scores.
    address public attester;

    mapping(address subject => Score) private _scores;

    event ScorePublished(
        address indexed subject,
        uint8 score,
        uint8 rating,
        uint64 issuedAt,
        uint64 expiresAt,
        address indexed publisher
    );
    event AttesterChanged(address indexed previous, address indexed current);

    error InvalidSignature();
    error Expired();
    error InvalidScore();
    error Stale();
    error ZeroAddress();

    constructor(address attester_, address owner_) EIP712("Assay", "1") Ownable(owner_) {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterChanged(address(0), attester_);
    }

    /// @notice EIP-712 digest of a score, for off-chain tooling.
    function hashScore(Score calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SCORE_TYPEHASH,
                    s.subject,
                    s.score,
                    s.rating,
                    s.organicUsdMicros,
                    s.grossUsdMicros,
                    s.effectivePayersX100,
                    s.asOfBlock,
                    s.issuedAt,
                    s.expiresAt
                )
            )
        );
    }

    /// @notice True when the current attester signed `s`, it is well formed and it has not expired.
    function verify(Score calldata s, bytes calldata signature) public view returns (bool) {
        if (!_wellFormed(s) || block.timestamp >= s.expiresAt) return false;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashScore(s), signature);
        return err == ECDSA.RecoverError.NoError && signer == attester;
    }

    /// @notice Store a signed score for its subject. Anyone may publish; only newer scores replace older ones.
    function publish(Score calldata s, bytes calldata signature) external {
        if (!_wellFormed(s)) revert InvalidScore();
        if (block.timestamp >= s.expiresAt) revert Expired();
        if (ECDSA.recover(hashScore(s), signature) != attester) revert InvalidSignature();
        if (s.issuedAt <= _scores[s.subject].issuedAt) revert Stale();
        _scores[s.subject] = s;
        emit ScorePublished(s.subject, s.score, s.rating, s.issuedAt, s.expiresAt, msg.sender);
    }

    /// @notice Latest published score and whether it is still within its validity window.
    function scoreOf(address subject) external view returns (Score memory score, bool fresh) {
        score = _scores[subject];
        fresh = score.issuedAt != 0 && block.timestamp < score.expiresAt;
    }

    /// @notice Fresh published rating of BBB or better.
    function isInvestmentGrade(address subject) external view returns (bool) {
        Score storage s = _scores[subject];
        return s.issuedAt != 0 && block.timestamp < s.expiresAt && s.rating >= INVESTMENT_GRADE;
    }

    function setAttester(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit AttesterChanged(attester, next);
        attester = next;
    }

    function _wellFormed(Score calldata s) private pure returns (bool) {
        return s.subject != address(0) && s.score <= 100 && s.rating <= MAX_RATING && s.issuedAt < s.expiresAt
            && s.organicUsdMicros <= s.grossUsdMicros;
    }
}
