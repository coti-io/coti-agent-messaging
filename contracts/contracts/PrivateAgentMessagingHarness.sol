// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./PrivateAgentMessaging.sol";

contract PrivateAgentMessagingHarness is PrivateAgentMessaging {
    constructor(uint64 epochDurationSeconds) PrivateAgentMessaging(epochDurationSeconds) {}

    function recordSyntheticMessage(
        address from,
        address to,
        ctString calldata networkCiphertext,
        ctString calldata senderCiphertext,
        ctString calldata recipientCiphertext
    ) external returns (uint256 messageId) {
        return _storeMessage(from, to, networkCiphertext, senderCiphertext, recipientCiphertext);
    }
}
