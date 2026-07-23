// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

/// @notice End-to-end demo scenario on local anvil: deploy, give Alice a
///         position, sign a Mandate authorizing the keeper, then drift the
///         EURC price so her health drops below the trigger. After this runs,
///         the TypeScript keeper can execute the rescue.
///
/// Env (anvil default keys):
///   DEPLOYER_PK, ALICE_PK, KEEPER_ADDR
contract DemoSetup is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 alicePk = vm.envUint("ALICE_PK");
        address keeper = vm.envAddress("KEEPER_ADDR");
        address alice = vm.addr(alicePk);
        address deployer = vm.addr(deployerPk);

        // ── deploy + seed (deployer) ──
        vm.startBroadcast(deployerPk);
        MockOracle oracle = new MockOracle();
        MockERC20 mEURC = new MockERC20("Mock EURC", "mEURC");
        MockERC20 mTBILL = new MockERC20("Mock T-Bill", "mTBILL");
        MiniLend pool = new MiniLend(address(oracle));
        MiniSwap amm = new MiniSwap();
        FirebreakMandate fb = new FirebreakMandate();

        oracle.setPrice(address(mEURC), 1.08e18);
        oracle.setPrice(address(mTBILL), 1e18);
        pool.listCollateral(address(mEURC), 0.7e18, 0.8e18);
        pool.listCollateral(address(mTBILL), 0.8e18, 0.9e18);
        pool.fund{value: 3000e18}();

        mEURC.mint(deployer, 500_000e18);
        mTBILL.mint(deployer, 500_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 3000e18}(address(mEURC), 2778e18); // ~1.08
        amm.addLiquidity{value: 3000e18}(address(mTBILL), 3000e18); // ~1.00

        mEURC.mint(alice, 1000e18);
        vm.stopBroadcast();

        // ── Alice opens a position + signs the Mandate ──
        vm.startBroadcast(alicePk);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 1000e18);
        pool.borrow(700e18);
        pool.setOperator(address(fb), true);
        fb.register{value: 200e18}(
            FirebreakMandate.Terms({
                pool: address(pool),
                swapVenue: address(amm),
                keeper: keeper,
                hfTrigger: 1.2e18,
                maxSpendPerRescue: 5000e18,
                maxSlippageWad: 0.02e18, // swap must recover >= 98% of moved collateral value
                minImprovementWad: 0.02e18, // a rescue must lift HF by >= 0.02
                keeperFee: 0, // unpaid keeper in the demo scenario
                allowedActions: 1 | 2 | 4 // deleverage | rotate | topup
            })
        );
        vm.stopBroadcast();

        // ── FX drift: EURC 1.08 → 0.98, pushing HF from 1.234 to ~1.12 ──
        vm.startBroadcast(deployerPk);
        oracle.setPrice(address(mEURC), 0.98e18);
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
