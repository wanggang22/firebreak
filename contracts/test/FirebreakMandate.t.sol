// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

contract FirebreakMandateTest is Test {
    MockOracle oracle;
    MockERC20 mEURC; // FX collateral (drifts in the demo)
    MockERC20 mTBILL; // stable collateral (rotate target)
    MiniLend pool;
    MiniSwap amm;
    FirebreakMandate fb;

    address alice = address(0xA11CE);
    address keeper = address(0xFEE9);
    address rando = address(0xBAD);

    uint8 constant DELEVERAGE = 1;
    uint8 constant ROTATE = 2;
    uint8 constant TOPUP = 4;

    function setUp() public {
        oracle = new MockOracle();
        mEURC = new MockERC20("Mock EURC", "mEURC");
        mTBILL = new MockERC20("Mock T-Bill", "mTBILL");
        pool = new MiniLend(address(oracle));
        amm = new MiniSwap();
        fb = new FirebreakMandate();

        oracle.setPrice(address(mEURC), 1.08e18);
        oracle.setPrice(address(mTBILL), 1e18);
        pool.listCollateral(address(mEURC), 0.7e18, 0.8e18);
        pool.listCollateral(address(mTBILL), 0.8e18, 0.9e18); // steadier asset, higher LT
        vm.deal(address(this), 10_000_000e18);
        pool.fund{value: 2_000_000e18}();

        // AMM liquidity both legs
        mEURC.mint(address(this), 2_000_000e18);
        mTBILL.mint(address(this), 2_000_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 1_000_000e18}(address(mEURC), 925_926e18);
        amm.addLiquidity{value: 1_000_000e18}(address(mTBILL), 1_000_000e18);

        // alice: 1000 mEURC collateral, borrow 700 USDC
        mEURC.mint(alice, 1000e18);
        vm.startPrank(alice);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 1000e18);
        pool.borrow(700e18);
        // authorize the Mandate contract as operator on the pool
        pool.setOperator(address(fb), true);
        vm.stopPrank();
        vm.deal(alice, 500e18);
    }

    receive() external payable {}

    function _register(uint8 actions, uint256 maxSpend, uint256 reserveIn) internal {
        vm.prank(alice);
        fb.register{value: reserveIn}(
            FirebreakMandate.Terms({
                pool: address(pool),
                swapVenue: address(amm),
                keeper: keeper,
                hfTrigger: 1.2e18,
                maxSpendPerRescue: maxSpend,
                allowedActions: actions
            })
        );
    }

    function _drift() internal {
        // EURC drifts 1.08 → 0.98 ⇒ HF = 1000*0.98*0.8/700 = 1.12 < 1.2 trigger
        oracle.setPrice(address(mEURC), 0.98e18);
    }

    /* ── registration / reserve ─────────────────────────── */

    function test_Register_StoresTermsAndReserve() public {
        _register(DELEVERAGE | TOPUP, 300e18, 100e18);
        (FirebreakMandate.Terms memory t, bool active, uint256 reserve) = fb.mandateOf(alice);
        assertTrue(active);
        assertEq(reserve, 100e18);
        assertEq(t.keeper, keeper);
        assertEq(t.hfTrigger, 1.2e18);
    }

    function test_WithdrawReserve() public {
        _register(TOPUP, 300e18, 100e18);
        uint256 before = alice.balance;
        vm.prank(alice);
        fb.withdrawReserve(60e18);
        (,, uint256 reserve) = fb.mandateOf(alice);
        assertEq(reserve, 40e18);
        assertEq(alice.balance, before + 60e18);
    }

    function test_RevertWhen_RandoWithdrawsReserve() public {
        _register(TOPUP, 300e18, 100e18);
        vm.prank(rando);
        vm.expectRevert(FirebreakMandate.NoMandate.selector);
        fb.withdrawReserve(1e18);
    }

    /* ── rescue gates ───────────────────────────────────── */

    function test_RevertWhen_RescueByNonKeeper() public {
        _register(DELEVERAGE, 300e18, 0);
        _drift();
        FirebreakMandate.Plan memory plan = _delevPlan(100e18);
        vm.prank(rando);
        vm.expectRevert(FirebreakMandate.NotKeeper.selector);
        fb.rescue(alice, plan);
    }

    function test_RevertWhen_HealthAboveTrigger() public {
        _register(DELEVERAGE, 300e18, 0);
        // no drift: HF = 1.234 > 1.2
        FirebreakMandate.Plan memory plan = _delevPlan(100e18);
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.RescueNotNeeded.selector);
        fb.rescue(alice, plan);
    }

    function test_RevertWhen_ActionNotAllowed() public {
        _register(TOPUP, 300e18, 100e18); // deleverage NOT allowed
        _drift();
        FirebreakMandate.Plan memory plan = _delevPlan(100e18);
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.ActionNotAllowed.selector);
        fb.rescue(alice, plan);
    }

    function test_RevertWhen_Revoked() public {
        _register(DELEVERAGE, 300e18, 0);
        vm.prank(alice);
        fb.revoke();
        _drift();
        FirebreakMandate.Plan memory plan = _delevPlan(100e18);
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.NoMandate.selector);
        fb.rescue(alice, plan);
    }

    /* ── path A: deleverage ─────────────────────────────── */

    function _delevPlan(uint256 amt) internal view returns (FirebreakMandate.Plan memory) {
        uint256 minOut = amm.getUsdcOut(address(mEURC), amt) * 99 / 100;
        return FirebreakMandate.Plan({
            action: DELEVERAGE,
            collateralToken: address(mEURC),
            collateralAmount: amt,
            rotateTo: address(0),
            minSwapOut: minOut,
            minSwapOut2: 0,
            topUpAmount: 0
        });
    }

    function test_Deleverage_ImprovesHealth() public {
        _register(DELEVERAGE, 300e18, 0);
        _drift();
        uint256 hfBefore = pool.healthFactor(alice);
        uint256 debtBefore = pool.debtOf(alice);

        FirebreakMandate.Plan memory plan = _delevPlan(150e18);
        vm.prank(keeper);
        fb.rescue(alice, plan);

        assertGt(pool.healthFactor(alice), hfBefore);
        assertLt(pool.debtOf(alice), debtBefore);
        assertEq(pool.collateralOf(alice, address(mEURC)), 850e18);
    }

    function test_RevertWhen_DeleverageExceedsSpendCap() public {
        _register(DELEVERAGE, 100e18, 0); // cap 100 USDC
        _drift();
        FirebreakMandate.Plan memory plan = _delevPlan(150e18); // ≈161 USDC proceeds > cap
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.SpendCapExceeded.selector);
        fb.rescue(alice, plan);
    }

    /* ── path B: rotate ─────────────────────────────────── */

    function test_Rotate_MovesCollateralToStableAsset() public {
        _register(ROTATE, 500e18, 0);
        _drift();
        uint256 hfBefore = pool.healthFactor(alice);

        uint256 amt = 300e18;
        uint256 out1 = amm.getUsdcOut(address(mEURC), amt);
        uint256 out2 = amm.getTokenOut(address(mTBILL), out1);
        vm.prank(keeper);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: ROTATE,
                collateralToken: address(mEURC),
                collateralAmount: amt,
                rotateTo: address(mTBILL),
                minSwapOut: out1 * 99 / 100,
                minSwapOut2: out2 * 99 / 100,
                topUpAmount: 0
            })
        );

        assertEq(pool.collateralOf(alice, address(mEURC)), 700e18);
        assertGt(pool.collateralOf(alice, address(mTBILL)), 0);
        // rotate into higher-LT asset improves HF even at same value
        assertGt(pool.healthFactor(alice), hfBefore);
    }

    /* ── path C: top-up ─────────────────────────────────── */

    /// The flat-argument entry point exists so managed agent-wallet tooling
    /// (which cannot encode structs) can drive the same rescue. It must be
    /// exactly equivalent — same effects, and the same keeper check.
    function test_RescueFlat_MatchesStructRescue() public {
        _register(TOPUP, 300e18, 200e18);
        _drift();
        uint256 hfBefore = pool.healthFactor(alice);

        vm.prank(keeper);
        fb.rescueFlat(alice, TOPUP, address(0), 0, address(0), 0, 0, 150e18);

        assertEq(pool.debtOf(alice), 550e18);
        (,, uint256 reserve) = fb.mandateOf(alice);
        assertEq(reserve, 50e18);
        assertGt(pool.healthFactor(alice), hfBefore);
    }

    function test_RevertWhen_RescueFlatByNonKeeper() public {
        _register(TOPUP, 300e18, 200e18);
        _drift();
        vm.expectRevert(FirebreakMandate.NotKeeper.selector);
        vm.prank(address(0xBAD));
        fb.rescueFlat(alice, TOPUP, address(0), 0, address(0), 0, 0, 150e18);
    }

    function test_TopUp_RepaysFromReserve() public {
        _register(TOPUP, 300e18, 200e18);
        _drift();
        uint256 hfBefore = pool.healthFactor(alice);

        vm.prank(keeper);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: TOPUP,
                collateralToken: address(0),
                collateralAmount: 0,
                rotateTo: address(0),
                minSwapOut: 0,
                minSwapOut2: 0,
                topUpAmount: 150e18
            })
        );

        assertEq(pool.debtOf(alice), 550e18);
        (,, uint256 reserve) = fb.mandateOf(alice);
        assertEq(reserve, 50e18);
        assertGt(pool.healthFactor(alice), hfBefore);
    }

    function test_RevertWhen_TopUpExceedsReserve() public {
        _register(TOPUP, 300e18, 100e18);
        _drift();
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.InsufficientReserve.selector);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: TOPUP,
                collateralToken: address(0),
                collateralAmount: 0,
                rotateTo: address(0),
                minSwapOut: 0,
                minSwapOut2: 0,
                topUpAmount: 150e18
            })
        );
    }

    /* ── invariant: rescue must improve health ──────────── */

    function test_RevertWhen_RescueDoesNotImproveHealth() public {
        // list a junk asset with LT far below mEURC's: rotating into it REDUCES HF
        MockERC20 mVOL = new MockERC20("Mock Volatile", "mVOL");
        oracle.setPrice(address(mVOL), 1e18);
        pool.listCollateral(address(mVOL), 0.3e18, 0.4e18);
        mVOL.mint(address(this), 2_000_000e18);
        mVOL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 1_000_000e18}(address(mVOL), 1_000_000e18);

        _register(ROTATE, 500e18, 0);
        _drift();

        uint256 amt = 300e18;
        uint256 out1 = amm.getUsdcOut(address(mEURC), amt);
        uint256 out2 = amm.getTokenOut(address(mVOL), out1);
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.NoImprovement.selector);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: ROTATE,
                collateralToken: address(mEURC),
                collateralAmount: amt,
                rotateTo: address(mVOL),
                minSwapOut: out1 * 99 / 100,
                minSwapOut2: out2 * 99 / 100,
                topUpAmount: 0
            })
        );
    }

    /* ── fuzz: spend cap is never exceeded ──────────────── */

    function testFuzz_DeleverageNeverExceedsCap(uint256 amt) public {
        amt = bound(amt, 1e18, 400e18);
        uint256 cap = 200e18;
        _register(DELEVERAGE, cap, 0);
        _drift();

        uint256 quote = amm.getUsdcOut(address(mEURC), amt);
        FirebreakMandate.Plan memory plan = _delevPlan(amt);
        vm.prank(keeper);
        if (quote > cap) {
            vm.expectRevert(FirebreakMandate.SpendCapExceeded.selector);
            fb.rescue(alice, plan);
        } else {
            try fb.rescue(alice, plan) {
            // fine — within cap and improved health
            }
            catch (bytes memory reason) {
                // the only acceptable failure inside the cap is the strict
                // improvement invariant, never the spend cap itself
                assertEq(bytes4(reason), FirebreakMandate.NoImprovement.selector);
            }
        }
    }
}
