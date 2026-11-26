import { isAddressEqual, maxUint256, type Address } from 'viem'
import { ARC_CHAIN_ID, ARVEXA_ADDRESS, USDC } from '@/chain'
import type { TxPlan } from '@/lib/plan'
import { checkRecipient } from '@/lib/validate'
import { formatUsdcDisplay } from '@/lib/format'
import { USDC_DECIMALS } from '@/onchain-facts'
import { isSwapGuard, swapCalldataCheck, swapTargetCheck } from '@/guardian/swap'
import type { CheckResult } from '@/guardian/types'

/**
 * Pure checks. Each takes plain values and returns a result, so every rule is testable without a wallet or a
 * network. `preflight.ts` gathers the values (with read-only RPC calls) and feeds them in.
 */

const ok = (id: string, label: string, message?: string): CheckResult => ({ id, label, status: 'pass', message })
const warn = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'warn', message, detail })
const fail = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'fail', message, detail })
export const skipped = (id: string, label: string, message?: string): CheckResult => ({ id, label, status: 'skipped', message })

/** The wallet that will sign. */
export function checkWallet(account: Address | undefined): CheckResult {
  return account ? ok('wallet', 'Wallet connected') : fail('wallet', 'Wallet connected', 'Connect your wallet to continue.')
}

/** The wallet must be on Arc Mainnet, and the app's own chain id must match it. */
export function checkChain(walletChainId: number | undefined): CheckResult {
  if (walletChainId === undefined) return fail('chain', 'Network', 'Your wallet network could not be read. Reconnect your wallet and try again.')
  if (walletChainId !== ARC_CHAIN_ID) {
    return fail('chain', 'Network', `Your wallet is on chain ${walletChainId}. Switch to Arc Mainnet (chain ${ARC_CHAIN_ID}) to continue.`)
  }
  return ok('chain', 'Network', `Arc Mainnet (chain ${ARC_CHAIN_ID})`)
}

/** The contract the transaction goes to must be USDC or the configured Arvexa vault, nothing else. */
export function checkTarget(plan: TxPlan): CheckResult {
  if (isSwapGuard(plan)) return swapTargetCheck(plan)
  const { call } = plan
  if (call.type === 'raw') {
    // A prebuilt transaction is only allowed for a swap that carries a guard (handled above). Anything else is refused.
    return fail('target', 'Contract address', 'This transaction type is not allowed.', `raw call to ${call.to}`)
  }
  if (isAddressEqual(call.address, USDC.address)) return ok('target', 'Contract address', 'USDC on Arc')
  if (ARVEXA_ADDRESS && isAddressEqual(call.address, ARVEXA_ADDRESS)) return ok('target', 'Contract address', 'Arvexa vault')
  return fail('target', 'Contract address', 'This transaction goes to an address Arvexa does not recognise, so it was blocked.', `target ${call.address}`)
}

/** USDC has 6 decimals here; the amount must be a positive whole number of base units. */
export function checkAmountUnits(plan: TxPlan): CheckResult {
  if (plan.amount <= 0n) return fail('amount', 'Amount', 'Amount must be greater than zero.')
  return ok('amount', 'Amount', `${formatUsdcDisplay(plan.amount)} USDC (${plan.amount.toString()} base units)`)
}

/** The decimals the token reports onchain must equal what the app assumes (6). */
export function checkDecimals(onchain: number | undefined): CheckResult {
  if (USDC.decimals !== USDC_DECIMALS) return fail('decimals', 'Token decimals', 'The USDC configuration is inconsistent, so the amount cannot be trusted.', `config ${USDC.decimals} vs registry ${USDC_DECIMALS}`)
  if (onchain === undefined) return warn('decimals', 'Token decimals', 'The token decimals could not be read from the chain. The configured value (6) is used.')
  if (onchain !== USDC.decimals) return fail('decimals', 'Token decimals', `USDC reports ${onchain} decimals but Arvexa expects ${USDC.decimals}. The amount would be wrong, so it was blocked.`)
  return ok('decimals', 'Token decimals', `USDC, ${onchain} decimals`)
}

