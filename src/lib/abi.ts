import { parseAbi } from 'viem'

/** ABI of contracts/Arvexa.sol (only what the app uses, plus its custom errors). */
export const arvexaAbi = parseAbi([
  'function USDC() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalDeposits() view returns (uint256)',
  'function paused() view returns (bool)',
  'function solvency() view returns (bool)',
  'function deposit(uint256 amount)',
  'function withdraw(address to, uint256 amount)',
  'event Deposited(address indexed account, uint256 amount, uint256 newBalance)',
  'event Withdrawn(address indexed account, address indexed to, uint256 amount, uint256 newBalance)',
  'error ZeroAmount()',
  'error InvalidRecipient(address recipient)',
  'error InsufficientBalance(uint256 available, uint256 requested)',
  'error UnexpectedUSDCBalance(uint256 balanceBefore, uint256 balanceAfter, uint256 expectedIncrease)',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()',
])
