// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPosition, IRescueCallback} from "./interfaces/IPosition.sol";
import {MockOracle} from "./MockOracle.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title ScaledLend — a second, deliberately different lending protocol.
///
/// @notice Firebreak claims to be protocol-agnostic. With only MiniLend behind
///         `IPosition` that claim is self-certified: one adapter, written by us,
///         shaped like the interface. ScaledLend exists to falsify it.
///
///         Nothing about its internal accounting resembles MiniLend:
///
///           MiniLend    collateral and debt stored as raw amounts
///           ScaledLend  collateral stored as *shares* redeemable at a growing
///                       exchange rate; debt stored *scaled* against a borrow
///                       index that accrues every second
///
///         This is how Aave and Compound actually work, and it is the case that
///         breaks naive integrations: a keeper that assumes `collateralOf`
///         returns a stored number, or that debt only changes when someone
///         transacts, computes the wrong size here. The same FirebreakMandate
///         and the same unmodified keeper agent guard both pools.
///
///         It also surfaces a risk MiniLend cannot express. There, health only
///         falls when the oracle moves — a drift that may never come. Here the
///         borrow index rises every second, so **health decays on its own**,
///         with the market perfectly still. That decay is not a possibility to
///         hedge; it is arithmetic, and it is the purest form of the slow slide
///         Firebreak exists to catch.
contract ScaledLend is IPosition {
    uint256 private constant WAD = 1e18;
    uint256 private constant LIQ_PENALTY = 1.1e18;

    struct Listing {
        bool listed;
        uint256 ltvWad;
        uint256 liqThresholdWad;
    }

    MockOracle public immutable oracle;

    mapping(address => Listing) public listings;
    address[] public listedTokens;

    /// Collateral as redeemable shares, not raw token amounts.
    mapping(address => mapping(address => uint256)) private _shares;
    /// WAD shares→token rate per collateral, ≥ 1e18 and non-decreasing.
    mapping(address => uint256) public exchangeRateWad;

    /// Debt scaled against `borrowIndex`; the raw number is meaningless alone.
    mapping(address => uint256) private _scaledDebt;
    uint256 public borrowIndex = WAD;
    uint256 public lastAccrual;
    /// Per-second interest, WAD. 3170979198 ≈ 10% APR.
    uint256 public ratePerSecondWad = 3170979198;

    mapping(address => mapping(address => bool)) public isOperator;

    address private _rescuer;
    address private _rescueUser;
    uint256 private _lock = 1;

    error Unlisted();
    error ZeroAmount();
    error InsufficientCollateral();
    error UnhealthyWithdraw();
    error NotOperator();
    error NotRescuing();
    error TransferFailed();
    error Reentrancy();
    error HealthyPosition();
    error InsufficientRepay();
    error Undercollateralized();

    event Deposited(address indexed user, address indexed token, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, address indexed token, uint256 amount, address to);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, address indexed payer, uint256 amount);
    event Liquidated(address indexed user, address indexed by, uint256 debtRepaid);
    event OperatorSet(address indexed user, address indexed op, bool approved);
    event Accrued(uint256 borrowIndex, uint256 elapsed);

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// Interest is owed for elapsed time whether or not anyone poked the pool,
    /// so every entry point accrues before reading or writing balances.
    modifier accrues() {
        _accrue();
        _;
    }

    constructor(address oracle_) {
        oracle = MockOracle(oracle_);
        lastAccrual = block.timestamp;
    }

    receive() external payable {}

    /* ── admin ──────────────────────────────────────────── */

    function listCollateral(address token, uint256 ltvWad, uint256 liqThresholdWad) external {
        if (!listings[token].listed) listedTokens.push(token);
        listings[token] = Listing({listed: true, ltvWad: ltvWad, liqThresholdWad: liqThresholdWad});
        if (exchangeRateWad[token] == 0) exchangeRateWad[token] = WAD;
    }

    function fund() external payable {}

    function setRate(uint256 perSecondWad) external accrues {
        ratePerSecondWad = perSecondWad;
    }

    /// Yield-bearing collateral: shares redeem for more of the token over time.
    function setExchangeRate(address token, uint256 rateWad) external {
        require(rateWad >= exchangeRateWad[token], "rate must not fall");
        exchangeRateWad[token] = rateWad;
    }

    /* ── interest ───────────────────────────────────────── */

    function _accrue() internal {
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return;
        // simple (non-compounding) accrual: index *= 1 + rate*elapsed
        borrowIndex += (borrowIndex * ratePerSecondWad * elapsed) / WAD;
        lastAccrual = block.timestamp;
        emit Accrued(borrowIndex, elapsed);
    }

    /// @notice Anyone may bring the index current; state-changing so the effect
    ///         of pure time passing is observable on-chain.
    function accrue() external {
        _accrue();
    }

    /// Index the pool *would* have right now, without writing state — so views
    /// never under-report a debt that has been accruing since the last poke.
    function currentIndex() public view returns (uint256) {
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return borrowIndex;
        return borrowIndex + (borrowIndex * ratePerSecondWad * elapsed) / WAD;
    }

    /* ── user ───────────────────────────────────────────── */

    function depositCollateral(address token, uint256 amount) external accrues {
        _deposit(msg.sender, token, amount);
    }

    /// @inheritdoc IPosition
    function depositCollateralFor(address user, address token, uint256 amount) external accrues {
        _deposit(user, token, amount);
    }

    function withdrawCollateral(address token, uint256 amount) external nonReentrant accrues {
        _withdraw(msg.sender, token, amount, msg.sender);
    }

    function borrow(uint256 amount) external nonReentrant accrues {
        if (amount == 0) revert ZeroAmount();
        uint256 idx = borrowIndex;
        _scaledDebt[msg.sender] += (amount * WAD) / idx;
        if (_debtOf(msg.sender, idx) > borrowPowerOf(msg.sender)) revert Undercollateralized();
        _sendNative(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay() external payable accrues {
        _repay(msg.sender, msg.sender);
    }

    /// @inheritdoc IPosition
    function repayFor(address user) external payable accrues {
        _repay(user, msg.sender);
    }

    function liquidate(address user) external payable nonReentrant accrues {
        if (healthFactor(user) >= WAD) revert HealthyPosition();
        uint256 debt = _debtOf(user, borrowIndex);
        if (msg.value < debt) revert InsufficientRepay();
        _scaledDebt[user] = 0;

        uint256 seizeValueLeft = (debt * LIQ_PENALTY) / WAD;
        for (uint256 i = 0; i < listedTokens.length && seizeValueLeft > 0; i++) {
            address token = listedTokens[i];
            uint256 bal = _collateralOf(user, token);
            if (bal == 0) continue;
            uint256 price = oracle.getPrice(token);
            uint256 balValue = (bal * price) / WAD;
            uint256 takeValue = balValue < seizeValueLeft ? balValue : seizeValueLeft;
            uint256 takeAmount = (takeValue * WAD) / price;
            _burnShares(user, token, takeAmount);
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
        accrues
    {
        if (!isOperator[user][msg.sender]) revert NotOperator();
        _withdraw(user, token, amount, to);
    }

    /// @inheritdoc IPosition
    function operatorRescue(address user, bytes calldata data) external nonReentrant accrues {
        if (!isOperator[user][msg.sender]) revert NotOperator();
        _rescuer = msg.sender;
        _rescueUser = user;
        IRescueCallback(msg.sender).onFirebreakRescue(user, data);
        _rescuer = address(0);
        _rescueUser = address(0);
    }

    /// @inheritdoc IPosition
    function rescuePull(address token, uint256 amount, address to) external {
        if (msg.sender != _rescuer) revert NotRescuing();
        address user = _rescueUser;
        if (_collateralOf(user, token) < amount) revert InsufficientCollateral();
        _burnShares(user, token, amount);
        if (!MockERC20(token).transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(user, token, amount, to);
    }

    /* ── views ──────────────────────────────────────────── */

    /// @inheritdoc IPosition
    /// @dev Uses `currentIndex()`, so health reflects interest accrued since the
    ///      last write. A view that used the stale index would tell the keeper
    ///      the position is safer than it is.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = _debtOf(user, currentIndex());
        if (debt == 0) return type(uint256).max;
        uint256 weighted;
        for (uint256 i = 0; i < listedTokens.length; i++) {
            address token = listedTokens[i];
            uint256 bal = _collateralOf(user, token);
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
            uint256 bal = _collateralOf(user, token);
            if (bal == 0) continue;
            uint256 value = (bal * oracle.getPrice(token)) / WAD;
            power += (value * listings[token].ltvWad) / WAD;
        }
        return power;
    }

    /// @inheritdoc IPosition
    /// @dev Converts shares→tokens. The stored number is shares, never this.
    function collateralOf(address user, address token) external view returns (uint256) {
        return _collateralOf(user, token);
    }

    /// @inheritdoc IPosition
    function debtOf(address user) external view returns (uint256) {
        return _debtOf(user, currentIndex());
    }

    /// @inheritdoc IPosition
    function priceOf(address token) external view returns (uint256) {
        return oracle.getPrice(token);
    }

    function sharesOf(address user, address token) external view returns (uint256) {
        return _shares[user][token];
    }

    function scaledDebtOf(address user) external view returns (uint256) {
        return _scaledDebt[user];
    }

    /* ── internals ──────────────────────────────────────── */

    function _collateralOf(address user, address token) internal view returns (uint256) {
        uint256 rate = exchangeRateWad[token];
        if (rate == 0) return 0;
        return (_shares[user][token] * rate) / WAD;
    }

    function _debtOf(address user, uint256 idx) internal view returns (uint256) {
        return (_scaledDebt[user] * idx) / WAD;
    }

    function _burnShares(address user, address token, uint256 amount) internal {
        uint256 rate = exchangeRateWad[token];
        uint256 sh = (amount * WAD + rate - 1) / rate; // round up: never under-burn
        uint256 have = _shares[user][token];
        _shares[user][token] = sh >= have ? 0 : have - sh;
    }

    function _deposit(address user, address token, uint256 amount) internal {
        if (!listings[token].listed) revert Unlisted();
        if (amount == 0) revert ZeroAmount();
        uint256 sh = (amount * WAD) / exchangeRateWad[token];
        _shares[user][token] += sh;
        if (!MockERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(user, token, amount, sh);
    }

    function _withdraw(address user, address token, uint256 amount, address to) internal {
        if (!listings[token].listed) revert Unlisted();
        if (amount == 0) revert ZeroAmount();
        if (_collateralOf(user, token) < amount) revert InsufficientCollateral();
        _burnShares(user, token, amount);
        if (healthFactor(user) < WAD) revert UnhealthyWithdraw();
        if (!MockERC20(token).transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(user, token, amount, to);
    }

    function _repay(address user, address payer) internal {
        if (msg.value == 0) revert ZeroAmount();
        uint256 idx = borrowIndex;
        uint256 debt = _debtOf(user, idx);
        uint256 pay = msg.value > debt ? debt : msg.value;
        _scaledDebt[user] = debt == pay ? 0 : ((debt - pay) * WAD) / idx;
        if (msg.value > pay) _sendNative(payer, msg.value - pay);
        emit Repaid(user, payer, pay);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