/** The encoded call must say exactly what the review screen says: same recipient, same amount, same spender. */
export function checkCalldata(plan: TxPlan, nowMs: number = Date.now()): CheckResult {
  if (isSwapGuard(plan)) return swapCalldataCheck(plan, Math.floor(nowMs / 1000))
  const { call } = plan
  const label = 'Transaction data'
  if (call.type === 'raw') return skipped('calldata', label, 'Provider calldata')
  const mismatch = (what: string) => fail('calldata', label, 'The transaction does not match what you reviewed, so it was blocked.', what)
  const args = call.args
  switch (call.functionName) {
    case 'transfer': {
      const [to, amount] = args as [Address, bigint]
      if (!plan.to || !isAddressEqual(to, plan.to)) return mismatch(`transfer recipient ${String(to)} is not the reviewed recipient`)
      if (amount !== plan.amount) return mismatch(`transfer amount ${String(amount)} is not the reviewed amount ${plan.amount}`)
      return ok('calldata', label)
    }
    case 'approve': {
      const [spender, amount] = args as [Address, bigint]
      if (!ARVEXA_ADDRESS || !isAddressEqual(spender, ARVEXA_ADDRESS)) return fail('approval', 'Approval', 'This approval is for an address that is not the Arvexa vault, so it was blocked.', `spender ${String(spender)}`)
      if (amount === maxUint256) return fail('approval', 'Approval', 'Unlimited approvals are not allowed. Approve only the amount you are using.')
      if (amount !== plan.amount) return mismatch(`approve amount ${String(amount)} is not the reviewed amount ${plan.amount}`)
      return ok('calldata', label)
    }
    case 'deposit': {
      const [amount] = args as [bigint]
      return amount === plan.amount ? ok('calldata', label) : mismatch(`deposit amount ${String(amount)} is not the reviewed amount ${plan.amount}`)
    }
    case 'withdraw': {
      const [to, amount] = args as [Address, bigint]
      if (!plan.to || !isAddressEqual(to, plan.to)) return mismatch(`withdraw recipient ${String(to)} is not the reviewed recipient`)
      if (amount !== plan.amount) return mismatch(`withdraw amount ${String(amount)} is not the reviewed amount ${plan.amount}`)
      return ok('calldata', label)
    }
    default:
      return fail('calldata', label, 'This transaction calls a function Arvexa does not recognise, so it was blocked.', `function ${call.functionName}`)
  }
}

/** The recipient, when the plan has one: a valid, non-zero address that is not the USDC token or the vault. */
export function checkRecipientOf(plan: TxPlan, account: Address | undefined): CheckResult {
  if (!plan.to) return skipped('recipient', 'Recipient')
  const result = checkRecipient(plan.to, { blockVault: true })
  if (!result.ok) return fail('recipient', 'Recipient', result.message)
  if (account && isAddressEqual(result.address, account)) return warn('recipient', 'Recipient', 'The recipient is your own wallet.')
  return ok('recipient', 'Recipient')
}

/** USDC that leaves the wallet in this transaction. */
export function usdcOutflow(plan: TxPlan): bigint {
  return plan.usdcOutflow ?? (plan.kind === 'send' || plan.kind === 'deposit' ? plan.amount : 0n)
}

/** Enough funds for the amount: the wallet for sends and top ups, the vault balance for a vault cash out. */
export function checkBalance(plan: TxPlan, wallet: bigint | undefined, vault: bigint | undefined, spendToken?: bigint): CheckResult {
  const label = 'Balance'
  if (plan.guard?.type === 'swap' && spendToken !== undefined) {
    return spendToken >= plan.guard.amountIn ? ok('balance', label, 'Enough of the token you are paying with') : fail('balance', label, 'Your balance of the token you are paying with is lower than this amount.')
  }
  const vaultCashOut = plan.kind === 'withdraw' && plan.call.type === 'contract' && plan.call.functionName === 'withdraw'
  if (vaultCashOut) {
    if (vault === undefined) return skipped('balance', label, 'Your vault balance could not be read.')
    return vault >= plan.amount
      ? ok('balance', label, `Vault ${formatUsdcDisplay(vault)} USDC`)
      : fail('balance', label, `Your vault balance (${formatUsdcDisplay(vault)} USDC) is lower than this amount.`)
  }
  const outflow = usdcOutflow(plan)
  if (outflow === 0n) return skipped('balance', label, 'No USDC leaves your wallet in this transaction.')
  if (wallet === undefined) return skipped('balance', label, 'Your USDC balance could not be read.')
  return wallet >= outflow
    ? ok('balance', label, `Wallet ${formatUsdcDisplay(wallet)} USDC`)
    : fail('balance', label, `Your USDC balance (${formatUsdcDisplay(wallet)} USDC) is lower than this amount.`)
}

/**
 * On Arc gas is paid in the same USDC pool, so the amount that leaves plus the network fee must fit in one balance.
 * The wallet USDC balance is used once; the native view of the same pool is never added.
 */
