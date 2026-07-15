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

    /// @notice Credit collateral to `user`'s position, pulled from the caller.
    function depositCollateralFor(address user, address token, uint256 amount) external;

    /// @notice Pull collateral out of `user`'s position. Caller must be an
    ///         approved operator, and the withdrawal must leave the position
    ///         healthy (HF >= 1) — even an operator cannot expose the user.
    function operatorWithdrawCollateral(address user, address token, uint256 amount, address to) external;

    /// @notice Flash-rescue bracket: the pool hands control to an approved
    ///         operator, which repairs the position within `onFirebreakRescue`
    ///         (pulling collateral, swapping, repaying), then returns. Health
    ///         may dip mid-callback; the operator is responsible for leaving
    ///         the position no worse. Only an approved operator may call.
    function operatorRescue(address user, bytes calldata data) external;

    /// @notice Pull collateral without a health check. Callable ONLY by the
    ///         operator currently inside its own operatorRescue bracket.
    function rescuePull(address token, uint256 amount, address to) external;
}

/// @notice Implemented by the operator (FirebreakMandate) to receive control
///         during a flash rescue.
interface IRescueCallback {
    function onFirebreakRescue(address user, bytes calldata data) external;
}
