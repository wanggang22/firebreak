// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";

contract MiniLendTest is Test {
    MockOracle oracle;
    MockERC20 mEURC;
    MiniLend pool;

    address alice = address(0xA11CE);
    address liq = address(0x11C);
    address operator = address(0x0FE);

    // listing params: LTV 70%, liquidation threshold 80%
    uint256 constant LTV = 0.7e18;
    uint256 constant LT = 0.8e18;

    function setUp() public {
        oracle = new MockOracle();
        mEURC = new MockERC20("Mock EURC", "mEURC");
        pool = new MiniLend(address(oracle));

        oracle.setPrice(address(mEURC), 1.08e18); // 1 EURC = 1.08 USDC
        pool.listCollateral(address(mEURC), LTV, LT);
        pool.fund{value: 1_000_000e18}(); // pool liquidity (native USDC)

        mEURC.mint(alice, 10_000e18);
        vm.prank(alice);
        mEURC.approve(address(pool), type(uint256).max);
        vm.deal(alice, 10e18); // gas money / repay dust
        vm.deal(liq, 2_000_000e18);
    }

    // deal the test contract funding budget
    receive() external payable {}

    function _depositAndBorrow(uint256 dep, uint256 borrow) internal {
        vm.startPrank(alice);
        pool.depositCollateral(address(mEURC), dep);
        pool.borrow(borrow);
        vm.stopPrank();
    }

    /* ── deposit / withdraw ─────────────────────────────── */

    function test_DepositCollateral() public {
        vm.prank(alice);
        pool.depositCollateral(address(mEURC), 1000e18);
        assertEq(pool.collateralOf(alice, address(mEURC)), 1000e18);
        assertEq(mEURC.balanceOf(address(pool)), 1000e18);
    }

    function test_RevertWhen_DepositUnlistedToken() public {
        MockERC20 junk = new MockERC20("Junk", "JNK");
        junk.mint(alice, 1e18);
        vm.startPrank(alice);
        junk.approve(address(pool), 1e18);
        vm.expectRevert(MiniLend.Unlisted.selector);
        pool.depositCollateral(address(junk), 1e18);
        vm.stopPrank();
    }

    function test_WithdrawCollateral_NoDebt() public {
        vm.startPrank(alice);
        pool.depositCollateral(address(mEURC), 1000e18);
        pool.withdrawCollateral(address(mEURC), 400e18);
        vm.stopPrank();
        assertEq(pool.collateralOf(alice, address(mEURC)), 600e18);
        assertEq(mEURC.balanceOf(alice), 9400e18);
    }

    function test_RevertWhen_WithdrawMakesUnhealthy() public {
        // 1000 mEURC @1.08 → borrowing power 756. borrow 700 → withdrawing 500 breaks HF
        _depositAndBorrow(1000e18, 700e18);
        vm.prank(alice);
        vm.expectRevert(MiniLend.UnhealthyWithdraw.selector);
        pool.withdrawCollateral(address(mEURC), 500e18);
    }

    /* ── borrow / repay ─────────────────────────────────── */

    function test_Borrow_TransfersNative() public {
        uint256 before = alice.balance;
        _depositAndBorrow(1000e18, 500e18);
        assertEq(alice.balance, before + 500e18);
        assertEq(pool.debtOf(alice), 500e18);
    }

    function test_RevertWhen_BorrowExceedsLTV() public {
        // power = 1000 * 1.08 * 0.7 = 756
        vm.startPrank(alice);
        pool.depositCollateral(address(mEURC), 1000e18);
        vm.expectRevert(MiniLend.InsufficientCollateral.selector);
        pool.borrow(757e18);
        vm.stopPrank();
    }

    function test_RevertWhen_PoolIlliquid() public {
        MiniLend dry = new MiniLend(address(oracle));
        dry.listCollateral(address(mEURC), LTV, LT);
        vm.startPrank(alice);
        mEURC.approve(address(dry), 1000e18);
        dry.depositCollateral(address(mEURC), 1000e18);
        vm.expectRevert(MiniLend.PoolIlliquid.selector);
        dry.borrow(100e18);
        vm.stopPrank();
    }

    function test_RepayPartial() public {
        _depositAndBorrow(1000e18, 500e18);
        vm.prank(alice);
        pool.repay{value: 200e18}();
        assertEq(pool.debtOf(alice), 300e18);
    }

    function test_Repay_RefundsExcess() public {
        _depositAndBorrow(1000e18, 500e18);
        vm.deal(alice, 1000e18);
        uint256 before = alice.balance;
        vm.prank(alice);
        pool.repay{value: 600e18}(); // 100 over
        assertEq(pool.debtOf(alice), 0);
        assertEq(alice.balance, before - 500e18);
    }

    /* ── health factor ──────────────────────────────────── */

    function test_HealthFactor_NoDebtIsMax() public {
        vm.prank(alice);
        pool.depositCollateral(address(mEURC), 1000e18);
        assertEq(pool.healthFactor(alice), type(uint256).max);
    }

    function test_HealthFactor_KnownValue() public {
        // HF = 1000 * 1.08 * 0.8 / 500 = 1.728
        _depositAndBorrow(1000e18, 500e18);
        assertEq(pool.healthFactor(alice), 1.728e18);
    }

    function test_HealthFactor_DropsWithPrice() public {
        _depositAndBorrow(1000e18, 700e18);
        // drift: 1.08 → 0.85 ⇒ HF = 1000*0.85*0.8/700 ≈ 0.971
        oracle.setPrice(address(mEURC), 0.85e18);
        assertLt(pool.healthFactor(alice), 1e18);
    }

    /* ── liquidation ────────────────────────────────────── */

    function test_RevertWhen_LiquidateHealthy() public {
        _depositAndBorrow(1000e18, 500e18);
        vm.prank(liq);
        vm.expectRevert(MiniLend.HealthyPosition.selector);
        pool.liquidate{value: 500e18}(alice);
    }

    function test_Liquidate_SeizesCollateralWithPenalty() public {
        _depositAndBorrow(1000e18, 700e18);
        oracle.setPrice(address(mEURC), 0.85e18); // HF ≈ 0.971 < 1
        vm.prank(liq);
        pool.liquidate{value: 700e18}(alice);
        assertEq(pool.debtOf(alice), 0);
        // seize value = debt * 1.1 = 770 USDC → 770/0.85 ≈ 905.88 mEURC
        uint256 expectSeize = (700e18 * 1.1e18) / uint256(0.85e18);
        assertApproxEqAbs(mEURC.balanceOf(liq), expectSeize, 1e6);
        // remainder stays with alice
        assertApproxEqAbs(pool.collateralOf(alice, address(mEURC)), 1000e18 - expectSeize, 1e6);
    }

    function test_RevertWhen_LiquidateUnderpays() public {
        _depositAndBorrow(1000e18, 700e18);
        oracle.setPrice(address(mEURC), 0.85e18);
        vm.prank(liq);
        vm.expectRevert(MiniLend.InsufficientRepay.selector);
        pool.liquidate{value: 100e18}(alice);
    }

    /* ── operator (the Mandate contract's hook) ─────────── */

    function test_OperatorWithdraw() public {
        _depositAndBorrow(1000e18, 500e18);
        vm.prank(alice);
        pool.setOperator(operator, true);
        // withdrawing 100 keeps HF ≥ 1: (900*1.08*0.8)/500 = 1.5552
        vm.prank(operator);
        pool.operatorWithdrawCollateral(alice, address(mEURC), 100e18, operator);
        assertEq(mEURC.balanceOf(operator), 100e18);
        assertEq(pool.collateralOf(alice, address(mEURC)), 900e18);
    }

    function test_RevertWhen_NonOperatorWithdraws() public {
        _depositAndBorrow(1000e18, 500e18);
        vm.prank(operator);
        vm.expectRevert(MiniLend.NotOperator.selector);
        pool.operatorWithdrawCollateral(alice, address(mEURC), 100e18, operator);
    }

    function test_RevertWhen_OperatorWithdrawBreaksHealth() public {
        _depositAndBorrow(1000e18, 700e18);
        vm.prank(alice);
        pool.setOperator(operator, true);
        // withdrawing 300: (700*1.08*0.8)/700 = 0.864 < 1 → must revert
        vm.prank(operator);
        vm.expectRevert(MiniLend.UnhealthyWithdraw.selector);
        pool.operatorWithdrawCollateral(alice, address(mEURC), 300e18, operator);
    }

    function test_DepositCollateralFor_CreditsTargetUser() public {
        mEURC.mint(operator, 500e18);
        vm.startPrank(operator);
        mEURC.approve(address(pool), 500e18);
        pool.depositCollateralFor(alice, address(mEURC), 500e18);
        vm.stopPrank();
        assertEq(pool.collateralOf(alice, address(mEURC)), 500e18);
        assertEq(pool.collateralOf(operator, address(mEURC)), 0);
    }

    function test_RepayFor_ThirdPartyRepaysUserDebt() public {
        _depositAndBorrow(1000e18, 500e18);
        vm.deal(operator, 200e18);
        vm.prank(operator);
        pool.repayFor{value: 200e18}(alice);
        assertEq(pool.debtOf(alice), 300e18);
    }
}
