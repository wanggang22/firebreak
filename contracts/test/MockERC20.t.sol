// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";

contract MockERC20Test is Test {
    MockERC20 mEURC;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        mEURC = new MockERC20("Mock EURC", "mEURC");
    }

    function test_Metadata() public view {
        assertEq(mEURC.name(), "Mock EURC");
        assertEq(mEURC.symbol(), "mEURC");
        assertEq(mEURC.decimals(), 18);
    }

    function test_OwnerMint() public {
        mEURC.mint(alice, 1000e18);
        assertEq(mEURC.balanceOf(alice), 1000e18);
        assertEq(mEURC.totalSupply(), 1000e18);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(MockERC20.NotOwner.selector);
        mEURC.mint(alice, 1e18);
    }

    function test_TransferAndApprove() public {
        mEURC.mint(alice, 100e18);
        vm.prank(alice);
        mEURC.transfer(bob, 40e18);
        assertEq(mEURC.balanceOf(alice), 60e18);
        assertEq(mEURC.balanceOf(bob), 40e18);

        vm.prank(bob);
        mEURC.approve(alice, 10e18);
        vm.prank(alice);
        mEURC.transferFrom(bob, alice, 10e18);
        assertEq(mEURC.balanceOf(bob), 30e18);
        assertEq(mEURC.allowance(bob, alice), 0);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        mEURC.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(MockERC20.InsufficientBalance.selector);
        mEURC.transfer(bob, 2e18);
    }
}
