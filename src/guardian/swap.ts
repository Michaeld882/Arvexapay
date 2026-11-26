import { decodeFunctionData, isAddressEqual, maxUint256, parseAbi, type Address } from 'viem'
import type { PlanGuard, TxPlan } from '@/lib/plan'
import { SLIPPAGE_MAX_BPS, PRICE_IMPACT_BLOCK, PRICE_IMPACT_WARN, SWAP_ADDRESSES, SWAP_TOKENS, isNativeSentinel } from '@/lib/uniswap'
import type { CheckResult } from '@/guardian/types'

/**
 * Guardian rules for swaps. They apply only to plans the swap builders marked with a `guard`, and they compare the
 * encoded call with the app's own list of verified Uniswap addresses and tokens (src/lib/uniswap.ts), never with the
 * plan's own claim alone. The swap provider itself is verified separately against the live chain before signing.
 */

const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)'])

/** A quote older than this is not traded on. The swap page re-quotes right before it builds the transaction. */
export const QUOTE_MAX_AGE_MS = 60_000
/** The router deadline must still be this far away when the wallet opens. */
export const DEADLINE_MARGIN_S = 60
const MAX_PERMIT_LIFETIME_S = 3_600
const UINT160_MAX = (1n << 160n) - 1n

const pass = (id: string, label: string, message?: string): CheckResult => ({ id, label, status: 'pass', message })
const warn = (id: string, label: string, message: string): CheckResult => ({ id, label, status: 'warn', message })
const fail = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'fail', message, detail })

const knownToken = (address: Address) => SWAP_TOKENS.find((token) => isAddressEqual(token.address, address))

export const isSwapGuard = (plan: TxPlan): plan is TxPlan & { guard: PlanGuard } => plan.guard !== undefined

/** Where the transaction goes. */
export function swapTargetCheck(plan: TxPlan & { guard: PlanGuard }): CheckResult {
  const { guard, call } = plan
  const label = 'Contract address'
  if (guard.type === 'swap') {
    if (call.type !== 'raw') return fail('target', label, 'This swap is not built the way Arvexa builds swaps, so it was blocked.')
    if (!isAddressEqual(call.to, SWAP_ADDRESSES.universalRouter) || !isAddressEqual(guard.router, SWAP_ADDRESSES.universalRouter)) {
      return fail('target', label, 'This swap goes to an address that is not the verified Uniswap router, so it was blocked.', `to ${call.to}`)
    }
    if (call.value !== 0n) return fail('target', label, 'This swap would send native currency with it, which Arvexa swaps never do, so it was blocked.', `value ${call.value}`)
    return pass('target', label, 'Verified Uniswap router on Arc')
  }
  if (call.type !== 'contract') return fail('target', label, 'This approval is not a standard contract call, so it was blocked.')
  if (!knownToken(guard.token) || !isAddressEqual(call.address, guard.type === 'swap-approve' ? guard.token : SWAP_ADDRESSES.permit2)) {
    return fail('target', label, 'This approval is for a token or contract that Arvexa does not recognise, so it was blocked.', `target ${call.address}`)
  }
  return pass('target', label, guard.type === 'swap-approve' ? 'Swap token' : 'Permit2')
}

/** The encoded call must say exactly what the review screen says. */
export function swapCalldataCheck(plan: TxPlan & { guard: PlanGuard }, nowS: number): CheckResult {
  const { guard, call } = plan
  const label = 'Transaction data'
  const mismatch = (what: string) => fail('calldata', label, 'The transaction does not match what you reviewed, so it was blocked.', what)
  if (guard.type === 'swap') {
    if (call.type !== 'raw') return mismatch('not a raw router call')
    let decoded: ReturnType<typeof decodeFunctionData<typeof routerAbi>>
    try {
      decoded = decodeFunctionData({ abi: routerAbi, data: call.data })
    } catch {
      return mismatch('call data is not a Universal Router execute call')
    }
    const deadline = decoded.args?.[2]
    if (deadline === undefined || deadline !== BigInt(guard.deadline)) return mismatch(`router deadline ${String(deadline)} is not the reviewed deadline ${guard.deadline}`)
    if (Number(deadline) < nowS + DEADLINE_MARGIN_S) return fail('calldata', label, 'This swap is about to expire. Close this screen and review it again for a fresh quote.', `deadline ${deadline} now ${nowS}`)
    return pass('calldata', label)
  }
  if (call.type !== 'contract') return mismatch('not a contract call')
  const args = call.args
  if (guard.type === 'swap-approve') {
    const [spender, amount] = args as [Address, bigint]
    if (call.functionName !== 'approve' || !isAddressEqual(spender, SWAP_ADDRESSES.permit2) || !isAddressEqual(guard.spender, SWAP_ADDRESSES.permit2)) {
      return fail('approval', 'Approval', 'This approval is for an address that is not Permit2, so it was blocked.', `spender ${String(spender)}`)
    }
    if (amount === maxUint256) return fail('approval', 'Approval', 'Unlimited approvals are not allowed. Approve only the amount you are swapping.')
    return amount === plan.amount ? pass('calldata', label) : mismatch(`approve amount ${String(amount)} is not the reviewed amount ${plan.amount}`)
  }
  const [token, router, amount, expiration] = args as [Address, Address, bigint, number]
  if (call.functionName !== 'approve' || !isAddressEqual(token, guard.token) || !knownToken(token)) return fail('approval', 'Approval', 'This allowance is for a token that Arvexa does not recognise, so it was blocked.', `token ${String(token)}`)
  if (!isAddressEqual(router, SWAP_ADDRESSES.universalRouter) || !isAddressEqual(guard.router, SWAP_ADDRESSES.universalRouter)) {
    return fail('approval', 'Approval', 'This allowance is for an address that is not the verified Uniswap router, so it was blocked.', `router ${String(router)}`)
  }
  if (amount > UINT160_MAX || amount !== plan.amount) return mismatch(`allowance ${String(amount)} is not the reviewed amount ${plan.amount}`)
  if (Number(expiration) > nowS + MAX_PERMIT_LIFETIME_S) return fail('approval', 'Approval', 'This allowance would last longer than an hour, so it was blocked.', `expiration ${String(expiration)}`)
  return pass('calldata', label)
}

