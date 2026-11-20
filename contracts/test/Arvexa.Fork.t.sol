// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Arvexa} from "../Arvexa.sol";

/// @notice Read-only checks of Arvexa against the REAL Arc USDC token on a fork of Arc Mainnet.
/// Skipped unless ARC_MAINNET_RPC_URL is set.
///
/// Limitation: Arc's USDC calls a chain-level blocklist precompile (0x1800...0001) during transfers.
/// Stock Foundry cannot execute it, so token movement cannot be simulated on a local fork. Rehearse
/// deposit and withdraw on Arc Testnet (same USDC address) before using mainnet.
contract ArvexaForkTest is Test {
    IERC20 internal constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    function setUp() public {
        string memory url = vm.envOr("ARC_MAINNET_RPC_URL", string(""));
        vm.skip(bytes(url).length == 0);
        vm.createSelectFork(url);
    }

    function test_forkUsdcIsSixDecimals() public view {
        (bool ok, bytes memory data) = address(USDC).staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(abi.decode(data, (uint8)), 6);
    }

    function test_forkVaultConstructsAgainstRealUsdc() public {
        address owner = makeAddr("owner");
        Arvexa vault = new Arvexa(address(USDC), owner);
        assertEq(address(vault.USDC()), address(USDC));
        assertEq(vault.owner(), owner);
        assertEq(vault.totalDeposits(), 0);
        assertEq(USDC.balanceOf(address(vault)), 0);
        assertTrue(vault.solvency());
    }
}
