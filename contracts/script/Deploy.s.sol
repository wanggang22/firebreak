// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

/// @notice Deploys the full Firebreak stack and seeds a demo-ready scenario:
///         listed collateral, funded lending pool, funded swap venue.
///         Same script drives local anvil and Arc testnet.
///
/// Env:
///   PRIVATE_KEY  — deployer (also the demo LP / oracle owner)
contract Deploy is Script {
    // WAD listing params
    uint256 constant EURC_LTV = 0.7e18;
    uint256 constant EURC_LT = 0.8e18;
    uint256 constant TBILL_LTV = 0.8e18;
    uint256 constant TBILL_LT = 0.9e18;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        MockOracle oracle = new MockOracle();
        MockERC20 mEURC = new MockERC20("Mock EURC", "mEURC");
        MockERC20 mTBILL = new MockERC20("Mock T-Bill", "mTBILL");
        MiniLend pool = new MiniLend(address(oracle));
        MiniSwap amm = new MiniSwap();
        FirebreakMandate fb = new FirebreakMandate();

        oracle.setPrice(address(mEURC), 1.08e18);
        oracle.setPrice(address(mTBILL), 1e18);
        pool.listCollateral(address(mEURC), EURC_LTV, EURC_LT);
        pool.listCollateral(address(mTBILL), TBILL_LTV, TBILL_LT);

        // fund lending pool with native USDC liquidity
        pool.fund{value: 100_000e18}();

        // seed swap venue: both legs
        mEURC.mint(msg.sender, 500_000e18);
        mTBILL.mint(msg.sender, 500_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 50_000e18}(address(mEURC), 46_296e18); // ~1.08
        amm.addLiquidity{value: 50_000e18}(address(mTBILL), 50_000e18); // ~1.00

        vm.stopBroadcast();

        console.log("ORACLE=%s", address(oracle));
        console.log("MEURC=%s", address(mEURC));
        console.log("MTBILL=%s", address(mTBILL));
        console.log("POOL=%s", address(pool));
        console.log("AMM=%s", address(amm));
        console.log("MANDATE=%s", address(fb));
    }
}
