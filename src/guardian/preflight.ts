import { erc20Abi, isAddressEqual, type Address, type Hex, type TransactionReceipt } from 'viem'
import { ARVEXA_ADDRESS, USDC } from '@/chain'
import { arvexaAbi } from '@/lib/abi'
import { AppError, classifyError, isTransientError } from '@/lib/errors'
import type { PlannedCall, TxPlan } from '@/lib/plan'
import { getArcClient } from '@/lib/rpc'
import { estimateFee, type FeeEstimate } from '@/hooks/useFeeEstimate'
import {
  checkAllowance, checkAmountUnits, checkBalance, checkCalldata, checkChain, checkDecimals, checkFeeVsAmount, checkGas, checkPaused,
  checkPending, checkRecipientOf, checkTarget, checkWallet, fingerprintOf, skipped,
} from '@/guardian/checks'
import { dedupedRead, retryRead, type RetryOptions } from '@/guardian/retry'
import { findInFlightDuplicate, type Submission } from '@/guardian/lock'
import { isSwapGuard, swapAllowanceTarget, swapExtraChecks, swapSpendToken } from '@/guardian/swap'
import { SWAP_PROVIDER } from '@/swap-config'
import type { CheckResult, GuardianReport } from '@/guardian/types'

/**
 * Everything the Guardian reads from the chain, behind one interface so tests can supply answers and so every read
 * is read-only. The default implementation (`chainReads`) deduplicates and caches reads and retries only transient
 * RPC failures.
 */
export interface PreflightReads {
  usdcDecimals(): Promise<number>
  usdcBalance(account: Address): Promise<bigint>
  erc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint>
  /** Balance of a swap token other than USDC. */
  tokenBalance(token: Address, account: Address): Promise<bigint>
  /** Throws when the swap provider is missing or its contracts do not check out against the live chain. */
  verifySwapProvider(): Promise<void>
  vaultBalance(account: Address): Promise<bigint>
  vaultPaused(): Promise<boolean>
  estimateFee(call: PlannedCall, account: Address): Promise<FeeEstimate>
  /** Runs the exact call as an eth_call from the account. Throws when it would revert. Sends nothing. */
  simulate(call: PlannedCall, account: Address): Promise<void>
  txCounts(account: Address): Promise<{ latest: number; pending: number }>
  /** Status of a hash this app submitted earlier. Used to settle a "pending" duplicate before blocking on it. */
  receiptStatus(hash: Hex): Promise<'success' | 'reverted' | 'pending'>
  /** The receipt itself, or undefined while the transaction is not mined. Read-only. */
  readReceipt(hash: Hex): Promise<TransactionReceipt | undefined>
}

export interface PreflightInput {
  plan: TxPlan
  account: Address | undefined
  walletChainId: number | undefined
  /** Skip the short read cache. Used for the final check right before the wallet opens. */
  fresh?: boolean
  now?: () => number
}

const SHORT = 8_000
const LONG = 10 * 60_000

export function chainReads(options: { fresh?: boolean; retry?: RetryOptions } = {}): PreflightReads {
  const read = <T>(key: string, ttl: number, fn: () => Promise<T>, fresh = options.fresh): Promise<T> =>
    dedupedRead(key, ttl, () => retryRead(fn, options.retry), { fresh })
  const client = () => getArcClient()
  return {
    // Token decimals never change, so they are cached for the session.
    usdcDecimals: () => read('guardian:decimals', LONG, () => client().readContract({ address: USDC.address, abi: erc20Abi, functionName: 'decimals' }), false),
    usdcBalance: (account) => read(`guardian:usdc:${account}`, SHORT, () => client().readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] })),
    erc20Allowance: (token, owner, spender) => read(`guardian:allow:${token}:${owner}:${spender}`, SHORT, () => client().readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })),
    tokenBalance: (token, account) => read(`guardian:token:${token}:${account}`, SHORT, () => client().readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] })),
    // The provider re-checks its own contracts, tokens and pools against the chain. Cached for a few minutes.
    verifySwapProvider: () =>
      read('guardian:swap-provider', 5 * 60_000, async () => {
        if (!SWAP_PROVIDER) throw new AppError('swap_unavailable', 'No verified swap provider is configured')
        await SWAP_PROVIDER.verify()
      }, false),
    vaultBalance: (account) => read(`guardian:vault:${account}`, SHORT, () => client().readContract({ address: ARVEXA_ADDRESS as Address, abi: arvexaAbi, functionName: 'balanceOf', args: [account] })),
    vaultPaused: () => read('guardian:paused', SHORT, () => client().readContract({ address: ARVEXA_ADDRESS as Address, abi: arvexaAbi, functionName: 'paused' })),
    estimateFee: (call, account) => estimateFee(call, account, { fresh: options.fresh }),
    // The simulation is always fresh: it must reflect the chain now, never an earlier answer.
    simulate: async (call, account) => {
      await retryRead(async () => {
        if (call.type === 'contract') await client().simulateContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, account })
        else await client().call({ account, to: call.to, data: call.data, value: call.value })
      }, options.retry)
    },
    txCounts: (account) =>
      read(`guardian:nonce:${account}`, 5_000, async () => {
        const [latest, pending] = await Promise.all([
          client().getTransactionCount({ address: account, blockTag: 'latest' }),
          client().getTransactionCount({ address: account, blockTag: 'pending' }),
        ])
        return { latest, pending }
      }),
    // A hash's status is read fresh: it decides whether an earlier submission is still in flight.
    readReceipt: (hash) =>
      read(`guardian:receipt:${hash}`, 4_000, async () => {
        try {
          return await client().getTransactionReceipt({ hash })
        } catch (err) {
          if (/not found|could not be found|TransactionReceiptNotFound/i.test(String((err as Error)?.message ?? err) + String((err as Error)?.name ?? ''))) return undefined
          throw err
        }
      }),
    receiptStatus: (hash) =>
      retryRead(async () => {
        try {
          const receipt = await client().getTransactionReceipt({ hash })
          return receipt.status === 'success' ? 'success' : 'reverted'
        } catch (err) {
          if (/not found|could not be found/i.test(String((err as Error)?.message))) return 'pending'
          throw err
        }
      }, options.retry),
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function settle<T>(read: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read }
  } catch (error) {
    return { ok: false, error }
  }
}

