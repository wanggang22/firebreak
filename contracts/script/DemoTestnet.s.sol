// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockOracle} from "../src/MockOracle.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniLend} from "../src/MiniLend.sol";
import {MiniSwap} from "../src/MiniSwap.sol";
import {FirebreakMandate} from "../src/FirebreakMandate.sol";

/// @notice Arc testnet demo scenario, sized for single-digit native USDC so it
///         fits the arcpay deployer wallet's balance. Same shape as DemoSetup
///         but small amounts. Showcases the TOP-UP rescue path (no AMM depth
///         needed). Deleverage/rotate are covered by forge tests + local anvil.
///
/// Env: DEPLOYER_PK (LP + oracle owner + keeper), ALICE_PK (borrower), KEEPER_ADDR
contract DemoTestnet is Script {
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
        pool.listCollateral(address(mEURC), 0.7e18, 0.8e18);
        pool.listCollateral(address(mTBILL), 0.8e18, 0.9e18);
        pool.fund{value: 5.5e18}();

        // token side is minted free; only the native leg costs real USDC
        mEURC.mint(deployer, 1000e18);
        mTBILL.mint(deployer, 1000e18);
        mEURC.approve(address(amm), type(uint256).max);
        mTBILL.approve(address(amm), type(uint256).max);
        amm.addLiquidity{value: 0.4e18}(address(mEURC), 0.37e18);
        amm.addLiquidity{value: 0.4e18}(address(mTBILL), 0.4e18);

        mEURC.mint(alice, 10e18);
        vm.stopBroadcast();

        vm.startBroadcast(alicePk);
        mEURC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(mEURC), 10e18);
        pool.borrow(5e18);
        pool.setOperator(address(fb), true);
        fb.register{value: 1e18}(
            FirebreakMandate.Terms({
                pool: address(pool),
                swapVenue: address(amm),
                keeper: keeper,
                hfTrigger: 1.2e18,
                maxSpendPerRescue: 50e18,
                allowedActions: 1 | 2 | 4
            })
        );
        vm.stopBroadcast();

        // FX drift: EURC 1.08 -> 0.70, HF 1.728 -> 1.12
        vm.startBroadcast(deployerPk);
        oracle.setPrice(address(mEURC), 0.70e18);
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
