// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Arvexa} from "../Arvexa.sol";
import {ArvexaTestBase, MockUSDC} from "./Arvexa.Base.t.sol";

/// @dev Drives bounded user and owner actions; tracks ghost balances that ONLY user
///      deposit/withdraw (never owner actions) may change.
contract ArvexaHandler is Test {
    Arvexa public vault;
    MockUSDC public usdc;
    MockUSDC public other;
    address public owner;
    address[3] public actors;

    mapping(address => uint256) public ghostBalance;
    uint256 public ghostTotal;
    uint256 public ownerRescueUsdcSuccesses;
    uint256 public ownerWithdrawSuccesses;

    constructor(Arvexa v, MockUSDC u, address owner_, address[3] memory actors_) {
        vault = v;
        usdc = u;
        owner = owner_;
        actors = actors_;
        other = new MockUSDC();
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function deposit(uint256 seed, uint256 amount) external {
        if (vault.paused()) return;
        address a = _actor(seed);
        amount = bound(amount, 1, 1e12);
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        ghostBalance[a] += amount;
        ghostTotal += amount;
    }

    function withdraw(uint256 seed, uint256 toSeed, uint256 amount) external {
        address a = _actor(seed);
        uint256 bal = ghostBalance[a];
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        vault.withdraw(_actor(toSeed), amount);
        ghostBalance[a] -= amount;
        ghostTotal -= amount;
    }

    function donate(uint256 amount) external {
        usdc.mint(address(vault), bound(amount, 0, 1e12));
    }

    function togglePause() external {
        vm.startPrank(owner);
        if (vault.paused()) vault.unpause();
        else vault.pause();
        vm.stopPrank();
    }

    function ownerRescueUsdc(uint256 amount) external {
        vm.prank(owner);
        try vault.rescueToken(address(usdc), owner, amount) {
            ownerRescueUsdcSuccesses++;
        } catch {}
    }

    function ownerRescueOther(uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        other.mint(address(vault), amount);
        vm.prank(owner);
        vault.rescueToken(address(other), owner, amount);
    }

    function ownerWithdrawAttempt(uint256 amount) external {
        vm.prank(owner);
        try vault.withdraw(owner, amount) {
            ownerWithdrawSuccesses++;
        } catch {}
    }

    function ownerWithdrawFromUserAttempt(uint256 seed, uint256 amount) external {
        // owner tries to pull a user's funds to itself — can only ever debit owner's own (zero) balance
        address a = _actor(seed);
        vm.prank(owner);
        try vault.withdraw(a, amount) {
            ownerWithdrawSuccesses++;
        } catch {}
    }
}

contract ArvexaInvariantTest is ArvexaTestBase {
    ArvexaHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ArvexaHandler(vault, usdc, owner, [alice, bob, carol]);
        targetContract(address(handler));
    }

    function _sum() internal view returns (uint256) {
        return vault.balanceOf(alice) + vault.balanceOf(bob) + vault.balanceOf(carol);
    }

    // totalDeposits == sum of all user balances
    function invariant_TotalDepositsEqualsSumOfBalances() public view {
        assertEq(vault.totalDeposits(), _sum());
        assertEq(vault.totalDeposits(), handler.ghostTotal());
    }

    // vault always holds at least what it owes
    function invariant_UsdcBalanceCoversTotalDeposits() public view {
        assertGe(usdc.balanceOf(address(vault)), vault.totalDeposits());
        assertTrue(vault.solvency());
    }

    // only users' own deposit/withdraw change their balance — owner actions never do
    function invariant_OwnerNeverReducesUserBalances() public view {
        assertEq(vault.balanceOf(alice), handler.ghostBalance(alice));
        assertEq(vault.balanceOf(bob), handler.ghostBalance(bob));
        assertEq(vault.balanceOf(carol), handler.ghostBalance(carol));
        assertEq(vault.balanceOf(owner), 0);
        assertEq(handler.ownerRescueUsdcSuccesses(), 0);
        assertEq(handler.ownerWithdrawSuccesses(), 0);
    }
}