export const verdictOf = (checks: CheckResult[]): GuardianReport['verdict'] =>
  checks.some((check) => check.status === 'fail') ? 'blocked' : checks.some((check) => check.status === 'warn') ? 'review' : 'ready'

/**
 * Validates a transaction and simulates the exact call before the wallet is opened. Reads only. The amount and the
 * recipient are never changed: a problem is reported, not repaired.
 */
export async function runPreflight(input: PreflightInput, reads: PreflightReads = chainReads({ fresh: input.fresh })): Promise<GuardianReport> {
  const { plan, account, walletChainId } = input
  const now = input.now ?? Date.now
  const checks: CheckResult[] = []
  const readFailures: Array<{ what: string; error: unknown }> = []
  const noteRead = <T,>(what: string, result: Settled<T>): T | undefined => {
    if (result.ok) return result.value
    readFailures.push({ what, error: result.error })
    return undefined
  }

  // 1. Static checks: nothing to read.
  checks.push(checkWallet(account), checkChain(walletChainId), checkTarget(plan), checkAmountUnits(plan), checkCalldata(plan, now()), checkRecipientOf(plan, account))
  if (isSwapGuard(plan)) checks.push(...swapExtraChecks(plan, now()))
  const staticFailed = checks.some((check) => check.status === 'fail')
  const fn = plan.call.type === 'contract' ? plan.call.functionName : undefined

  if (!account || staticFailed) {
    return finish(checks, false, readFailures, undefined, now())
  }

  // 2. Reads, in parallel. A read that fails is recorded; it never becomes a guess.
  const swapApproval = swapAllowanceTarget(plan)
  const needsAllowance = !plan.guard && (fn === 'deposit' || fn === 'approve')
  const vaultConfigured = Boolean(ARVEXA_ADDRESS)
  const spendToken = swapSpendToken(plan)
  const none = Promise.resolve<Settled<undefined>>({ ok: true, value: undefined })
  const [decimals, wallet, allowance, vault, paused, fee, counts, tokenIn, provider] = await Promise.all([
    settle(reads.usdcDecimals()),
    settle(reads.usdcBalance(account)),
    swapApproval ? settle(reads.erc20Allowance(swapApproval.token, account, swapApproval.spender)) : needsAllowance && ARVEXA_ADDRESS ? settle(reads.erc20Allowance(USDC.address, account, ARVEXA_ADDRESS)) : none,
    plan.kind === 'withdraw' && vaultConfigured ? settle(reads.vaultBalance(account)) : Promise.resolve<Settled<undefined>>({ ok: true, value: undefined }),
    fn === 'deposit' && vaultConfigured ? settle(reads.vaultPaused()) : Promise.resolve<Settled<undefined>>({ ok: true, value: undefined }),
    settle(reads.estimateFee(plan.call, account)),
    settle(reads.txCounts(account)),
    spendToken && !isAddressEqual(spendToken, USDC.address) ? settle(reads.tokenBalance(spendToken, account)) : none,
    plan.guard ? settle(reads.verifySwapProvider()) : none,
  ])
  const decimalsValue = noteRead('token decimals', decimals)
  const walletBalance = noteRead('USDC balance', wallet)
  const allowanceValue = noteRead('USDC approval', allowance)
  const vaultBalance = noteRead('vault balance', vault)
  const pausedValue = noteRead('vault status', paused)
  const counted = noteRead('pending transactions', counts)
  const tokenInBalance = noteRead('token balance', tokenIn)
  if (plan.guard) {
    if (provider.ok) checks.push({ id: 'provider', label: 'Swap provider', status: 'pass', message: 'The swap provider and its contracts were verified against the chain.' })
    else if (isTransientError(provider.error)) readFailures.push({ what: 'USDC balance', error: provider.error })
    else checks.push({ id: 'provider', label: 'Swap provider', status: 'fail', message: 'The swap provider could not be verified against the chain, so the swap was blocked.', detail: classifyError(provider.error).detail })
  }
  // A fee estimate that fails is itself a simulation failure when it reverted; a transient failure is an RPC problem.
  let feeUsdc: bigint | undefined
  let estimateError: unknown
  if (fee.ok) feeUsdc = fee.value.feeUsdc
  else estimateError = fee.error

  checks.push(
    checkDecimals(decimalsValue),
    checkBalance(plan, walletBalance, vaultBalance, tokenInBalance),
    checkPaused(plan, pausedValue),
    checkAllowance(plan, allowanceValue),
    checkGas(plan, walletBalance, feeUsdc),
    checkFeeVsAmount(plan, feeUsdc),
    checkPending(counted),
  )

  // 3. Duplicate: an identical transaction already handed to a wallet or submitted. Its status is read first, so a
  //    transaction that has since finished never blocks a new one.
  const duplicate = await duplicateCheck(account, plan, reads, now(), checks, readFailures)

  // 4. Simulate the exact call, only when nothing above already makes it pointless or impossible.
  const hardFail = checks.some((check) => check.status === 'fail')
  let simulated = false
  let technical: string | undefined
  if (hardFail) {
    checks.push(skipped('simulation', 'Simulation', 'Not run because a check above failed.'))
  } else if (estimateError !== undefined && !isTransientError(estimateError)) {
    // The gas estimate runs the call, so a revert here is the simulation result.
    const app = classifyError(estimateError)
    checks.push({ id: 'simulation', label: 'Simulation', status: 'fail', message: simulationMessage(app), detail: app.detail })
    technical = app.detail
  } else {
    const sim = await settle(reads.simulate(plan.call, account))
    if (sim.ok) {
      simulated = true
      checks.push({ id: 'simulation', label: 'Simulation', status: 'pass', message: 'The exact transaction ran without reverting against the current chain state. This is not a guarantee it will succeed.' })
    } else if (isTransientError(sim.error)) {
      readFailures.push({ what: 'simulation', error: sim.error })
      checks.push(skipped('simulation', 'Simulation', 'The network did not answer.'))
    } else {
      const app = classifyError(sim.error)
      checks.push({ id: 'simulation', label: 'Simulation', status: 'fail', message: simulationMessage(app), detail: app.detail })
      technical = app.detail
    }
  }
  if (estimateError !== undefined && isTransientError(estimateError)) readFailures.push({ what: 'network fee', error: estimateError })

  return finish(checks, simulated, readFailures, duplicate, now(), technical)
}

