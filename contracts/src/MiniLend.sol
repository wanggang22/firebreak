// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPosition} from "./interfaces/IPosition.sol";
import {MockERC20} from "./MockERC20.sol";
import {MockOracle} from "./MockOracle.sol";

/// @title MiniLend — a deliberately small lending pool on Arc testnet.
/// @notice The demo range for Firebreak. Borrow native USDC (Arc's gas token)
///         against listed ERC20 collateral (mEURC, mTBILL). Implements
///         IPosition so the Firebreak keeper can guard positions here exactly
///         as it would on any production pool.
/// @dev    All values WAD (1e18). No interest accrual — health drift comes
///         from oracle prices, which is the failure mode that matters on a
///         stablecoin-native chain (FX drift, RWA discounts).
contract MiniLend is IPosition {
    error NotOwner();
    error Unlisted();
    error ZeroAmount();
    error InsufficientCollateral();
    error PoolIlliquid();
    error UnhealthyWithdraw();
    error HealthyPosition();
    error InsufficientRepay();
    error NotOperator();
    error TransferFailed();
    error Reentrancy();

    event CollateralListed(address indexed token, uint256 ltvWad, uint256 liqThresholdWad);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount, address to);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, address indexed payer, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid);
    event OperatorSet(address indexed user, address indexed operator, bool approved);
    event Funded(address indexed from, uint256 amount);

    uint256 private constant WAD = 1e18;
    uint256 private constant LIQ_PENALTY = 1.1e18; // liquidator seizes 110% of debt value

    struct Listing {
        bool listed;
        uint256 ltvWad; // max borrow vs collateral value
        uint256 liqThresholdWad; // HF threshold basis
    }

    address public immutable owner;
    MockOracle public immutable oracle;

    mapping(address => Listing) public listings;
    address[] public listedTokens;

    mapping(address => mapping(address => uint256)) private _collateral; // user => token => amt
    mapping(address => uint256) private _debt; // native USDC wei
    mapping(address => mapping(address => bool)) public isOperator; // user => op => ok

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address oracle_) {
        owner = msg.sender;
        oracle = MockOracle(oracle_);
    }

    /* ── admin ──────────────────────────────────────────── */

    function listCollateral(address token, uint256 ltvWad, uint256 liqThresholdWad) external {
        if (msg.sender != owner) revert NotOwner();
        if (!listings[token].listed) listedTokens.push(token);
        listings[token] = Listing(true, ltvWad, liqThresholdWad);
        emit CollateralListed(token, ltvWad, liqThresholdWad);
    }

    /// @notice Anyone can add native USDC liquidity to the pool.
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /* ── user actions ───────────────────────────────────── */

    function depositCollateral(address token, uint256 amount) external {
        if (!listings[token].listed) revert Unlisted();
        if (amount == 0) revert ZeroAmount();
        _collateral[msg.sender][token] += amount;
        if (!MockERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, token, amount);
    }

    function withdrawCollateral(address token, uint256 amount) external nonReentrant {
        _withdraw(msg.sender, token, amount, msg.sender);
    }

    function borrow(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) revert PoolIlliquid();
        uint256 newDebt = _debt[msg.sender] + amount;
        if (borrowPowerOf(msg.sender) < newDebt) revert InsufficientCollateral();
        _debt[msg.sender] = newDebt;
        _sendNative(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay() external payable {
        _repay(msg.sender, msg.sender);
    }

    /// @inheritdoc IPosition
    function repayFor(address user) external payable {
        _repay(user, msg.sender);
    }

    /// @notice Full liquidation: repay the entire debt, seize collateral worth
    ///         debt × 110% at oracle prices. Only when HF < 1.
    function liquidate(address user) external payable nonReentrant {
        if (healthFactor(user) >= WAD) revert HealthyPosition();
        uint256 debt = _debt[user];
        if (msg.value < debt) revert InsufficientRepay();
        _debt[user] = 0;

        // seize collateral across listed tokens, in listing order
        uint256 seizeValueLeft = (debt * LIQ_PENALTY) / WAD; // in USDC wei
        for (uint256 i = 0; i < listedTokens.length && seizeValueLeft > 0; i++) {
            address token = listedTokens[i];
            uint256 bal = _collateral[user][token];
            if (bal == 0) continue;
            uint256 price = oracle.getPrice(token);
            uint256 balValue = (bal * price) / WAD;
            uint256 takeValue = balValue < seizeValueLeft ? balValue : seizeValueLeft;
            uint256 takeAmount = (takeValue * WAD) / price;
            _collateral[user][token] = bal - takeAmount;
            seizeValueLeft -= takeValue;
            if (!MockERC20(token).transfer(msg.sender, takeAmount)) revert TransferFailed();
        }
        if (msg.value > debt) _sendNative(msg.sender, msg.value - debt);
        emit Liquidated(user, msg.sender, debt);
    }

    /* ── operator (Firebreak Mandate hook) ──────────────── */

    function setOperator(address op, bool approved) external {
        isOperator[msg.sender][op] = approved;
        emit OperatorSet(msg.sender, op, approved);
    }

    /// @inheritdoc IPosition
    function operatorWithdrawCollateral(address user, address token, uint256 amount, address to)
        external
        nonReentrant
    {
        if (!isOperator[user][msg.sender]) revert NotOperator();
        _withdraw(user, token, amount, to);
    }

    /* ── views ──────────────────────────────────────────── */

    /// @inheritdoc IPosition
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = _debt[user];
        if (debt == 0) return type(uint256).max;
        uint256 weighted; // Σ collateral value × liqThreshold
        for (uint256 i = 0; i < listedTokens.length; i++) {
            address token = listedTokens[i];
            uint256 bal = _collateral[user][token];
            if (bal == 0) continue;
            uint256 value = (bal * oracle.getPrice(token)) / WAD;
            weighted += (value * listings[token].liqThresholdWad) / WAD;
        }
        return (weighted * WAD) / debt;
    }

    function borrowPowerOf(address user) public view returns (uint256) {
        uint256 power;
        for (uint256 i = 0; i < listedTokens.length; i++) {
            address token = listedTokens[i];
            uint256 bal = _collateral[user][token];
            if (bal == 0) continue;
            uint256 value = (bal * oracle.getPrice(token)) / WAD;
            power += (value * listings[token].ltvWad) / WAD;
        }
        return power;
    }

    /// @inheritdoc IPosition
    function collateralOf(address user, address token) external view returns (uint256) {
        return _collateral[user][token];
    }

    /// @inheritdoc IPosition
    function debtOf(address user) external view returns (uint256) {
        return _debt[user];
    }

    /* ── internals ──────────────────────────────────────── */

    function _withdraw(address user, address token, uint256 amount, address to) internal {
        if (!listings[token].listed) revert Unlisted();
        if (amount == 0) revert ZeroAmount();
        if (_collateral[user][token] < amount) revert InsufficientCollateral();
        _collateral[user][token] -= amount;
        // even an operator cannot leave the position exposed
        if (healthFactor(user) < WAD) revert UnhealthyWithdraw();
        if (!MockERC20(token).transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(user, token, amount, to);
    }

    function _repay(address user, address payer) internal {
        if (msg.value == 0) revert ZeroAmount();
        uint256 debt = _debt[user];
        uint256 pay = msg.value > debt ? debt : msg.value;
        _debt[user] = debt - pay;
        if (msg.value > pay) _sendNative(payer, msg.value - pay);
        emit Repaid(user, payer, pay);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
