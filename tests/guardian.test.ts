import { beforeEach, describe, expect, test } from 'bun:test'
import { maxUint256, type Address, type Hex } from 'viem'
import { ARC_CHAIN_ID, ARVEXA_ADDRESS, USDC } from '../src/chain'
import { checkAllowance, checkBalance, checkCalldata, checkChain, checkDecimals, checkFeeVsAmount, checkGas, checkPaused, checkPending, checkRecipientOf, checkTarget, fingerprintOf } from '../src/guardian/checks'
import { beginSubmission, createTxLock, dropSubmission, findInFlightDuplicate, IN_FLIGHT_WINDOW_MS, SIGNING_WINDOW_MS, updateSubmission } from '../src/guardian/lock'
import { runPreflight, type PreflightReads } from '../src/guardian/preflight'
import { clearReadCache, dedupedRead, retryRead } from '../src/guardian/retry'
import { guardianPhase } from '../src/guardian/state'
import { AppError } from '../src/lib/errors'
import { buildSendPlan, type TxPlan } from '../src/lib/plan'

const ME = '0x2222222222222222222222222222222222222222' as Address
const THEM = '0x1111111111111111111111111111111111111111' as Address
const ONE = 1_000_000n
const FEE = 5_000n
const noWait = async () => undefined

function reads(overrides: Partial<PreflightReads> = {}): PreflightReads & { calls: string[] } {
  const calls: string[] = []
  const base: PreflightReads = {
    usdcDecimals: async () => 6,
    usdcBalance: async () => 10n * ONE,
    erc20Allowance: async () => 0n,
    tokenBalance: async () => 10n * ONE,
    verifySwapProvider: async () => undefined,
    vaultBalance: async () => 10n * ONE,
    vaultPaused: async () => false,
    estimateFee: async () => ({ gas: 21_000n, feeUsdc: FEE }),
    simulate: async () => undefined,
    txCounts: async () => ({ latest: 4, pending: 4 }),
    receiptStatus: async () => 'pending',
    readReceipt: async () => undefined,
  }
  const wrapped = Object.fromEntries(
    Object.entries({ ...base, ...overrides }).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        calls.push(name)
        return (fn as (...a: unknown[]) => unknown)(...args)
      },
    ]),
  ) as unknown as PreflightReads
  return Object.assign(wrapped, { calls })
}

const send = (amount = ONE, to: Address = THEM): TxPlan => buildSendPlan(ME, to, amount)
const input = (plan: TxPlan, extra: { account?: Address | undefined; walletChainId?: number } = {}) => ({
  plan,
  account: 'account' in extra ? extra.account : ME,
  walletChainId: extra.walletChainId ?? ARC_CHAIN_ID,
})
const failing = (report: Awaited<ReturnType<typeof runPreflight>>) => report.checks.filter((check) => check.status === 'fail').map((check) => check.id)

beforeEach(() => {
  clearReadCache()
  window.localStorage.clear()
})

