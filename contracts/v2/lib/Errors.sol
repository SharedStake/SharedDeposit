// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/**
 * @title Errors
 * @author Sharedstake
 * @notice Contains all the custom errors
 */
library Errors {
    error ZeroAddress();
    error InvalidAmount();
    error PermissionDenied();
    error InsufficientBalance();
    error TooEarly();
    error FailedCall();
}
