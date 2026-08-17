// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Publishes aggregate private-ledger settlement commitments without
/// exposing participants, individual amounts, resources, or voucher metadata.
contract PX402BatchCommitment {
    address public immutable operator;
    mapping(bytes32 => uint64) public committedAt;

    event BatchCommitted(bytes32 indexed merkleRoot, address indexed asset, uint256 transferCount);

    error Unauthorized();
    error InvalidBatch();
    error BatchExists();

    constructor(address operator_) {
        operator = operator_ == address(0) ? msg.sender : operator_;
    }

    function commitBatch(bytes32 merkleRoot, address asset, uint256 transferCount) external {
        if (msg.sender != operator) revert Unauthorized();
        if (merkleRoot == bytes32(0) || asset == address(0) || transferCount == 0) revert InvalidBatch();
        if (committedAt[merkleRoot] != 0) revert BatchExists();
        committedAt[merkleRoot] = uint64(block.timestamp);
        emit BatchCommitted(merkleRoot, asset, transferCount);
    }
}