/** Tokens, slippage, minimum received, quote age and price impact for a swap. Other guards have nothing extra. */
export function swapExtraChecks(plan: TxPlan & { guard: PlanGuard }, nowMs: number): CheckResult[] {
  const { guard } = plan
  if (guard.type !== 'swap') return []
  const checks: CheckResult[] = []
  const tokenIn = knownToken(guard.tokenIn)
  const tokenOut = knownToken(guard.tokenOut)
  if (!tokenIn || !tokenOut || isNativeSentinel(guard.tokenIn) || isNativeSentinel(guard.tokenOut)) checks.push(fail('token', 'Tokens', 'One of these tokens is not a verified swap token, so the swap was blocked.'))
  else if (isAddressEqual(guard.tokenIn, guard.tokenOut)) checks.push(fail('token', 'Tokens', 'Choose two different tokens.'))
  else checks.push(pass('token', 'Tokens', `${tokenIn.symbol} to ${tokenOut.symbol}`))

  if (guard.slippageBps > SLIPPAGE_MAX_BPS || guard.slippageBps < 0) {
    checks.push(fail('slippage', 'Slippage', `The slippage limit (${(guard.slippageBps / 100).toFixed(2)}%) is above the ${(SLIPPAGE_MAX_BPS / 100).toFixed(2)}% maximum.`))
  } else if (guard.minAmountOut <= 0n || guard.minAmountOut > guard.amountOut) {
    checks.push(fail('slippage', 'Minimum received', 'The minimum received is not valid for this quote, so the swap was blocked.', `min ${guard.minAmountOut} out ${guard.amountOut}`))
  } else {
    // The minimum must be no lower than the quote less the slippage limit (one base unit of rounding allowed).
    const floor = (guard.amountOut * BigInt(10_000 - guard.slippageBps)) / 10_000n - 1n
    checks.push(guard.minAmountOut >= floor ? pass('slippage', 'Slippage', `${(guard.slippageBps / 100).toFixed(2)}% limit, minimum received protected`) : fail('slippage', 'Minimum received', 'The minimum received is lower than your slippage limit allows, so the swap was blocked.', `min ${guard.minAmountOut} floor ${floor}`))
  }

  const age = nowMs - guard.quotedAt
  checks.push(age <= QUOTE_MAX_AGE_MS ? pass('quote', 'Quote', `${Math.max(0, Math.round(age / 1000))}s old`) : fail('quote', 'Quote', 'This quote is out of date. Close this screen and review the swap again for a fresh quote.', `age ${age}ms`))

  const impact = guard.priceImpact ?? 0
  if (impact > PRICE_IMPACT_BLOCK) checks.push(fail('impact', 'Price impact', `The price impact (${(impact * 100).toFixed(2)}%) is above the safety limit, so the swap was blocked.`))
  else if (impact > PRICE_IMPACT_WARN) checks.push(warn('impact', 'Price impact', `The price impact is ${(impact * 100).toFixed(2)}%. You lose that much against the mid price.`))
  else checks.push(pass('impact', 'Price impact', `${(impact * 100).toFixed(2)}%`))
  return checks
}

/** The token whose balance this plan spends, when it is not USDC (the USDC pool also pays gas and is read anyway). */
export function swapSpendToken(plan: TxPlan): Address | undefined {
  return plan.guard?.type === 'swap' ? plan.guard.tokenIn : undefined
}

/** The ERC-20 approval a swap-approve plan will set, so its current allowance can be read. */
export function swapAllowanceTarget(plan: TxPlan): { token: Address; spender: Address } | undefined {
  return plan.guard?.type === 'swap-approve' ? { token: plan.guard.token, spender: plan.guard.spender } : undefined
}
