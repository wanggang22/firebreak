// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title MockOracle — demo-controllable price source for Arc testnet.
/// @notice Prices are WAD (1e18) quoted in native USDC per 1 token.
///         Testnet has no production oracle; a controllable feed is what
///         lets the demo script drive FX drift deterministically.
contract MockOracle {
    error NotOwner();
    error PriceUnset();
    error ZeroPrice();

    event PriceSet(address indexed token, uint256 priceWad);

    address public immutable owner;
    mapping(address => uint256) private prices;

    constructor() {
        owner = msg.sender;
    }

    function setPrice(address token, uint256 priceWad) external {
        if (msg.sender != owner) revert NotOwner();
        if (priceWad == 0) revert ZeroPrice();
        prices[token] = priceWad;
        emit PriceSet(token, priceWad);
    }

    function getPrice(address token) external view returns (uint256) {
        uint256 p = prices[token];
        if (p == 0) revert PriceUnset();
        return p;
    }
}
