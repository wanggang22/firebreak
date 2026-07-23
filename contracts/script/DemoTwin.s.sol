// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

/// @notice The counterfactual: two identical positions, one with a Firebreak
///         Mandate, one without. Both drift toward liquidation. The protected
///         position is rescued at the trigger and keeps its collateral for a
///         fee; the unprotected twin rides the drift past HF < 1.0 and is
///         liquidated at a 10% penalty. Prints the side-by-side loss so the
///         "saved $X" number is real, not asserted. Anvil (--balance 1000000).
///
/// Env (anvil keys): DEPLOYER_PK (also the keeper + liquidator), ALICE_PK, BOB_PK
contract DemoTwin is Script {
    MockOracle oracle;
    MockERC20 mEURC;
    MockERC20 mTBILL;
    MiniLend pool;
    MiniSwap amm;
    FirebreakMandate fb;

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 alicePk = vm.envUint("ALICE_PK");
        uint256 bobPk = vm.envUint("BOB_PK");
        address deployer = vm.addr(deployerPk);
        address alice = vm.addr(alicePk);
        address bob = vm.addr(bobPk);

        vm.startBroadcast(deployerPk);
        oracle = new MockOracle();
        mEURC = new MockERC20("Mock EURC", "mEURC");
        mTBILL = new MockERC20("Mock T-Bill", "mTBILL");
        pool = new MiniLend(address(oracle));
        amm = new MiniSwap();
        fb = new FirebreakMandate();

        oracle.setPrice(address(mEURC), 1.08e18);
        oracle.setPrice(address(mTBILL), 1e18);
        pool.listCollateral(address(mEURC), 0.6e18, 0.7e18);
        pool.listCollateral(address(mTBILL), 0.8e18, 0.9e18);
        pool.fund{value: 5000e18}();

        mEURC.mint(deployer, 500_000e18);
        mTBILL.mint(deployer, 500_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 50_000e18}(address(mEURC), 46_296e18);
        amm.addLiquidity{value: 50_000e18}(address(mTBILL), 50_000e18);

        mEURC.mint(alice, 100e18);
        mEURC.mint(bob, 100e18);
        vm.stopBroadcast();

        // Alice — protected: deposits, borrows, signs a Mandate.
        vm.startBroadcast(alicePk);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 100e18);
        pool.borrow(50e18);
        pool.setOperator(address(fb), true);
        fb.register{value: 0}(
            FirebreakMandate.Terms({
                pool: address(pool), swapVenue: address(amm), keeper: deployer,
                hfTrigger: 1.2e18, maxSpendPerRescue: 5000e18,
                maxSlippageWad: 0.02e18, minImprovementWad: 0.02e18,
                keeperFee: 0,
                allowedActions: 1 // DELEVERAGE
            })
        );
        vm.stopBroadcast();

        // Bob — UNPROTECTED: identical position, no Mandate.
        vm.startBroadcast(bobPk);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 100e18);
        pool.borrow(50e18);
        vm.stopBroadcast();

        // Drift mEURC 1.08 -> 0.85: HF = 100*0.85*0.7/50 = 1.19 < Alice's 1.20 trigger.
        vm.startBroadcast(deployerPk);
        oracle.setPrice(address(mEURC), 0.85e18);

        // Firebreak rescues Alice (deleverage ~17 mEURC to restore health).
        uint256 aliceCollBefore = pool.collateralOf(alice, address(mEURC));
        uint256 aliceDebtBefore = pool.debtOf(alice);
        fb.rescue(
            alice,
            FirebreakMandate.Plan({
                action: 1, collateralToken: address(mEURC), collateralAmount: 17e18,
                rotateTo: address(0), minSwapOut: 13e18, minSwapOut2: 0, topUpAmount: 0
            })
        );
        uint256 aliceCollAfter = pool.collateralOf(alice, address(mEURC));
        uint256 aliceDebtAfter = pool.debtOf(alice);

        // Drift further to 0.55: Bob (never rescued) crosses HF < 1.0.
        oracle.setPrice(address(mEURC), 0.55e18);

        uint256 bobCollBefore = pool.collateralOf(bob, address(mEURC));
        uint256 bobHf = pool.healthFactor(bob);
        // Liquidate Bob: repay his 50 debt, seize 110% of it in collateral.
        pool.liquidate{value: 50e18}(bob);
        uint256 bobCollAfter = pool.collateralOf(bob, address(mEURC));
        vm.stopBroadcast();

        // ── report ──
        console.log("=== PROTECTED (Alice, Firebreak) ===");
        console.log("collateral mEURC: %s -> %s", aliceCollBefore / 1e18, aliceCollAfter / 1e18);
        console.log("debt USDC:        %s -> %s", aliceDebtBefore / 1e18, aliceDebtAfter / 1e18);
        console.log("HF now @0.55:     %s (never liquidated)", pool.healthFactor(alice));
        console.log("=== UNPROTECTED (Bob, no Mandate) ===");
        console.log("HF at liquidation: %s (below 1.0)", bobHf);
        console.log("collateral mEURC:  %s -> %s (seized)", bobCollBefore / 1e18, bobCollAfter / 1e18);
        uint256 seized = bobCollBefore - bobCollAfter;
        console.log("mEURC seized: %s ; penalty (10%% of 50 debt) = 5 USDC value", seized / 1e18);
        console.log("FIREBREAK_ALICE_COLL_KEPT=%s", aliceCollAfter);
        console.log("FIREBREAK_BOB_COLL_LEFT=%s", bobCollAfter);
        console.log("FIREBREAK_BOB_SEIZED=%s", seized);
    }
}
