// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Arvexa} from "../Arvexa.sol";
import {ArvexaTestBase, MockUSDC} from "./Arvexa.Base.t.sol";

contract ArvexaAdminTest is ArvexaTestBase {
    MockUSDC internal other;

    function setUp() public override {
        super.setUp();
        other = new MockUSDC();
    }

    // ---------------- pause / unpause ----------------

    function test_Pause_OwnerCanPauseAndEmits() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit Pausable.Paused(owner);
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_Unpause_OwnerCanUnpauseAndEmits() public {
        vm.prank(owner);
        vault.pause();
        vm.expectEmit(false, false, false, true, address(vault));
        emit Pausable.Unpaused(owner);
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
        _deposit(alice, 1e6); // deposits work again
        assertEq(vault.balanceOf(alice), 1e6);
    }

    function test_Pause_NonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.pause();
    }

    function test_Unpause_NonOwnerReverts() public {
        vm.prank(owner);
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.unpause();
    }

    function test_Pause_DoublePauseReverts() public {
        vm.startPrank(owner);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pause();
        vm.stopPrank();
    }

    function test_Unpause_WhenNotPausedReverts() public {
        vm.prank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vault.unpause();
    }

    function test_Pause_BlocksDepositButNotWithdraw() public {
        _deposit(alice, 100e6);
        vm.prank(owner);
        vault.pause();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1e6);

        vm.prank(alice);
        vault.withdraw(alice, 60e6);
        assertEq(vault.balanceOf(alice), 40e6);
    }

    // ---------------- two-step ownership ----------------

    function test_Ownership_TransferStartsPendingOnly() public {
        vm.expectEmit(true, true, false, false, address(vault));
        emit Ownable2Step.OwnershipTransferStarted(owner, alice);
        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), alice);
    }

    function test_Ownership_AcceptCompletesTransfer() public {
        vm.prank(owner);
        vault.transferOwnership(alice);
        vm.expectEmit(true, true, false, false, address(vault));
        emit Ownable.OwnershipTransferred(owner, alice);
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
        assertEq(vault.pendingOwner(), address(0));

        // new owner has power, old owner does not
        vm.prank(alice);
        vault.pause();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vault.unpause();
    }

    function test_Ownership_NonPendingCannotAccept() public {
        vm.prank(owner);
        vault.transferOwnership(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.acceptOwnership();
        assertEq(vault.owner(), owner);
    }

    function test_Ownership_NonOwnerCannotTransfer() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.transferOwnership(alice);
    }

    function test_Ownership_RenounceRevertsForOwner() public {
        vm.prank(owner);
        vm.expectRevert(Arvexa.OwnershipRenunciationDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
    }

    function test_Ownership_RenounceRevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.renounceOwnership();
    }

    // ---------------- rescueToken ----------------

    function test_Rescue_UnsupportedTokenWorks() public {
        other.mint(address(vault), 500e6);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Arvexa.TokenRescued(address(other), carol, 200e6);
        vm.prank(owner);
        vault.rescueToken(address(other), carol, 200e6);
        assertEq(other.balanceOf(carol), 200e6);
        assertEq(other.balanceOf(address(vault)), 300e6);
    }

    function test_Rescue_WorksWhilePausedAndDoesNotTouchAccounting() public {
        _deposit(alice, 10e6);
        other.mint(address(vault), 5e6);
        vm.startPrank(owner);
        vault.pause();
        vault.rescueToken(address(other), owner, 5e6);
        vm.stopPrank();
        assertEq(vault.totalDeposits(), 10e6);
        assertEq(vault.balanceOf(alice), 10e6);
    }

    function test_Rescue_UsdcForbiddenEvenForSurplus() public {
        _deposit(alice, 10e6);
        usdc.mint(address(vault), 5e6); // uncredited donation
        vm.prank(owner);
        vm.expectRevert(Arvexa.USDCRescueForbidden.selector);
        vault.rescueToken(address(usdc), owner, 1);
    }

    function test_Rescue_NonOwnerReverts() public {
        other.mint(address(vault), 5e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.rescueToken(address(other), alice, 5e6);
    }

    function test_Rescue_NonOwnerUsdcRevertsWithOwnableError() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.rescueToken(address(usdc), alice, 1);
    }

    function test_Rescue_ZeroRecipientReverts() public {
        other.mint(address(vault), 5e6);
        vm.prank(owner);
        vm.expectRevert(Arvexa.ZeroAddress.selector);
        vault.rescueToken(address(other), address(0), 5e6);
    }

    function test_Rescue_MoreThanBalanceReverts() public {
        other.mint(address(vault), 5e6);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 5e6, 5e6 + 1)
        );
        vault.rescueToken(address(other), owner, 5e6 + 1);
    }

    // ---------------- native transfers ----------------

    function test_Native_PlainTransferReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    function test_Native_UnknownCalldataWithValueReverts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    // ---------------- solvency ----------------

    function test_Solvency_TrueAfterDepositsAndDonation() public {
        _deposit(alice, 10e6);
        assertTrue(vault.solvency());
        usdc.mint(address(vault), 1e6);
        assertTrue(vault.solvency());
    }

    function test_Solvency_FalseIfTokenBalanceDrops() public {
        _deposit(alice, 10e6);
        usdc.burn(address(vault), 1); // simulate external token-level loss
        assertFalse(vault.solvency());
    }

    function test_DirectUsdcTransferIsNotCredited() public {
        vm.prank(alice);
        usdc.transfer(address(vault), 5e6);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.totalDeposits(), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InsufficientBalance.selector, 0, 5e6));
        vault.withdraw(alice, 5e6);
    }
}
