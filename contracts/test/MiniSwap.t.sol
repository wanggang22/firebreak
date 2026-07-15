// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MiniSwap} from "../src/MiniSwap.sol";

contract MiniSwapTest is Test {
    MockERC20 mEURC;
    MiniSwap amm;
    address alice = address(0xA11CE);

    function setUp() public {
        mEURC = new MockERC20("Mock EURC", "mEURC");
        amm = new MiniSwap();

        // seed pool: 100k USDC ↔ 92,592.6 mEURC (≈1.08 price)
        mEURC.mint(address(this), 1_000_000e18);
        mEURC.approve(address(amm), type(uint256).max);
        vm.deal(address(this), 1_000_000e18);
        amm.addLiquidity{value: 100_000e18}(address(mEURC), 92_592.6e18);

        mEURC.mint(alice, 10_000e18);
        vm.deal(alice, 10_000e18);
        vm.prank(alice);
        mEURC.approve(address(amm), type(uint256).max);
    }

    receive() external payable {}

    function test_AddLiquidity_SetsReserves() public view {
        (uint256 rUsdc, uint256 rToken) = amm.reservesOf(address(mEURC));
        assertEq(rUsdc, 100_000e18);
        assertEq(rToken, 92_592.6e18);
    }

    function test_Quote_TokenToUsdc() public view {
        // xy=k with 0.3% fee: out = in*997 * rOut / (rIn*1000 + in*997)
        uint256 amtIn = 1000e18;
        uint256 expect = (amtIn * 997 * 100_000e18) / (92_592.6e18 * 1000 + amtIn * 997);
        assertEq(amm.getUsdcOut(address(mEURC), amtIn), expect);
    }

    function test_SwapTokenForUsdc() public {
        uint256 quoted = amm.getUsdcOut(address(mEURC), 1000e18);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 out = amm.swapTokenForUsdc(address(mEURC), 1000e18, quoted);
        assertEq(out, quoted);
        assertEq(alice.balance, before + quoted);
        assertEq(mEURC.balanceOf(alice), 9000e18);
    }

    function test_SwapUsdcForToken() public {
        uint256 quoted = amm.getTokenOut(address(mEURC), 500e18);
        vm.prank(alice);
        uint256 out = amm.swapUsdcForToken{value: 500e18}(address(mEURC), quoted);
        assertEq(out, quoted);
        assertEq(mEURC.balanceOf(alice), 10_000e18 + quoted);
    }

    function test_RevertWhen_SlippageExceeded() public {
        uint256 quoted = amm.getUsdcOut(address(mEURC), 1000e18);
        vm.prank(alice);
        vm.expectRevert(MiniSwap.SlippageExceeded.selector);
        amm.swapTokenForUsdc(address(mEURC), 1000e18, quoted + 1);
    }

    function test_RevertWhen_NoLiquidity() public {
        MockERC20 junk = new MockERC20("Junk", "JNK");
        vm.prank(alice);
        vm.expectRevert(MiniSwap.NoLiquidity.selector);
        amm.getUsdcOut(address(junk), 1e18);
    }
}
