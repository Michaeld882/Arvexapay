// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Arvexa} from "../Arvexa.sol";
import {ArvexaTestBase} from "./Arvexa.Base.t.sol";

contract ArvexaFuzzTest is ArvexaTestBase {
    function testFuzz_DepositThenWithdrawRoundTrip(uint256 amount) public {
        amount = bound(amount, 1, START);
        _deposit(alice, amount);
        assertEq(vault.balanceOf(alice), amount);
        assertEq(vault.totalDeposits(), amount);

        vm.prank(alice);
        vault.withdraw(alice, amount);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.totalDeposits(), 0);
        assertEq(usdc.balanceOf(alice), START);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzz_PartialWithdrawArithmetic(uint256 dep, uint256 wd, address to) public {
        vm.assume(to != address(0) && to != address(vault) && to != alice);
        dep = bound(dep, 1, START);
        wd = bound(wd, 1, dep);
        uint256 toBefore = usdc.balanceOf(to);
        _deposit(alice, dep);
        vm.prank(alice);
        vault.withdraw(to, wd);
        assertEq(vault.balanceOf(alice), dep - wd);
        assertEq(vault.totalDeposits(), dep - wd);
        assertEq(usdc.balanceOf(to), toBefore + wd);
        assertEq(usdc.balanceOf(address(vault)), dep - wd);
    }

    function testFuzz_TotalDepositsIsSumOfBalances(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 1, START);
        b = bound(b, 1, START);
        c = bound(c, 1, START);
        _deposit(alice, a);
        _deposit(bob, b);
        _deposit(carol, c);
        assertEq(vault.totalDeposits(), a + b + c);
        assertEq(vault.balanceOf(alice) + vault.balanceOf(bob) + vault.balanceOf(carol), a + b + c);
        assertTrue(vault.solvency());
    }

    function testFuzz_WithdrawMoreThanBalanceReverts(uint256 dep, uint256 extra) public {
        dep = bound(dep, 1, START);
        extra = bound(extra, 1, type(uint128).max);
        _deposit(alice, dep);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InsufficientBalance.selector, dep, dep + extra));
        vault.withdraw(alice, dep + extra);
    }

    function testFuzz_OtherUsersCannotWithdrawMyFunds(uint256 dep, uint256 amt) public {
        dep = bound(dep, 1, START);
        amt = bound(amt, 1, type(uint128).max);
        _deposit(alice, dep);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Arvexa.InsufficientBalance.selector, 0, amt));
        vault.withdraw(bob, amt);
        assertEq(vault.balanceOf(alice), dep);
    }

    function testFuzz_DonationsNeverCreditAnyone(uint256 dep, uint256 donation) public {
        dep = bound(dep, 1, START);
        donation = bound(donation, 0, type(uint128).max);
        _deposit(alice, dep);
        usdc.mint(address(vault), donation);
        assertEq(vault.totalDeposits(), dep);
        assertEq(vault.balanceOf(alice), dep);
        assertTrue(vault.solvency());
    }
}
