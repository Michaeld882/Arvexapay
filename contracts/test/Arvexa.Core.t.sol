// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Arvexa} from "../Arvexa.sol";
import {ArvexaTestBase, FeeOnTransferToken} from "./Arvexa.Base.t.sol";

contract ArvexaCoreTest is ArvexaTestBase {
    // ---------------- constructor ----------------

    function test_Constructor_SetsState() public view {
        assertEq(address(vault.USDC()), address(usdc));
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vault.totalDeposits(), 0);
        assertFalse(vault.paused());
        assertTrue(vault.solvency());
    }

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(Arvexa.ZeroAddress.selector);
        new Arvexa(address(0), owner);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Arvexa(address(usdc), address(0));
    }

    function test_Constructor_RevertsWhenTokenHasNoCode() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(Arvexa.TokenHasNoCode.selector, eoa));
        new Arvexa(eoa, owner);
    }

    // ---------------- deposit ----------------

    function test_Deposit_CreditsBalanceAndMovesTokens() public {
        _deposit(alice, 100e6);
        assertEq(vault.balanceOf(alice), 100e6);
        assertEq(vault.totalDeposits(), 100e6);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(usdc.balanceOf(alice), START - 100e6);
    }

    function test_Deposit_AccumulatesAcrossCallsAndUsers() public {
        _deposit(alice, 100e6);
        _deposit(alice, 50e6);
        _deposit(bob, 7e6);
        assertEq(vault.balanceOf(alice), 150e6);
        assertEq(vault.balanceOf(bob), 7e6);
        assertEq(vault.totalDeposits(), 157e6);
    }

    function test_Deposit_EmitsDeposited() public {
        _deposit(alice, 40e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit Arvexa.Deposited(alice, 10e6, 50e6);
        _deposit(alice, 10e6);
    }

    function test_Deposit_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(Arvexa.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_Deposit_RevertsWithoutAllowance() public {
        address dave = makeAddr("dave");
        usdc.mint(dave, 10e6);
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 10e6)
        );
        vault.deposit(10e6);
    }

    function test_Deposit_RevertsOnInsufficientTokenBalance() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, START, START + 1)
        );
        vault.deposit(START + 1);
    }

    function test_Deposit_RevertsWhenPaused() public {
        vm.prank(owner);
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1e6);
    }

    function test_Deposit_FeeOnTransferTokenReverts() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        Arvexa v = new Arvexa(address(fot), owner);
        fot.mint(alice, 1_000e6);
        vm.startPrank(alice);
        fot.approve(address(v), type(uint256).max);
        // 1% fee: vault receives 99e6 of an expected 100e6
        vm.expectRevert(abi.encodeWithSelector(Arvexa.UnexpectedUSDCBalance.selector, 0, 99e6, 100e6));
        v.deposit(100e6);
        vm.stopPrank();
        assertEq(v.balanceOf(alice), 0);
        assertEq(v.totalDeposits(), 0);
        assertEq(fot.balanceOf(alice), 1_000e6);
    }

    // ---------------- withdraw ----------------

    function test_Withdraw_ToSelf() public {
        _deposit(alice, 100e6);
        vm.prank(alice);
        vault.withdraw(alice, 30e6);
        assertEq(vault.balanceOf(alice), 70e6);
        assertEq(vault.totalDeposits(), 70e6);
        assertEq(usdc.balanceOf(alice), START - 70e6);
        assertEq(usdc.balanceOf(address(vault)), 70e6);
    }

    function test_Withdraw_ToOtherAddressFullBalance() public {
        _deposit(alice, 100e6);
        vm.prank(alice);
        vault.withdraw(bob, 100e6);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.totalDeposits(), 0);
        assertEq(usdc.balanceOf(bob), START + 100e6);
    }

    function test_Withdraw_EmitsWithdrawn() public {
        _deposit(alice, 100e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Arvexa.Withdrawn(alice, bob, 25e6, 75e6);
        vm.prank(alice);
        vault.withdraw(bob, 25e6);
    }

    function test_Withdraw_OnlyDebitsCaller() public {
        _deposit(alice, 100e6);
        _deposit(bob, 100e6);
        vm.prank(alice);
        vault.withdraw(alice, 100e6);
        assertEq(vault.balanceOf(bob), 100e6);
    }

    function test_Withdraw_RevertsOnZeroRecipient() public {
        _deposit(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InvalidRecipient.selector, address(0)));
        vault.withdraw(address(0), 1e6);
    }

    function test_Withdraw_RevertsOnVaultRecipient() public {
        _deposit(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InvalidRecipient.selector, address(vault)));
        vault.withdraw(address(vault), 1e6);
    }

    function test_Withdraw_RevertsOnZeroAmount() public {
        _deposit(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert(Arvexa.ZeroAmount.selector);
        vault.withdraw(alice, 0);
    }

    function test_Withdraw_RevertsOnInsufficientBalance() public {
        _deposit(alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InsufficientBalance.selector, 10e6, 10e6 + 1));
        vault.withdraw(alice, 10e6 + 1);
    }

    function test_Withdraw_RevertsForUserWithNoBalance() public {
        _deposit(alice, 10e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InsufficientBalance.selector, 0, 1));
        vault.withdraw(bob, 1);
    }

    function test_Withdraw_StillWorksWhilePaused() public {
        _deposit(alice, 100e6);
        vm.prank(owner);
        vault.pause();
        vm.prank(alice);
        vault.withdraw(alice, 100e6);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), START);
    }
}
