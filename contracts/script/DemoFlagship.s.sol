// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

/// @notice The FLAGSHIP scenario: cheapest is NOT best. The reserve is
///         deliberately too small for a TOP-UP to fully restore health, while
///         ROTATE (a 0.20 LT gap, mEURC 0.70 -> mTBILL 0.90) can. Post-M2 the
///         strategist projects each candidate's health factor, so Claude
///         correctly prefers the durable ROTATE over the zero-cost partial
///         TOP-UP — the judgment the cheapest-by-cost rule gets wrong, and the
///         value the LLM adds. Deep AMM so the round-trip stays inside the
///         user-signed slippage floor. Anvil (free depth/gas); same contract as
///         the testnet heroes.
///
/// Env (anvil keys): DEPLOYER_PK, ALICE_PK, KEEPER_ADDR
contract DemoFlagship is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 alicePk = vm.envUint("ALICE_PK");
        address keeper = vm.envAddress("KEEPER_ADDR");
        address alice = vm.addr(alicePk);
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);
        MockOracle oracle = new MockOracle();
        MockERC20 mEURC = new MockERC20("Mock EURC", "mEURC");
        MockERC20 mTBILL = new MockERC20("Mock T-Bill", "mTBILL");
        MiniLend pool = new MiniLend(address(oracle));
        MiniSwap amm = new MiniSwap();
        FirebreakMandate fb = new FirebreakMandate();

        oracle.setPrice(address(mEURC), 1.08e18);
        oracle.setPrice(address(mTBILL), 1e18);
        // 0.20 liquidation-threshold gap is what gives ROTATE enough lift.
        pool.listCollateral(address(mEURC), 0.6e18, 0.7e18); // ltv .6, liqThreshold .70
        pool.listCollateral(address(mTBILL), 0.8e18, 0.9e18); // ltv .8, liqThreshold .90
        pool.fund{value: 5000e18}();

        // DEEP AMM so a ~47-value ROTATE round-trip stays within a 2% floor.
        mEURC.mint(deployer, 200_000e18);
        mTBILL.mint(deployer, 200_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 50_000e18}(address(mEURC), 46_296e18); // ~1.08
        amm.addLiquidity{value: 50_000e18}(address(mTBILL), 50_000e18); // ~1.00

        mEURC.mint(alice, 100e18);
        vm.stopBroadcast();

        vm.startBroadcast(alicePk);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 100e18);
        pool.borrow(50e18);
        pool.setOperator(address(fb), true);
        fb.register{value: 3e18}( // reserve 3 — too small for TOP-UP to reach target
            FirebreakMandate.Terms({
                pool: address(pool),
                swapVenue: address(amm),
                keeper: keeper,
                hfTrigger: 1.2e18,
                maxSpendPerRescue: 5000e18,
                maxSlippageWad: 0.02e18,
                minImprovementWad: 0.02e18,
                keeperFee: 0,
                allowedActions: 1 | 2 | 4
            })
        );
        vm.stopBroadcast();

        // FX drift: mEURC 1.08 -> 0.85. HF = 100*0.85*0.70/50 = 1.19 < 1.20.
        vm.startBroadcast(deployerPk);
        oracle.setPrice(address(mEURC), 0.85e18);
        vm.stopBroadcast();

        console.log("FIREBREAK_ORACLE=%s", address(oracle));
        console.log("FIREBREAK_POOL=%s", address(pool));
        console.log("FIREBREAK_AMM=%s", address(amm));
        console.log("FIREBREAK_MANDATE=%s", address(fb));
        console.log("FIREBREAK_MEURC=%s", address(mEURC));
        console.log("FIREBREAK_MTBILL=%s", address(mTBILL));
        console.log("FIREBREAK_ALICE=%s", alice);
        console.log("FIREBREAK_HF=%s", pool.healthFactor(alice));
    }
}