function simulationMessage(app: AppError): string {
  return app.kind === 'unknown' ? 'The network rejected this transaction when it was simulated, so nothing was sent.' : app.message
}

async function duplicateCheck(account: Address, plan: TxPlan, reads: PreflightReads, now: number, checks: CheckResult[], failures: Array<{ what: string; error: unknown }>): Promise<Submission | undefined> {
  const label = 'Duplicate submission'
  const match = findInFlightDuplicate(account, fingerprintOf(account, plan), now)
  if (!match) {
    checks.push({ id: 'duplicate', label, status: 'pass' })
    return undefined
  }
  if (match.hash) {
    const status = await settle(reads.receiptStatus(match.hash))
    if (status.ok && status.value !== 'pending') {
      checks.push({ id: 'duplicate', label, status: 'pass', message: 'The earlier identical transaction has already finished.' })
      return undefined
    }
    if (!status.ok) failures.push({ what: 'earlier transaction status', error: status.error })
  }
  checks.push({
    id: 'duplicate',
    label,
    status: 'fail',
    message: match.hash
      ? 'An identical transaction was already submitted and has not finished. Wait for it instead of sending it again.'
      : 'An identical transaction is waiting for your wallet. Finish or reject it there first.',
    detail: match.hash ? `earlier hash ${match.hash}` : undefined,
  })
  return match
}

/** Reads whose failure means the transaction cannot be judged at all, so signing waits until they work. */
const RPC_BLOCKING: ReadonlySet<string> = new Set(['simulation', 'network fee', 'USDC balance', 'fee quote', 'source balance', 'source gas balance'])

export function finish(checks: CheckResult[], simulated: boolean, failures: Array<{ what: string; error: unknown }>, duplicate: Submission | undefined, checkedAt: number, technical?: string): GuardianReport {
  const failed = checks.filter((check) => check.status === 'fail')
  const rpcOnly = failed.length === 0 && failures.some((item) => RPC_BLOCKING.has(item.what))
  if (rpcOnly) {
    const detail = failures.map((item) => `${item.what}: ${classifyError(item.error).detail}`).join('\n')
    return {
      verdict: 'blocked',
      checks,
      simulated: false,
      reason: 'Arc Mainnet could not be reached to check this transaction. Nothing was sent. Try again in a moment.',
      technical: detail,
      rpcFailure: true,
      checkedAt,
    }
  }
  const verdict = verdictOf(checks)
  return {
    verdict,
    checks,
    simulated,
    reason: failed[0]?.message,
    technical: technical ?? failed.map((check) => check.detail).find(Boolean),
    rpcFailure: false,
    duplicateOf: duplicate?.hash,
    checkedAt,
  }
}