export function checkGas(plan: TxPlan, wallet: bigint | undefined, feeUsdc: bigint | undefined): CheckResult {
  const label = 'Network fee'
  if (feeUsdc === undefined) return skipped('gas', label, 'The network fee could not be estimated.')
  if (wallet === undefined) return skipped('gas', label, `Up to ${formatUsdcDisplay(feeUsdc)} USDC`)
  const required = usdcOutflow(plan) + feeUsdc
  if (wallet < required) {
    const short = required - wallet
    return fail('gas', label, `Not enough USDC for the network fee. On Arc, gas is paid in the same USDC balance. Add about ${formatUsdcDisplay(short)} USDC or reduce the amount.`)
  }
  return ok('gas', label, `Up to ${formatUsdcDisplay(feeUsdc)} USDC`)
}

/** A fee that is larger than the amount is legal but almost never what the user wants. */
export function checkFeeVsAmount(plan: TxPlan, feeUsdc: bigint | undefined): CheckResult {
  if (feeUsdc === undefined || plan.kind === 'approve' || plan.amount === 0n) return skipped('fee', 'Fee vs amount')
  if (feeUsdc >= plan.amount) {
    return warn('fee', 'Fee vs amount', `The network fee (up to ${formatUsdcDisplay(feeUsdc)} USDC) is as large as or larger than the amount (${formatUsdcDisplay(plan.amount)} USDC).`)
  }
  return ok('fee', 'Fee vs amount')
}

/** A top up needs enough allowance; an approval that is already in place is flagged as unnecessary. */
export function checkAllowance(plan: TxPlan, allowance: bigint | undefined): CheckResult {
  const label = 'Approval'
  if (plan.guard?.type === 'swap-approve') {
    if (allowance === undefined) return skipped('allowance', label)
    return allowance >= plan.amount ? warn('allowance', label, 'Permit2 is already approved for this amount. This approval is not needed.') : ok('allowance', label, 'Approving exactly the swap amount for Permit2')
  }
  const fn = plan.call.type === 'contract' ? plan.call.functionName : undefined
  if (fn === 'deposit') {
    if (allowance === undefined) return skipped('allowance', label, 'The current approval could not be read.')
    return allowance >= plan.amount
      ? ok('allowance', label, 'USDC is approved for this amount')
      : fail('allowance', label, 'USDC is not approved for this amount yet. Approve it first, then top up.')
  }
  if (fn === 'approve') {
    if (allowance === undefined) return skipped('allowance', label)
    return allowance >= plan.amount
      ? warn('allowance', label, `You already approved ${formatUsdcDisplay(allowance)} USDC for Arvexa. This approval is not needed.`)
      : ok('allowance', label, 'Approving this amount for the Arvexa vault only')
  }
  return skipped('allowance', label)
}

/** Another transaction from this wallet is still waiting to be mined. A new one queues behind it. */
export function checkPending(counts: { latest: number; pending: number } | undefined): CheckResult {
  if (!counts) return skipped('nonce', 'Pending transactions')
  const waiting = counts.pending - counts.latest
  return waiting > 0
    ? warn('nonce', 'Pending transactions', `${waiting} earlier transaction${waiting === 1 ? ' from this wallet is' : 's from this wallet are'} still pending. This one will wait behind ${waiting === 1 ? 'it' : 'them'}.`)
    : ok('nonce', 'Pending transactions', 'None')
}

/** The vault can refuse deposits while paused. */
export function checkPaused(plan: TxPlan, paused: boolean | undefined): CheckResult {
  const fn = plan.call.type === 'contract' ? plan.call.functionName : undefined
  if (fn !== 'deposit' || paused === undefined) return skipped('paused', 'Vault status')
  return paused ? fail('paused', 'Vault status', 'Top-ups are paused by the contract owner.') : ok('paused', 'Vault status')
}

/** A stable identity for "the same transaction": who, where, what, how much. Used by the lock and the registry. */
export function fingerprintOf(owner: string, plan: TxPlan): string {
  const { call } = plan
  const body =
    call.type === 'contract'
      ? `${call.address.toLowerCase()}:${call.functionName}:${call.args.map((arg) => (typeof arg === 'string' ? arg.toLowerCase() : String(arg))).join(',')}`
      : `${call.to.toLowerCase()}:${call.data}:${call.value}`
  return `${ARC_CHAIN_ID}:${owner.toLowerCase()}:${plan.kind}:${body}`
}
