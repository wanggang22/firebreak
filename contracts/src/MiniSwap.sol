// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MockERC20} from "./MockERC20.sol";

/// @title MiniSwap — a minimal constant-product venue: native USDC ↔ ERC20.
/// @notice The fallback (and demo-controllable) swap venue for Firebreak's
///         Deleverage / Rotate paths. One pool per token, 0.3% fee, owner-
///         seeded liquidity (no LP shares — it is a demo venue, YAGNI).
contract MiniSwap {
    error NotOwner();
    error ZeroAmount();
    error NoLiquidity();
    error SlippageExceeded();
    error TransferFailed();
    error Reentrancy();

    event LiquidityAdded(address indexed token, uint256 usdcIn, uint256 tokenIn);
    event Swapped(address indexed token, address indexed trader, bool usdcIn, uint256 amountIn, uint256 amountOut);

    struct Pool {
        uint256 reserveUsdc; // native USDC wei
        uint256 reserveToken;
    }

    address public immutable owner;
    mapping(address => Pool) private pools;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() {
        owner = msg.sender;
    }

    function addLiquidity(address token, uint256 tokenAmount) external payable {
        if (msg.sender != owner) revert NotOwner();
        if (msg.value == 0 || tokenAmount == 0) revert ZeroAmount();
        Pool storage p = pools[token];
        p.reserveUsdc += msg.value;
        p.reserveToken += tokenAmount;
        if (!MockERC20(token).transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();
        emit LiquidityAdded(token, msg.value, tokenAmount);
    }

    /* ── quotes (0.3% fee) ──────────────────────────────── */

    function getUsdcOut(address token, uint256 tokenIn) public view returns (uint256) {
        Pool storage p = pools[token];
        if (p.reserveUsdc == 0 || p.reserveToken == 0) revert NoLiquidity();
        uint256 inWithFee = tokenIn * 997;
        return (inWithFee * p.reserveUsdc) / (p.reserveToken * 1000 + inWithFee);
    }

    function getTokenOut(address token, uint256 usdcIn) public view returns (uint256) {
        Pool storage p = pools[token];
        if (p.reserveUsdc == 0 || p.reserveToken == 0) revert NoLiquidity();
        uint256 inWithFee = usdcIn * 997;
        return (inWithFee * p.reserveToken) / (p.reserveUsdc * 1000 + inWithFee);
    }

    /* ── swaps ──────────────────────────────────────────── */

    function swapTokenForUsdc(address token, uint256 tokenIn, uint256 minUsdcOut)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (tokenIn == 0) revert ZeroAmount();
        out = getUsdcOut(token, tokenIn);
        if (out < minUsdcOut) revert SlippageExceeded();
        Pool storage p = pools[token];
        p.reserveToken += tokenIn;
        p.reserveUsdc -= out;
        if (!MockERC20(token).transferFrom(msg.sender, address(this), tokenIn)) revert TransferFailed();
        (bool ok,) = msg.sender.call{value: out}("");
        if (!ok) revert TransferFailed();
        emit Swapped(token, msg.sender, false, tokenIn, out);
    }

    function swapUsdcForToken(address token, uint256 minTokenOut)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        if (msg.value == 0) revert ZeroAmount();
        out = getTokenOut(token, msg.value);
        if (out < minTokenOut) revert SlippageExceeded();
        Pool storage p = pools[token];
        p.reserveUsdc += msg.value;
        p.reserveToken -= out;
        if (!MockERC20(token).transfer(msg.sender, out)) revert TransferFailed();
        emit Swapped(token, msg.sender, true, msg.value, out);
    }

    /* ── views ──────────────────────────────────────────── */

    function reservesOf(address token) external view returns (uint256 reserveUsdc, uint256 reserveToken) {
        Pool storage p = pools[token];
        return (p.reserveUsdc, p.reserveToken);
    }
}
