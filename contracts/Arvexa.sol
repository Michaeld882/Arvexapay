// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Arvexa Vault
/// @notice Personal USDC balances without fees, yield, proxies, or discretionary custody.
/// @dev Intended for canonical six-decimal USDC on Arc Mainnet (chain ID 5042).
/// The constructor does not authenticate the token or enforce a chain ID.
/// With standard USDC behavior, completed operations preserve
/// USDC.balanceOf(address(this)) >= totalDeposits, and totalDeposits equals the
/// sum of user balances. Only a user's own withdrawal can reduce their balance.
/// Direct USDC transfers are uncredited and cannot be rescued, including surplus.
/// No receive/fallback exists: ordinary native transfers revert. Force-sent native
/// value (e.g. selfdestruct or coinbase credits) cannot be blocked, is not accounted
/// for, and cannot be recovered. Token-level freezes or pauses remain external risks.
contract Arvexa is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The immutable USDC token; amounts use six-decimal base units.
    IERC20 public immutable USDC;

    /// @notice USDC credited to each depositor, in base units.
    mapping(address => uint256) public balanceOf;

    /// @notice Sum of all credited balances, in USDC base units.
    uint256 public totalDeposits;

    error ZeroAddress();
    error TokenHasNoCode(address token);
    error ZeroAmount();
    error InvalidRecipient(address recipient);
    error InsufficientBalance(uint256 available, uint256 requested);
    error UnexpectedUSDCBalance(uint256 balanceBefore, uint256 balanceAfter, uint256 expectedIncrease);
    error USDCRescueForbidden();
    error OwnershipRenunciationDisabled();

    /// @notice Emitted after an exact-amount USDC deposit.
    event Deposited(address indexed account, uint256 amount, uint256 newBalance);
    /// @notice Emitted after a user withdraws their credited USDC.
    event Withdrawn(address indexed account, address indexed to, uint256 amount, uint256 newBalance);
    /// @notice Emitted after the owner recovers an unsupported ERC-20 asset.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /// @param usdc_ Address of canonical USDC on the intended chain; must have code.
    /// @param initialOwner Initial deposit-pause and unsupported-token recovery authority.
    constructor(address usdc_, address initialOwner) Ownable(initialOwner) {
        // Ownable rejects a zero initialOwner with OwnableInvalidOwner.
        if (usdc_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert TokenHasNoCode(usdc_);
        USDC = IERC20(usdc_);
    }

    /// @notice Deposit USDC into your personal balance after approving this vault.
    /// @param amount Positive amount in USDC base units.
    /// @dev Credits are updated before transfer; any failed or inexact receipt
    /// reverts the entire transaction, including all accounting changes.
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 newBalance = balanceOf[msg.sender] + amount;
        balanceOf[msg.sender] = newBalance;
        totalDeposits += amount;

        uint256 beforeBalance = USDC.balanceOf(address(this));
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = USDC.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert UnexpectedUSDCBalance(beforeBalance, afterBalance, amount);
        }

        emit Deposited(msg.sender, amount, newBalance);
    }

    /// @notice Withdraw your USDC to a nonzero address other than this vault.
    /// @param to Recipient of the USDC.
    /// @param amount Positive amount no greater than your credited balance.
    /// @dev Intentionally NOT blocked by pause: the owner's deposit pause must
    /// never trap user funds. Accounting is reduced before the external transfer.
    function withdraw(address to, uint256 amount) external nonReentrant {
        if (to == address(0) || to == address(this)) revert InvalidRecipient(to);
        if (amount == 0) revert ZeroAmount();
        uint256 available = balanceOf[msg.sender];
        if (amount > available) revert InsufficientBalance(available, amount);

        uint256 newBalance = available - amount;
        balanceOf[msg.sender] = newBalance;
        totalDeposits -= amount;
        USDC.safeTransfer(to, amount);

        emit Withdrawn(msg.sender, to, amount, newBalance);
    }

    /// @notice Block new deposits only; withdrawals remain available.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Re-enable deposits.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover unsupported ERC-20 assets; USDC is never recoverable by the owner.
    /// @param token Unsupported ERC-20 token to recover.
    /// @param to Nonzero recipient address.
    /// @param amount Token amount to transfer.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(USDC)) revert USDCRescueForbidden();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Whether current USDC holdings cover every credited balance.
    /// @dev Reflects the token's reported balance at the instant of the call.
    function solvency() external view returns (bool) {
        return USDC.balanceOf(address(this)) >= totalDeposits;
    }

    /// @notice Ownership cannot be renounced; use the inherited two-step transfer.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }
}
