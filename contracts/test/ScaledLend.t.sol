// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {ScaledLend} from "../src/ScaledLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

/// Proves the protocol-agnostic claim instead of asserting it: the *same*
/// FirebreakMandate bytecode guards a pool whose internal accounting shares
/// nothing with MiniLend — collateral in shares, debt scaled against an
/// accruing index.
contract ScaledLendTest is Test {
    MockOracle oracle;
    MockERC20 mEURC;
    MockERC20 mTBILL;
    ScaledLend pool;
    MiniSwap amm;
    FirebreakMandate fb;

    address alice = address(0xA11CE);
    address keeper = address(0xFEE9);

    uint8 constant DELEVERAGE = 1;
    uint8 constant ROTATE = 2;
    uint8 constant TOPUP = 4;

    function setUp() public {
        oracle = new MockOracle();
        mEURC = new MockERC20("Mock EURC", "mEURC");
        mTBILL = new MockERC20("Mock T-Bill", "mTBILL");
        pool = new ScaledLend(address(oracle));
        amm = new MiniSwap();
        fb = new FirebreakMandate();

        oracle.setPrice(address(mEURC), 1.08e18);
        oracle.setPrice(address(mTBILL), 1e18);
        pool.listCollateral(address(mEURC), 0.6e18, 0.8e18);
        pool.listCollateral(address(mTBILL), 0.8e18, 0.9e18);

        vm.deal(address(this), 200_000e18);
        pool.fund{value: 5_000e18}();

        mEURC.mint(address(this), 500_000e18);
        mTBILL.mint(address(this), 500_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 50_000e18}(address(mEURC), 46_296e18);
        amm.addLiquidity{value: 50_000e18}(address(mTBILL), 50_000e18);

        mEURC.mint(alice, 1_000e18);
        vm.deal(alice, 1_000e18);
        vm.deal(keeper, 10e18);
    }

    function _openPosition() internal {
        vm.startPrank(alice);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 100e18);
        pool.borrow(50e18);
        pool.setOperator(address(fb), true);
        vm.stopPrank();
    }

    function _register(uint8 actions, uint256 maxSpend, uint256 reserveIn) internal {
        vm.prank(alice);
        fb.register{value: reserveIn}(
            FirebreakMandate.Terms({
                pool: address(pool),
                swapVenue: address(amm),
                keeper: keeper,
                hfTrigger: 1.2e18,
                maxSpendPerRescue: maxSpend,
                maxSlippageWad: 0.02e18,
                minImprovementWad: 0.02e18,
                keeperFee: 0,
                allowedActions: actions
            })
        );
    }

    /* ── the accounting really is different ─────────────── */

    function test_CollateralIsSharesNotAmount() public {
        pool.setExchangeRate(address(mEURC), 1.25e18); // yield-bearing collateral
        _openPosition();
        // 100 tokens in at 1.25 → 80 shares, redeemable for the same 100 tokens
        assertEq(pool.sharesOf(alice, address(mEURC)), 80e18);
        assertEq(pool.collateralOf(alice, address(mEURC)), 100e18);
        // the stored number and the IPosition number are genuinely not the same
        assertTrue(pool.sharesOf(alice, address(mEURC)) != pool.collateralOf(alice, address(mEURC)));
    }

    function test_DebtGrowsWithNoTransactions() public {
        _openPosition();
        uint256 d0 = pool.debtOf(alice);
        uint256 scaled = pool.scaledDebtOf(alice);
        vm.warp(block.timestamp + 30 days);
        uint256 d1 = pool.debtOf(alice);
        assertGt(d1, d0, "debt must accrue on time alone");
        assertEq(pool.scaledDebtOf(alice), scaled, "scaled debt is untouched; only the index moved");
    }

    /// The risk MiniLend cannot express: the oracle never moves, and the
    /// position still slides under the trigger.
    function test_HealthDecaysWithAStillMarket() public {
        _openPosition();
        uint256 priceBefore = oracle.getPrice(address(mEURC));
        uint256 hf0 = pool.healthFactor(alice);
        assertGt(hf0, 1.2e18);

        vm.warp(block.timestamp + 365 days);

        assertEq(oracle.getPrice(address(mEURC)), priceBefore, "market did not move");
        assertLt(pool.healthFactor(alice), hf0, "health decayed anyway");
    }

    /* ── the same Mandate guards it ─────────────────────── */

    function test_SameMandateRescuesADifferentProtocol() public {
        _openPosition();
        _register(DELEVERAGE | TOPUP, 5_000e18, 20e18);

        // drift into the trigger band
        oracle.setPrice(address(mEURC), 0.72e18); // HF = 100*0.72*0.8/50 = 1.152
        uint256 hfBefore = pool.healthFactor(alice);
        assertLt(hfBefore, 1.2e18, "should be under the trigger");

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
                topUpAmount: 12e18
            })
        );

        assertGt(pool.healthFactor(alice), hfBefore, "the unmodified Mandate repaired a foreign pool");
    }

    function test_DeleverageOnScaledCollateral() public {
        pool.setExchangeRate(address(mEURC), 1.25e18);
        _openPosition();
        _register(DELEVERAGE, 5_000e18, 0);

        oracle.setPrice(address(mEURC), 0.72e18); // HF = 100*0.72*0.8/50 = 1.152
        uint256 hfBefore = pool.healthFactor(alice);
        uint256 collBefore = pool.collateralOf(alice, address(mEURC));

        vm.prank(keeper);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: DELEVERAGE,
                collateralToken: address(mEURC),
                collateralAmount: 20e18,
                rotateTo: address(0),
                minSwapOut: 1,
                minSwapOut2: 0,
                topUpAmount: 0
            })
        );

        // shares were burned by token amount, and IPosition still reports tokens
        assertEq(pool.collateralOf(alice, address(mEURC)), collBefore - 20e18);
        assertGt(pool.healthFactor(alice), hfBefore);
    }

    /// A keeper reading the stale index would size the rescue against a debt
    /// that no longer exists. The view must price in time already elapsed.
    function test_ViewsIncludeUnaccruedInterest() public {
        _openPosition();
        vm.warp(block.timestamp + 90 days);
        uint256 viewDebt = pool.debtOf(alice);
        pool.accrue();                       // write the index to state
        assertEq(pool.debtOf(alice), viewDebt, "view already matched the written index");
    }

    /* ── admin surface ──────────────────────────────────── */

    /// Raising the exchange rate raises every holder's collateral value, and
    /// with it their health factor and borrowing power. Left open, this is a
    /// mint-collateral-from-nothing button.
    function test_RevertWhen_StrangerRaisesExchangeRate() public {
        _openPosition();
        uint256 hfBefore = pool.healthFactor(alice);

        vm.prank(address(0xBAD));
        vm.expectRevert(ScaledLend.NotOwner.selector);
        pool.setExchangeRate(address(mEURC), 10e18);

        assertEq(pool.healthFactor(alice), hfBefore, "health unchanged by the attempt");
    }

    function test_RevertWhen_StrangerRelistsCollateral() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ScaledLend.NotOwner.selector);
        pool.listCollateral(address(mEURC), 0.99e18, 0.99e18); // would make bad debt borrowable
    }

    function test_RevertWhen_StrangerSetsRate() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ScaledLend.NotOwner.selector);
        pool.setRate(0);                                        // would freeze interest for everyone
    }

    /// Funding is deliberately open — paying into the pool harms no one.
    function test_AnyoneMayFund() public {
        vm.deal(address(0xBAD), 5e18);
        vm.prank(address(0xBAD));
        pool.fund{value: 5e18}();
        assertEq(address(pool).balance, 5_005e18);
    }

    /* ── the bounds still hold on a foreign pool ────────── */

    function test_RevertWhen_RescueAboveTriggerOnScaledPool() public {
        _openPosition();
        _register(TOPUP, 5_000e18, 20e18);
        vm.prank(keeper);
        vm.expectRevert(FirebreakMandate.RescueNotNeeded.selector);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: TOPUP, collateralToken: address(0), collateralAmount: 0,
                rotateTo: address(0), minSwapOut: 0, minSwapOut2: 0, topUpAmount: 1e18
            })
        );
    }

    function test_RevertWhen_NonKeeperRescuesScaledPool() public {
        _openPosition();
        _register(TOPUP, 5_000e18, 20e18);
        oracle.setPrice(address(mEURC), 0.72e18); // HF = 100*0.72*0.8/50 = 1.152
        vm.prank(address(0xBAD));
        vm.expectRevert(FirebreakMandate.NotKeeper.selector);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: TOPUP, collateralToken: address(0), collateralAmount: 0,
                rotateTo: address(0), minSwapOut: 0, minSwapOut2: 0, topUpAmount: 1e18
            })
        );
    }
}
