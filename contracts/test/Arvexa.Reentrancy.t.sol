// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Arvexa} from "../Arvexa.sol";
import {Test} from "forge-std/Test.sol";
import {ReentrantToken} from "./Arvexa.Base.t.sol";

/// @dev Vault is deployed with the malicious token as its "USDC".
contract ArvexaReentrancyTest is Test {
    ReentrantToken internal evil;
    Arvexa internal v;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        evil = new ReentrantToken();
        v = new Arvexa(address(evil), owner);
        evil.mint(alice, 1_000e6);
        evil.mint(address(v), 100e6); // pre-existing liquidity so reentrant withdraw has funds to move
        vm.prank(alice);
        evil.approve(address(v), type(uint256).max);
    }

    function test_Reentrancy_DepositReentersDeposit_Reverts() public {
        evil.arm(address(v), abi.encodeCall(Arvexa.deposit, (1e6)), false);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v.deposit(10e6);
        assertEq(v.balanceOf(alice), 0);
        assertEq(v.totalDeposits(), 0);
    }

    function test_Reentrancy_DepositReentersWithdraw_Reverts() public {
        evil.arm(address(v), abi.encodeCall(Arvexa.withdraw, (address(evil), 1)), false);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v.deposit(10e6);
        assertEq(v.totalDeposits(), 0);
    }

    function test_Reentrancy_SwallowedAttemptFailsAndAccountingIntact() public {
        evil.arm(address(v), abi.encodeCall(Arvexa.deposit, (1e6)), true);
        vm.prank(alice);
        v.deposit(10e6);
        assertFalse(evil.lastReentrySucceeded());
        assertEq(
            bytes4(evil.lastReentryRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertEq(v.balanceOf(alice), 10e6);
        assertEq(v.totalDeposits(), 10e6);
    }

    function test_Reentrancy_WithdrawReentersWithdraw_Reverts() public {
        vm.prank(alice);
        v.deposit(10e6);
        evil.arm(address(v), abi.encodeCall(Arvexa.withdraw, (address(evil), 1)), false);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v.withdraw(alice, 5e6);
        // whole tx reverted -> accounting unchanged
        assertEq(v.balanceOf(alice), 10e6);
        assertEq(v.totalDeposits(), 10e6);
    }

    function test_Reentrancy_WithdrawReentersDeposit_SwallowedFails() public {
        vm.prank(alice);
        v.deposit(10e6);
        evil.arm(address(v), abi.encodeCall(Arvexa.deposit, (1e6)), true);
        vm.prank(alice);
        v.withdraw(alice, 4e6);
        assertFalse(evil.lastReentrySucceeded());
        assertEq(v.balanceOf(alice), 6e6);
        assertEq(v.totalDeposits(), 6e6);
    }

    function test_Reentrancy_RescueReentersDeposit_Fails() public {
        ReentrantToken tok = new ReentrantToken();
        tok.mint(address(v), 10e6);
        tok.arm(address(v), abi.encodeCall(Arvexa.deposit, (1e6)), true);
        vm.prank(owner);
        v.rescueToken(address(tok), owner, 5e6);
        assertFalse(tok.lastReentrySucceeded());
        assertEq(
            bytes4(tok.lastReentryRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertEq(tok.balanceOf(owner), 5e6);
    }
}
