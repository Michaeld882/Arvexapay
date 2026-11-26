import { beforeEach, describe, expect, test } from 'bun:test'
import { encodeFunctionData, maxUint256, parseAbi, type Address } from 'viem'
import { ARC_CHAIN_ID, USDC } from '../src/chain'
import { runPreflight, type PreflightReads } from '../src/guardian/preflight'
import { QUOTE_MAX_AGE_MS } from '../src/guardian/swap'
import { clearReadCache } from '../src/guardian/retry'
import { buildPermit2ApprovePlan, buildSwapApprovePlan, buildSwapPlan } from '../src/lib/swapPlan'
import { SWAP_ADDRESSES, SWAP_TOKENS } from '../src/lib/uniswap'
import type { SwapQuote, SwapRequest, SwapTransaction } from '../src/swap-config'
import type { TxPlan } from '../src/lib/plan'

const ME = '0x2222222222222222222222222222222222222222' as Address
const ONE = 1_000_000n
const [usdc, eurc] = SWAP_TOKENS
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)'])
const T0 = 1_800_000_000_000

beforeEach(() => clearReadCache())

function reads(overrides: Partial<PreflightReads> = {}): PreflightReads {
  return {
    usdcDecimals: async () => 6,
    usdcBalance: async () => 100n * ONE,
    erc20Allowance: async () => 0n,
    tokenBalance: async () => 100n * ONE,
    verifySwapProvider: async () => undefined,
    vaultBalance: async () => 0n,
    vaultPaused: async () => false,
    estimateFee: async () => ({ gas: 200_000n, feeUsdc: 5_000n }),
    simulate: async () => undefined,
    txCounts: async () => ({ latest: 1, pending: 1 }),
    receiptStatus: async () => 'pending',
    readReceipt: async () => undefined,
    ...overrides,
  }
}

const deadline = Math.floor(T0 / 1000) + 1200
const request = (extra: Partial<SwapRequest> = {}): SwapRequest => ({ tokenIn: eurc, tokenOut: usdc, amountIn: 10n * ONE, recipient: ME, slippageBps: 50, ...extra }) as SwapRequest
const quote = (extra: Partial<SwapQuote> = {}): SwapQuote => ({ amountOut: 10_800_000n, minAmountOut: 10_746_000n, deadline: Math.floor(T0 / 1000) + 30, priceImpact: 0.001, ...extra })
const tx = (extra: Partial<SwapTransaction> = {}): SwapTransaction => ({ to: SWAP_ADDRESSES.universalRouter, data: encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: ['0x00', [], BigInt(deadline)] }), value: 0n, spender: SWAP_ADDRESSES.permit2, deadline, ...extra })
const swap = (r = request(), q = quote(), t = tx()): TxPlan => {
  const plan = buildSwapPlan(r, q, t)
  return { ...plan, guard: { ...plan.guard, quotedAt: T0 } as NonNullable<TxPlan['guard']> }
}
const run = (plan: TxPlan, fake: PreflightReads = reads(), nowMs = T0 + 5_000) => runPreflight({ plan, account: ME, walletChainId: ARC_CHAIN_ID, now: () => nowMs }, fake)
const failing = (report: { checks: Array<{ id: string; status: string }> }) => report.checks.filter((check) => check.status === 'fail').map((check) => check.id)

describe('swap guardian: a verified swap', () => {
  test('a normal swap through the verified router is ready, simulated, and not altered', async () => {
    const plan = swap()
    const report = await run(plan)
    expect(failing(report)).toEqual([])
    expect(report.verdict).toBe('ready')
    expect(report.simulated).toBe(true)
    expect(report.checks.find((check) => check.id === 'provider')?.status).toBe('pass')
    expect(plan.amount).toBe(10n * ONE)
  })

  test('swapping USDC checks the USDC pool, swapping EURC checks the EURC balance', async () => {
    const lowEurc = await run(swap(), reads({ tokenBalance: async () => ONE }))
    expect(failing(lowEurc)).toContain('balance')
    const usdcIn = swap(request({ tokenIn: usdc, tokenOut: eurc }))
    const lowUsdc = await run(usdcIn, reads({ usdcBalance: async () => 5n * ONE }))
    expect(failing(lowUsdc)).toContain('balance')
    expect((await run(usdcIn)).verdict).toBe('ready')
  })
})

