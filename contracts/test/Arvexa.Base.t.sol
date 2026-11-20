// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Arvexa} from "../Arvexa.sol";

/// @dev 6-decimal mock USDC with open mint/burn for test seeding.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Burns 1% of every transfer between two non-zero accounts.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @dev On every real transfer, calls `target` with `data` (as the token). Used to attempt reentrancy.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public data;
    bool public swallow; // if true, record the outcome instead of bubbling the revert
    bool public armed;
    bool public lastReentrySucceeded;
    bytes public lastReentryRevertData;

    constructor() ERC20("Evil", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_, bool swallow_) external {
        target = target_;
        data = data_;
        swallow = swallow_;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0)) {
            armed = false; // single attempt
            (bool ok, bytes memory ret) = target.call(data);
            if (swallow) {
                lastReentrySucceeded = ok;
                lastReentryRevertData = ret;
            } else if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}

abstract contract ArvexaTestBase is Test {
    Arvexa internal vault;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant START = 1_000_000e6;

    function setUp() public virtual {
        usdc = new MockUSDC();
        vault = new Arvexa(address(usdc), owner);
        usdc.mint(alice, START);
        usdc.mint(bob, START);
        usdc.mint(carol, START);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(carol);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount);
    }
}
