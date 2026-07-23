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
    error AlreadyRegistered();
    error SlippageExceeded();

    event MandateRegistered(address indexed user, Terms terms, uint256 reserve);
    event MandateRevoked(address indexed user, uint256 reserveReturned);
    event ReserveToppedUp(address indexed user, uint256 amount);
    event ReserveWithdrawn(address indexed user, uint256 amount);
    event KeeperPaid(address indexed user, address indexed keeper, uint256 fee);
    event RescueExecuted(address indexed user, uint8 action, uint256 spent, uint256 hfBefore, uint256 hfAfter);

    uint8 public constant ACTION_DELEVERAGE = 1;
    uint8 public constant ACTION_ROTATE = 2;
    uint8 public constant ACTION_TOPUP = 4;
    uint256 private constant WAD = 1e18;

    struct Terms {
        address pool; // IPosition to guard
        address swapVenue; // the ONLY venue rescues may route through
        address keeper; // the ONLY address allowed to trigger rescues
        uint256 hfTrigger; // WAD; rescue only when HF < this
        uint256 maxSpendPerRescue; // max collateral VALUE (oracle) moved per rescue
        uint256 maxSlippageWad; // WAD; the swap must return >= (1 - this) of the collateral's oracle value
        uint256 minImprovementWad; // WAD; a rescue must raise HF by at least this much
        uint256 keeperFee; // native USDC paid from reserve on a SUCCESSFUL rescue
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
        // Never silently overwrite a live mandate — that would orphan the
        // existing reserve. Revoke (which refunds) before re-registering, or
        // use topUpReserve/withdrawReserve to adjust funds.
        if (mandates[msg.sender].active) revert AlreadyRegistered();
        mandates[msg.sender] = State({terms: terms, active: true, reserve: msg.value});
        emit MandateRegistered(msg.sender, terms, msg.value);
    }

    function topUpReserve() external payable {
        _topUpReserve(msg.sender, msg.value);
    }

    /// @notice Fund someone else's rescue reserve. Permissionless on purpose:
    ///         the keeper refills a borrower's reserve from their cross-chain
    ///         Unified Balance, and the funds land under the borrower's own
    ///         mandate. Only the borrower can withdraw them, and the keeper can
    ///         only spend them through the same bounded `rescue` path — so a
    ///         third party paying in can never gain control of anything.
    function topUpReserveFor(address user) external payable {
        _topUpReserve(user, msg.value);
    }

    function _topUpReserve(address user, uint256 amount) private {
        State storage s = mandates[user];
        if (!s.active) revert NoMandate();
        if (amount == 0) revert ZeroAmount();
        s.reserve += amount;
        emit ReserveToppedUp(user, amount);
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
        _rescue(user, plan);
    }

    /// @notice Same rescue, with the plan flattened into positional arguments.
    ///         Managed agent-wallet tooling (e.g. Circle Agent Wallets) cannot
    ///         encode struct parameters, so this gives an equivalent entry point
    ///         that such a keeper can call. Identical checks — it delegates to
    ///         the same internal path, so no bound is weakened.
    function rescueFlat(
        address user,
        uint8 action,
        address collateralToken,
        uint256 collateralAmount,
        address rotateTo,
        uint256 minSwapOut,
        uint256 minSwapOut2,
        uint256 topUpAmount
    ) external nonReentrant {
        _rescue(
            user,
            Plan(action, collateralToken, collateralAmount, rotateTo, minSwapOut, minSwapOut2, topUpAmount)
        );
    }

    function _rescue(address user, Plan memory plan) internal {
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
        // Must be a *meaningful* jump, not a dust improvement — otherwise a
        // keeper could loop tiny rescues, bleeding the position through fees.
        if (hfAfter < hfBefore + t.minImprovementWad) revert NoImprovement();

        emit RescueExecuted(user, plan.action, spent, hfBefore, hfAfter);

        // Paid last, and only here: every bound above has already passed, so a
        // keeper is paid exactly when it did the job the borrower asked for.
        //
        // The fee is a flat amount the borrower signed, not a share of what was
        // moved — a percentage would pay the keeper more for larger rescues and
        // quietly reward taking the most expensive viable path. Flat means the
        // keeper is indifferent to size, so the cheapest-that-works path costs
        // it nothing to choose.
        //
        // Nor can it farm frequency. A rescue is only reachable below the
        // borrower's trigger, and it must lift health by minImprovement — which
        // pushes the position back out of the band it would need to re-enter to
        // be billed again. Keeper revenue is therefore a function of how often
        // the market actually threatens the position, not of anything the
        // keeper decides.
        if (t.keeperFee > 0) {
            // Solvency never blocks the rescue: the position is already repaired
            // and the improvement check has passed. An underfunded reserve costs
            // the keeper its fee, it does not cost the borrower the rescue.
            uint256 pay = t.keeperFee > s.reserve ? s.reserve : t.keeperFee;
            if (pay > 0) {
                s.reserve -= pay;
                _sendNative(t.keeper, pay);
                emit KeeperPaid(user, t.keeper, pay);
            }
        }
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
    ///      `spent` is the ORACLE VALUE of collateral pulled — that is the blast
    ///      radius the user capped, and it can't be gamed by a keeper who
    ///      sandwiches the swap to minimise the USDC leg. The swap must return
    ///      at least (1 - maxSlippageWad) of that value, a floor the USER signed
    ///      — the keeper's minSwapOut is only an extra, non-binding hint.
    function _deleverage(address user, State storage s, Terms memory t, Plan memory plan)
        internal
        returns (uint256 spent)
    {
        IPosition pool = IPosition(t.pool);
        uint256 collValue = (plan.collateralAmount * pool.priceOf(plan.collateralToken)) / WAD;

        pool.rescuePull(plan.collateralToken, plan.collateralAmount, address(this));
        MockERC20(plan.collateralToken).approve(t.swapVenue, plan.collateralAmount);
        uint256 out = MiniSwap(payable(t.swapVenue))
            .swapTokenForUsdc(plan.collateralToken, plan.collateralAmount, plan.minSwapOut);

        // user-signed slippage floor on the value actually recovered
        if (out < (collValue * (WAD - t.maxSlippageWad)) / WAD) revert SlippageExceeded();

        uint256 debt = pool.debtOf(user);
        uint256 pay = out > debt ? debt : out;
        pool.repayFor{value: pay}(user);
        if (out > pay) s.reserve += out - pay; // surplus stays the user's
        return collValue;
    }

    /// @dev B: pull drifting collateral → swap to USDC → swap to the steadier
    ///      asset → deposit back into the user's position. Same value-based cap
    ///      and user-signed round-trip slippage floor as deleverage: the user
    ///      must end up with at least (1 - maxSlippageWad) of the moved value in
    ///      the new asset, so a keeper can't rotate value away via two swaps.
    function _rotate(address user, Terms memory t, Plan memory plan) internal returns (uint256 spent) {
        IPosition pool = IPosition(t.pool);
        uint256 collValue = (plan.collateralAmount * pool.priceOf(plan.collateralToken)) / WAD;

        pool.rescuePull(plan.collateralToken, plan.collateralAmount, address(this));
        MockERC20(plan.collateralToken).approve(t.swapVenue, plan.collateralAmount);
        MiniSwap venue = MiniSwap(payable(t.swapVenue));
        uint256 usdcOut = venue.swapTokenForUsdc(plan.collateralToken, plan.collateralAmount, plan.minSwapOut);
        uint256 tokenOut = venue.swapUsdcForToken{value: usdcOut}(plan.rotateTo, plan.minSwapOut2);

        // round-trip slippage floor on the VALUE that lands back in the position
        uint256 gotValue = (tokenOut * pool.priceOf(plan.rotateTo)) / WAD;
        if (gotValue < (collValue * (WAD - t.maxSlippageWad)) / WAD) revert SlippageExceeded();

        MockERC20(plan.rotateTo).approve(t.pool, tokenOut);
        pool.depositCollateralFor(user, plan.rotateTo, tokenOut);
        return collValue;
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