describe('swap guardian: blocked before the wallet', () => {
  test('a router that is not the verified one, a payable swap and unknown calldata are blocked', async () => {
    expect(failing(await run(swap(request(), quote(), tx({ to: '0x1111111111111111111111111111111111111111' }))))).toContain('target')
    expect(failing(await run(swap(request(), quote(), tx({ value: 1n }))))).toContain('target')
    expect(failing(await run(swap(request(), quote(), tx({ data: '0xdeadbeef' }))))).toContain('calldata')
  })

  test('a router deadline that differs from the reviewed one, or is about to pass, is blocked', async () => {
    const plan = swap()
    expect(failing(await run({ ...plan, guard: { ...plan.guard, deadline: deadline + 5 } as NonNullable<TxPlan['guard']> }))).toContain('calldata')
    expect(failing(await run(plan, reads(), (deadline - 10) * 1000 + 0))).toContain('calldata')
  })

  test('a stale quote is blocked; a fresh one is not', async () => {
    const plan = swap()
    const stale = await run(plan, reads(), T0 + QUOTE_MAX_AGE_MS + 1)
    expect(stale.verdict).toBe('blocked')
    expect(failing(stale)).toContain('quote')
    expect((await run(plan, reads(), T0 + QUOTE_MAX_AGE_MS - 1_000)).verdict).toBe('ready')
  })

  test('slippage above the maximum, or a minimum received below what the slippage allows, is blocked', async () => {
    expect(failing(await run(swap(request({ slippageBps: 500 }), quote({ minAmountOut: 10_260_000n }))))).toContain('slippage')
    expect(failing(await run(swap(request(), quote({ minAmountOut: 9_000_000n }))))).toContain('slippage')
    expect(failing(await run(swap(request(), quote({ minAmountOut: 0n }))))).toContain('slippage')
    expect(failing(await run(swap(request(), quote({ minAmountOut: 11_000_000n }))))).toContain('slippage')
  })

  test('a large price impact blocks, a moderate one asks for review', async () => {
    expect(failing(await run(swap(request(), quote({ priceImpact: 0.08 }))))).toContain('impact')
    const moderate = await run(swap(request(), quote({ priceImpact: 0.03 })))
    expect(moderate.verdict).toBe('review')
  })

  test('an unknown token or two identical tokens are blocked', async () => {
    const odd = { ...eurc, address: '0x3333333333333333333333333333333333333333' as Address }
    expect(failing(await run(swap(request({ tokenIn: odd }))))).toContain('token')
    expect(failing(await run(swap(request({ tokenIn: usdc, tokenOut: usdc }))))).toContain('token')
  })

  test('a swap reverting in simulation is blocked and the swap is never offered to the wallet', async () => {
    const report = await run(swap(), reads({ simulate: async () => Promise.reject(new Error('execution reverted: TransactionDeadlinePassed')) }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toContain('simulation')
    expect(report.technical).toContain('TransactionDeadlinePassed')
  })
})

describe('swap guardian: the provider must be verified', () => {
  test('a provider that fails verification blocks the swap', async () => {
    const report = await run(swap(), reads({ verifySwapProvider: async () => Promise.reject(new Error('Universal Router has no code')) }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toContain('provider')
    expect(report.reason).toContain('could not be verified')
  })

  test('a network timeout while verifying is a retryable network problem, not a pass', async () => {
    const report = await run(swap(), reads({ verifySwapProvider: async () => Promise.reject(new Error('The request timed out.')) }))
    expect(report.verdict).toBe('blocked')
    expect(report.rpcFailure).toBe(true)
  })
})

describe('swap guardian: approvals', () => {
  const approve = (spender: Address = SWAP_ADDRESSES.permit2, amount = 10n * ONE): TxPlan => {
    const plan = buildSwapApprovePlan(ME, request(), spender)
    return { ...plan, call: { ...plan.call, args: [spender, amount] } as TxPlan['call'] }
  }

  test('approving exactly the swap amount for Permit2 passes', async () => {
    expect((await run(buildSwapApprovePlan(ME, request(), SWAP_ADDRESSES.permit2))).verdict).toBe('ready')
  })

  test('another spender or an unlimited amount is blocked', async () => {
    expect(failing(await run(approve('0x1111111111111111111111111111111111111111')))).toContain('approval')
    expect(failing(await run(approve(SWAP_ADDRESSES.permit2, maxUint256)))).toContain('approval')
    expect(failing(await run(approve(SWAP_ADDRESSES.permit2, 11n * ONE)))).toContain('calldata')
  })

  test('an approval that is already in place is flagged as unnecessary, not repeated silently', async () => {
    const report = await run(buildSwapApprovePlan(ME, request(), SWAP_ADDRESSES.permit2), reads({ erc20Allowance: async () => 20n * ONE }))
    expect(report.verdict).toBe('review')
    expect(report.checks.find((check) => check.id === 'allowance')?.status).toBe('warn')
  })

  test('the Permit2 allowance to the router is limited to the amount and to an hour', async () => {
    const nowS = Math.floor((T0 + 5_000) / 1000)
    const good = buildPermit2ApprovePlan(ME, request(), SWAP_ADDRESSES.permit2, SWAP_ADDRESSES.universalRouter, nowS + 1800)
    expect((await run(good)).verdict).toBe('ready')
    const long = buildPermit2ApprovePlan(ME, request(), SWAP_ADDRESSES.permit2, SWAP_ADDRESSES.universalRouter, nowS + 86_400)
    expect(failing(await run(long))).toContain('approval')
    const wrongRouter = buildPermit2ApprovePlan(ME, request(), SWAP_ADDRESSES.permit2, '0x1111111111111111111111111111111111111111', nowS + 1800)
    expect(failing(await run(wrongRouter))).toContain('approval')
    const wrongToken = buildPermit2ApprovePlan(ME, request({ tokenIn: { ...eurc, address: '0x3333333333333333333333333333333333333333' as Address } }), SWAP_ADDRESSES.permit2, SWAP_ADDRESSES.universalRouter, nowS + 1800)
    expect(failing(await run(wrongToken))).toContain('approval')
  })

  test('USDC is still the swap input whose pool also pays the fee', () => {
    expect(usdc.address).toBe(USDC.address)
  })
})
