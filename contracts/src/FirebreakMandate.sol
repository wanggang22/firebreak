// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPosition, IRescueCallback} from "./interfaces/IPosition.sol";
import {MockERC20} from "./MockERC20.sol";
import {MiniSwap} from "./MiniSwap.sol";

/// @title FirebreakMandate — a bounded, conditional, non-custodial rescue authorization.
/// @notice The soul of Firebreak. A borrower signs a Mandate: *if* my health
///         factor falls below `hfTrigger`, *then* this keeper may execute one
///         of the whitelisted rescue actions, moving at most
///         `maxSpendPerRescue`, through the whitelisted venue only — and the
///         rescue MUST leave my position healthier than it found it.
///
///         Funds never sit with the keeper. Collateral flows through this
///         contract atomically within a single rescue transaction; the only
///         resting balance is the user's own prepaid rescue reserve.
///
///         Actions (bitmask):
///           1 DELEVERAGE — sell a slice of collateral, repay debt
///           2 ROTATE     — swap drifting collateral into a steadier asset
///           4 TOPUP      — repay debt from the user's prepaid reserve
contract FirebreakMandate is IRescueCallback {
    error NoMandate();
    error NotKeeper();
    error NotPool();
    error RescueNotNeeded();
    error ActionNotAllowed();
    error SpendCapExceeded();
    error NoImprovement();
    error InsufficientReserve();
    error UnknownAction();
    error ZeroAmount();
    error TransferFailed();
    error Reentrancy();

    event MandateRegistered(address indexed user, Terms terms, uint256 reserve);
    event MandateRevoked(address indexed user, uint256 reserveReturned);
    event ReserveToppedUp(address indexed user, uint256 amount);
    event ReserveWithdrawn(address indexed user, uint256 amount);
    event RescueExecuted(address indexed user, uint8 action, uint256 spent, uint256 hfBefore, uint256 hfAfter);

    uint8 public constant ACTION_DELEVERAGE = 1;
    uint8 public constant ACTION_ROTATE = 2;
    uint8 public constant ACTION_TOPUP = 4;

    struct Terms {
        address pool; // IPosition to guard
        address swapVenue; // the ONLY venue rescues may route through
        address keeper; // the ONLY address allowed to trigger rescues
        uint256 hfTrigger; // WAD; rescue only when HF < this
        uint256 maxSpendPerRescue; // native USDC value moved per rescue, max
        uint8 allowedActions; // bitmask of ACTION_*
    }

    struct Plan {
        uint8 action;
        address collateralToken; // A/B: collateral to act on
        uint256 collateralAmount; // A/B: amount to withdraw
        address rotateTo; // B: target collateral
        uint256 minSwapOut; // A/B: slippage guard, first leg
        uint256 minSwapOut2; // B: slippage guard, second leg
        uint256 topUpAmount; // C
    }

    struct State {
        Terms terms;
        bool active;
        uint256 reserve; // user's prepaid native USDC
    }

    mapping(address => State) private mandates;

    uint256 private _lock = 1;

    // transient rescue context (set only within rescue())
    address private _rescuePool;
    uint256 private _lastSpent;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    receive() external payable {} // swap proceeds land here mid-rescue

    /* ── user side ──────────────────────────────────────── */

    function register(Terms calldata terms) external payable {
        mandates[msg.sender] = State({terms: terms, active: true, reserve: msg.value});
        emit MandateRegistered(msg.sender, terms, msg.value);
    }

    function topUpReserve() external payable {
        State storage s = mandates[msg.sender];
        if (!s.active) revert NoMandate();
        if (msg.value == 0) revert ZeroAmount();
        s.reserve += msg.value;
        emit ReserveToppedUp(msg.sender, msg.value);
    }

    function withdrawReserve(uint256 amount) external nonReentrant {
        State storage s = mandates[msg.sender];
        if (!s.active) revert NoMandate();
        if (amount > s.reserve) revert InsufficientReserve();
        s.reserve -= amount;
        _sendNative(msg.sender, amount);
        emit ReserveWithdrawn(msg.sender, amount);
    }

    function revoke() external nonReentrant {
        State storage s = mandates[msg.sender];
        if (!s.active) revert NoMandate();
        uint256 refund = s.reserve;
        delete mandates[msg.sender];
        if (refund > 0) _sendNative(msg.sender, refund);
        emit MandateRevoked(msg.sender, refund);
    }

    /* ── keeper side ────────────────────────────────────── */

    /// @notice Execute a rescue. Every boundary the user signed is enforced
    ///         on-chain here — the keeper is untrusted by construction.
    function rescue(address user, Plan memory plan) external nonReentrant {
        State storage s = mandates[user];
        if (!s.active) revert NoMandate();
        Terms memory t = s.terms;
        if (msg.sender != t.keeper) revert NotKeeper();

        IPosition pool = IPosition(t.pool);
        uint256 hfBefore = pool.healthFactor(user);
        if (hfBefore >= t.hfTrigger) revert RescueNotNeeded();
        if (t.allowedActions & plan.action == 0) revert ActionNotAllowed();

        uint256 spent;
        if (plan.action == ACTION_TOPUP) {
            // repay-only: no collateral leaves, so no flash bracket needed
            spent = _topUp(user, s, t, plan);
        } else if (plan.action == ACTION_DELEVERAGE || plan.action == ACTION_ROTATE) {
            // collateral must leave before the swap+repay lands → flash bracket
            _rescuePool = t.pool;
            _lastSpent = 0;
            pool.operatorRescue(user, abi.encode(plan));
            _rescuePool = address(0);
            spent = _lastSpent;
        } else {
            revert UnknownAction();
        }

        if (spent > t.maxSpendPerRescue) revert SpendCapExceeded();

        uint256 hfAfter = pool.healthFactor(user);
        if (hfAfter <= hfBefore) revert NoImprovement();

        emit RescueExecuted(user, plan.action, spent, hfBefore, hfAfter);
    }

    /// @notice Flash-rescue callback, invoked by the pool mid-bracket. Only the
    ///         pool we are actively rescuing through may call this.
    function onFirebreakRescue(address user, bytes calldata data) external {
        if (msg.sender != _rescuePool) revert NotPool();
        Plan memory plan = abi.decode(data, (Plan));
        State storage s = mandates[user];
        Terms memory t = s.terms;
        if (plan.action == ACTION_DELEVERAGE) {
            _lastSpent = _deleverage(user, s, t, plan);
        } else {
            _lastSpent = _rotate(user, t, plan);
        }
    }

    /* ── views ──────────────────────────────────────────── */

    function mandateOf(address user) external view returns (Terms memory terms, bool active, uint256 reserve) {
        State storage s = mandates[user];
        return (s.terms, s.active, s.reserve);
    }

    /* ── rescue paths ───────────────────────────────────── */

    /// @dev A: pull a slice of collateral → sell for USDC → repay debt.
    ///      Any proceeds beyond the outstanding debt land in the reserve.
    function _deleverage(address user, State storage s, Terms memory t, Plan memory plan)
        internal
        returns (uint256 spent)
    {
        IPosition pool = IPosition(t.pool);
        pool.rescuePull(plan.collateralToken, plan.collateralAmount, address(this));

        MockERC20(plan.collateralToken).approve(t.swapVenue, plan.collateralAmount);
        uint256 out = MiniSwap(payable(t.swapVenue))
            .swapTokenForUsdc(plan.collateralToken, plan.collateralAmount, plan.minSwapOut);

        uint256 debt = pool.debtOf(user);
        uint256 pay = out > debt ? debt : out;
        pool.repayFor{value: pay}(user);
        if (out > pay) s.reserve += out - pay; // surplus stays the user's
        return out;
    }

    /// @dev B: pull drifting collateral → swap to USDC → swap to the steadier
    ///      asset → deposit back into the user's position.
    function _rotate(address user, Terms memory t, Plan memory plan) internal returns (uint256 spent) {
        IPosition pool = IPosition(t.pool);
        pool.rescuePull(plan.collateralToken, plan.collateralAmount, address(this));

        MockERC20(plan.collateralToken).approve(t.swapVenue, plan.collateralAmount);
        MiniSwap venue = MiniSwap(payable(t.swapVenue));
        uint256 usdcOut = venue.swapTokenForUsdc(plan.collateralToken, plan.collateralAmount, plan.minSwapOut);
        uint256 tokenOut = venue.swapUsdcForToken{value: usdcOut}(plan.rotateTo, plan.minSwapOut2);

        MockERC20(plan.rotateTo).approve(t.pool, tokenOut);
        pool.depositCollateralFor(user, plan.rotateTo, tokenOut);
        return usdcOut;
    }

    /// @dev C: repay debt straight from the user's prepaid reserve.
    function _topUp(address user, State storage s, Terms memory t, Plan memory plan) internal returns (uint256 spent) {
        IPosition pool = IPosition(t.pool);
        uint256 debt = pool.debtOf(user);
        uint256 pay = plan.topUpAmount > debt ? debt : plan.topUpAmount;
        if (pay == 0) revert ZeroAmount();
        if (pay > s.reserve) revert InsufficientReserve();
        s.reserve -= pay;
        pool.repayFor{value: pay}(user);
        return pay;
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
