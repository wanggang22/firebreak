// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/MockOracle.sol";

contract MockOracleTest is Test {
    MockOracle oracle;
    address owner = address(this);
    address rando = address(0xBEEF);
    address mEURC = address(0xE0);

    function setUp() public {
        oracle = new MockOracle();
    }

    function test_SetAndGetPrice() public {
        oracle.setPrice(mEURC, 1.08e18); // 1 EURC = 1.08 USDC
        assertEq(oracle.getPrice(mEURC), 1.08e18);
    }

    function test_UpdatePrice() public {
        oracle.setPrice(mEURC, 1.08e18);
        oracle.setPrice(mEURC, 0.95e18); // FX drift down
        assertEq(oracle.getPrice(mEURC), 0.95e18);
    }

    function test_RevertWhen_NonOwnerSetsPrice() public {
        vm.prank(rando);
        vm.expectRevert(MockOracle.NotOwner.selector);
        oracle.setPrice(mEURC, 1e18);
    }

    function test_RevertWhen_PriceUnset() public {
        vm.expectRevert(MockOracle.PriceUnset.selector);
        oracle.getPrice(address(0xDEAD));
    }

    function test_RevertWhen_SettingZeroPrice() public {
        vm.expectRevert(MockOracle.ZeroPrice.selector);
        oracle.setPrice(mEURC, 0);
    }
}