describe('guardian pre-flight: a normal transaction', () => {
  test('a valid send is ready, simulated, and leaves the amount and recipient untouched', async () => {
    const plan = send()
    const before = JSON.stringify({ amount: String(plan.amount), to: plan.to, call: plan.call, rows: plan.rows }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    const fake = reads()
    const report = await runPreflight(input(plan), fake)
    expect(report.verdict).toBe('ready')
    expect(report.simulated).toBe(true)
    expect(failing(report)).toEqual([])
    expect(fake.calls).toContain('simulate')
    const after = JSON.stringify({ amount: String(plan.amount), to: plan.to, call: plan.call, rows: plan.rows }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(after).toBe(before)
  })

  test('a send to your own wallet is allowed but flagged for review', async () => {
    const report = await runPreflight(input(send(ONE, ME)), reads())
    expect(report.verdict).toBe('review')
    expect(report.checks.find((check) => check.id === 'recipient')?.status).toBe('warn')
  })
})

describe('guardian pre-flight: blocked before the wallet', () => {
  test('insufficient USDC balance blocks and skips the simulation', async () => {
    const fake = reads({ usdcBalance: async () => ONE / 2n })
    const report = await runPreflight(input(send()), fake)
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toContain('balance')
    expect(report.reason).toContain('lower than this amount')
    expect(fake.calls).not.toContain('simulate')
    expect(report.simulated).toBe(false)
  })

  test('amount plus network fee above the one USDC pool is blocked as not enough gas', async () => {
    const report = await runPreflight(input(send(ONE)), reads({ usdcBalance: async () => ONE + FEE - 1n }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toEqual(['gas'])
    expect(report.reason).toContain('network fee')
  })

  test('no wallet and the wrong chain are blocked with plain reasons', async () => {
    const noWallet = await runPreflight(input(send(), { account: undefined }), reads())
    expect(noWallet.verdict).toBe('blocked')
    expect(failing(noWallet)).toContain('wallet')
    const wrongChain = await runPreflight(input(send(), { walletChainId: 1 }), reads())
    expect(wrongChain.verdict).toBe('blocked')
    expect(wrongChain.reason).toContain('Arc Mainnet')
  })

  test('an invalid recipient (zero address, USDC token) is blocked', async () => {
    const zero = await runPreflight(input(send(ONE, '0x0000000000000000000000000000000000000000')), reads())
    expect(failing(zero)).toContain('recipient')
    const token = await runPreflight(input(send(ONE, USDC.address)), reads())
    expect(failing(token)).toContain('recipient')
  })

  test('a simulation revert blocks, is decoded to plain words, and keeps the raw reason for details', async () => {
    const revert = new Error('execution reverted: ERC20: transfer amount exceeds balance')
    const report = await runPreflight(input(send()), reads({ simulate: async () => Promise.reject(revert) }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toEqual(['simulation'])
    expect(report.reason?.length).toBeGreaterThan(10)
    expect(report.technical).toContain('transfer amount exceeds balance')
    expect(report.simulated).toBe(false)
  })

  test('a fee estimate that reverts is the simulation result, not an RPC problem', async () => {
    const report = await runPreflight(input(send()), reads({ estimateFee: async () => Promise.reject(new Error('execution reverted')) }))
    expect(report.verdict).toBe('blocked')
    expect(report.rpcFailure).toBe(false)
    expect(failing(report)).toEqual(['simulation'])
  })
})

describe('guardian pre-flight: the network misbehaves', () => {
  test('an RPC timeout while reading the balance blocks as a retryable network problem, not a fake pass', async () => {
    const report = await runPreflight(input(send()), reads({ usdcBalance: async () => Promise.reject(new Error('The request timed out.')) }))
    expect(report.verdict).toBe('blocked')
    expect(report.rpcFailure).toBe(true)
    expect(report.reason).toContain('Nothing was sent')
    expect(guardianPhase({ flow: 'review', hasHash: false, view: { status: 'done', report } })).toBe('RPC_ERROR')
  })

  test('a rate limit while simulating blocks as a network problem', async () => {
    const report = await runPreflight(input(send()), reads({ simulate: async () => Promise.reject(new Error('429 Too Many Requests')) }))
    expect(report.verdict).toBe('blocked')
    expect(report.rpcFailure).toBe(true)
    expect(report.simulated).toBe(false)
  })
})

describe('guardian pre-flight: duplicates and pending transactions', () => {
  const HASH = `0x${'ab'.repeat(32)}` as Hex

  test('an identical transaction still pending onchain blocks a second one', async () => {
    const plan = send()
    const sub = beginSubmission(ME, { fingerprint: fingerprintOf(ME, plan), kind: 'send', title: plan.title })
    updateSubmission(ME, sub.id, { state: 'SUBMITTED', hash: HASH })
    const report = await runPreflight(input(plan), reads({ receiptStatus: async () => 'pending' }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toEqual(['duplicate'])
    expect(report.duplicateOf).toBe(HASH)
  })

  test('the earlier status is read first: a transaction that already finished never blocks a new one', async () => {
    const plan = send()
    const sub = beginSubmission(ME, { fingerprint: fingerprintOf(ME, plan), kind: 'send', title: plan.title })
    updateSubmission(ME, sub.id, { state: 'PENDING', hash: HASH })
    const fake = reads({ receiptStatus: async () => 'success' })
    const report = await runPreflight(input(plan), fake)
    expect(report.verdict).toBe('ready')
    expect(fake.calls).toContain('receiptStatus')
  })

  test('a reverted earlier transaction does not block a retry', async () => {
    const plan = send()
    const sub = beginSubmission(ME, { fingerprint: fingerprintOf(ME, plan), kind: 'send', title: plan.title })
    updateSubmission(ME, sub.id, { state: 'PENDING', hash: HASH })
    expect((await runPreflight(input(plan), reads({ receiptStatus: async () => 'reverted' }))).verdict).toBe('ready')
  })

  test('earlier pending transactions from the wallet are shown as a warning, not hidden', () => {
    expect(checkPending({ latest: 4, pending: 6 }).status).toBe('warn')
    expect(checkPending({ latest: 4, pending: 4 }).status).toBe('pass')
  })
})

describe('guardian checks: exact transaction data and token rules', () => {
  test('calldata that differs from the reviewed recipient or amount is blocked', () => {
    const plan = send()
    expect(checkCalldata(plan).status).toBe('pass')
    const otherRecipient = { ...plan, call: { ...plan.call, args: [ME, plan.amount] } } as TxPlan
    expect(checkCalldata(otherRecipient).status).toBe('fail')
    const otherAmount = { ...plan, call: { ...plan.call, args: [THEM, plan.amount + 1n] } } as TxPlan
    expect(checkCalldata(otherAmount).status).toBe('fail')
    const unknownFn = { ...plan, call: { ...plan.call, functionName: 'transferFrom' } } as TxPlan
    expect(checkCalldata(unknownFn).status).toBe('fail')
  })

  test('a call to an address that is not USDC or the vault is blocked', () => {
    const plan = send()
    expect(checkTarget(plan).status).toBe('pass')
    expect(checkTarget({ ...plan, call: { ...plan.call, address: THEM } } as TxPlan).status).toBe('fail')
    expect(checkTarget({ ...plan, call: { type: 'raw', to: THEM, data: '0x', value: 0n } } as TxPlan).status).toBe('fail')
  })

  test('approvals: unlimited and wrong-spender approvals are blocked', () => {
    const approve = (spender: Address, amount: bigint, planAmount = amount): TxPlan =>
      ({ ...send(), kind: 'approve', amount: planAmount, to: undefined, call: { type: 'contract', address: USDC.address, abi: [], functionName: 'approve', args: [spender, amount] } }) as TxPlan
    expect(checkCalldata(approve(THEM, ONE)).status).toBe('fail')
    if (ARVEXA_ADDRESS) {
      expect(checkCalldata(approve(ARVEXA_ADDRESS, ONE)).status).toBe('pass')
      expect(checkCalldata(approve(ARVEXA_ADDRESS, maxUint256, ONE)).status).toBe('fail')
      expect(checkCalldata(approve(ARVEXA_ADDRESS, ONE, ONE + 1n)).status).toBe('fail')
    } else {
      // No vault is configured, so there is no spender the app would ever approve.
      expect(checkCalldata(approve(THEM, ONE)).id).toBe('approval')
    }
  })

  test('decimals: the token must report the 6 decimals the app assumes', () => {
    expect(checkDecimals(6).status).toBe('pass')
    expect(checkDecimals(18).status).toBe('fail')
    expect(checkDecimals(undefined).status).toBe('warn')
  })

  test('allowance rules for a top up and for an approval that is already in place', () => {
    const topUp = { ...send(), kind: 'deposit', call: { type: 'contract', address: USDC.address, abi: [], functionName: 'deposit', args: [ONE] } } as TxPlan
    expect(checkAllowance(topUp, ONE - 1n).status).toBe('fail')
    expect(checkAllowance(topUp, ONE).status).toBe('pass')
    const approve = { ...send(), kind: 'approve', call: { type: 'contract', address: USDC.address, abi: [], functionName: 'approve', args: [THEM, ONE] } } as TxPlan
    expect(checkAllowance(approve, 2n * ONE).status).toBe('warn')
    expect(checkAllowance(approve, 0n).status).toBe('pass')
  })

  test('balances and gas are compared in 6-decimal base units, once, from one pool', () => {
    const plan = send(ONE)
    expect(checkBalance(plan, ONE, undefined).status).toBe('pass')
    expect(checkBalance(plan, ONE - 1n, undefined).status).toBe('fail')
    expect(checkGas(plan, ONE + FEE, FEE).status).toBe('pass')
    expect(checkGas(plan, ONE + FEE - 1n, FEE).status).toBe('fail')
    expect(checkFeeVsAmount(send(100n), FEE).status).toBe('warn')
    expect(checkFeeVsAmount(send(ONE), FEE).status).toBe('pass')
  })

  test('vault pause, wrong chain and own-address recipient have their own results', () => {
    const topUp = { ...send(), kind: 'deposit', call: { type: 'contract', address: USDC.address, abi: [], functionName: 'deposit', args: [ONE] } } as TxPlan
    expect(checkPaused(topUp, true).status).toBe('fail')
    expect(checkPaused(topUp, false).status).toBe('pass')
    expect(checkChain(ARC_CHAIN_ID).status).toBe('pass')
    expect(checkChain(137).status).toBe('fail')
    expect(checkRecipientOf(send(ONE, ME), ME).status).toBe('warn')
  })
})

describe('guardian lock and submission registry', () => {
  test('a second submission is refused while one is held, and the same one is called a duplicate', () => {
    const lock = createTxLock()
    const first = lock.tryAcquire(ME, 'a')
    expect(first.ok).toBe(true)
    expect(lock.tryAcquire(ME, 'a')).toEqual({ ok: false, reason: 'duplicate' })
    expect(lock.tryAcquire(ME, 'b')).toEqual({ ok: false, reason: 'busy' })
    expect(lock.tryAcquire(THEM, 'a').ok).toBe(true)
    if (first.ok) {
      first.release()
      first.release()
    }
    expect(lock.isHeld(ME)).toBe(false)
    expect(lock.tryAcquire(ME, 'a').ok).toBe(true)
  })

  test('an unanswered wallet prompt stops counting after two minutes; a submitted one lasts much longer', () => {
    const t0 = 1_000_000
    const sub = beginSubmission(ME, { fingerprint: 'fp', kind: 'send', title: 't' }, t0)
    expect(findInFlightDuplicate(ME, 'fp', t0 + SIGNING_WINDOW_MS - 1)).toBeDefined()
    expect(findInFlightDuplicate(ME, 'fp', t0 + SIGNING_WINDOW_MS + 1)).toBeUndefined()
    updateSubmission(ME, sub.id, { state: 'SUBMITTED', hash: `0x${'cd'.repeat(32)}` }, t0)
    expect(findInFlightDuplicate(ME, 'fp', t0 + IN_FLIGHT_WINDOW_MS - 1)).toBeDefined()
    expect(findInFlightDuplicate(ME, 'fp', t0 + IN_FLIGHT_WINDOW_MS + 1)).toBeUndefined()
  })

  test('a rejected wallet request is forgotten, and a settled transaction no longer blocks', () => {
    const rejected = beginSubmission(ME, { fingerprint: 'r', kind: 'send', title: 't' })
    dropSubmission(ME, rejected.id)
    expect(findInFlightDuplicate(ME, 'r')).toBeUndefined()
    const done = beginSubmission(ME, { fingerprint: 'd', kind: 'send', title: 't' })
    updateSubmission(ME, done.id, { state: 'VERIFIED', hash: `0x${'ef'.repeat(32)}` })
    expect(findInFlightDuplicate(ME, 'd')).toBeUndefined()
  })
})

describe('safe read-only retry', () => {
  test('transient failures are retried with backoff, then succeed', async () => {
    let tries = 0
    const waits: number[] = []
    const value = await retryRead(
      async () => {
        tries += 1
        if (tries < 3) throw new Error('The request timed out.')
        return 42
      },
      { attempts: 3, wait: async (attempt) => void waits.push(attempt) },
    )
    expect(value).toBe(42)
    expect(tries).toBe(3)
    expect(waits).toEqual([1, 2])
  })

  test('a rate limit is flagged so the wait is longer, and the attempt count is capped', async () => {
    let tries = 0
    const flags: boolean[] = []
    await expect(
      retryRead(
        async () => {
          tries += 1
          throw new Error('429 too many requests')
        },
        { attempts: 3, wait: async (_attempt, limited) => void flags.push(limited) },
      ),
    ).rejects.toThrow()
    expect(tries).toBe(3)
    expect(flags).toEqual([true, true])
  })

  test('a wallet rejection or a revert is never retried', async () => {
    let tries = 0
    await expect(retryRead(async () => { tries += 1; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) }, { wait: noWait })).rejects.toThrow()
    await expect(retryRead(async () => { tries += 1; throw new AppError('reverted') }, { wait: noWait })).rejects.toThrow()
    expect(tries).toBe(2)
  })

  test('identical reads share one request, a failure is not cached, and fresh skips the cache', async () => {
    let calls = 0
    const read = async () => {
      calls += 1
      return calls
    }
    const [a, b] = await Promise.all([dedupedRead('k', 10_000, read), dedupedRead('k', 10_000, read)])
    expect([a, b]).toEqual([1, 1])
    expect(await dedupedRead('k', 10_000, read)).toBe(1)
    expect(await dedupedRead('k', 10_000, read, { fresh: true })).toBe(2)
    await expect(dedupedRead('bad', 10_000, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await dedupedRead('bad', 10_000, async () => 'ok')).toBe('ok')
  })
})

describe('guardian phase', () => {
  test('is derived from real facts only', () => {
    const idle = { status: 'idle' } as const
    expect(guardianPhase({ flow: 'review', hasHash: false, view: { status: 'checking' } })).toBe('VALIDATING')
    expect(guardianPhase({ flow: 'review', hasHash: false, view: idle, errorKind: 'user_rejected' })).toBe('USER_REJECTED')
    expect(guardianPhase({ flow: 'signing', hasHash: false, view: idle })).toBe('SIGNING')
    expect(guardianPhase({ flow: 'confirming', hasHash: true, view: idle })).toBe('PENDING')
    expect(guardianPhase({ flow: 'stalled', hasHash: true, view: idle, errorKind: 'rpc_timeout' })).toBe('TIMEOUT')
    expect(guardianPhase({ flow: 'failed', hasHash: true, view: idle, errorKind: 'reverted' })).toBe('REVERTED')
    expect(guardianPhase({ flow: 'failed', hasHash: true, view: idle, errorKind: 'unverified' })).toBe('VERIFICATION_FAILED')
    expect(guardianPhase({ flow: 'success', hasHash: true, view: idle })).toBe('VERIFIED')
  })
})
