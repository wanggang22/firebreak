// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title IPosition — the minimal lending-position surface Firebreak speaks.
/// @notice Firebreak is protocol-agnostic: any pool exposing this interface
///         can be guarded. MiniLend is merely the first adapter.
///         Debt is denominated in native USDC (Arc's gas token, 18 decimals).
interface IPosition {
    /// @return WAD health factor; type(uint256).max when the user has no debt.
    function healthFactor(address user) external view returns (uint256);

    function collateralOf(address user, address token) external view returns (uint256);

    /// @return debt in native USDC wei.
    function debtOf(address user) external view returns (uint256);

    /// @notice Repay `user`'s debt with msg.value; excess is refunded to caller.
    function repayFor(address user) external payable;

    /// @notice Pull collateral out of `user`'s position. Caller must be an
    ///         approved operator, and the withdrawal must leave the position
    ///         healthy (HF >= 1) — even an operator cannot expose the user.
    function operatorWithdrawCollateral(address user, address token, uint256 amount, address to)
        external;
}
