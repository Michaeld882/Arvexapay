import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import type { GatewayFee, GatewayRecord } from '../src/circle/gateway'
import { loadGatewayChains, chainKey, type EvmChain } from '../src/circle/sdk'
import { GATEWAY_FEE_MESSAGE, checkGatewayRoute, gatewayFingerprint, gatewayGuardianPhase, gatewaySubmissionState, runGatewayPreflight, type GatewayPreflightInput, type GatewayReads } from '../src/guardian/gateway'
import { clearReadCache } from '../src/guardian/retry'
import { parseUsdc } from '../src/onchain-money'

const OWNER = '0x2222222222222222222222222222222222222222' as Address
const USDC6 = 1_000_000n
let arc: EvmChain
let chains: EvmChain[]
let ethereum: EvmChain

beforeAll(async () => {
  const loaded = await loadGatewayChains()
  arc = loaded.arc
  chains = loaded.chains
  ethereum = chains.find((chain) => chainKey(chain) === 'Ethereum') as EvmChain
})

beforeEach(() => clearReadCache())

const fees = (...items: Array<[string, string, string]>): GatewayFee[] => items.map(([type, token, amount]) => ({ type, token, amount }))

function reads(overrides: Partial<GatewayReads> = {}): GatewayReads {
  return {
    tokenDecimals: async () => 6,
    tokenBalance: async () => 100n * USDC6,
    nativeBalance: async () => 10n ** 16n,
    allowance: async () => 0n,
    txCounts: async () => ({ latest: 1, pending: 1 }),
    gatewayBalance: async () => 50n * USDC6,
    quote: async () => fees(['gasFee', 'ETH', '0.0002'], ['provider', 'USDC', '0.001']),
    ...overrides,
  }
}

const deposit = (amount: string, extra: Partial<GatewayPreflightInput> = {}): GatewayPreflightInput => ({ kind: 'deposit', owner: OWNER, chain: ethereum, arc, chains, amount, recipient: OWNER, ...extra })
const spend = (amount: string, extra: Partial<GatewayPreflightInput> = {}): GatewayPreflightInput => ({ kind: 'spend', owner: OWNER, chain: undefined, arc, chains, amount, recipient: OWNER, ...extra })
const failing = (report: { checks: Array<{ id: string; status: string }> }) => report.checks.filter((check) => check.status === 'fail').map((check) => check.id)

describe('gateway guardian: the route', () => {
  test('a listed chain and a forwarded spend to Arc pass the route checks', () => {
    expect(checkGatewayRoute(deposit('10')).filter((check) => check.status === 'fail')).toEqual([])
    expect(checkGatewayRoute(spend('10')).filter((check) => check.status === 'fail')).toEqual([])
  })

  test('an unlisted chain, a wrong Arc entry, a bad recipient and a bad amount are blocked', () => {
    const unlisted = { ...ethereum, chainId: 999_999 } as EvmChain
    expect(failing({ checks: checkGatewayRoute(deposit('10', { chain: unlisted })) })).toContain('route')
    const notArc = { ...arc, chainId: 1 } as EvmChain
    expect(failing({ checks: checkGatewayRoute(spend('10', { arc: notArc })) })).toContain('route')
    expect(failing({ checks: checkGatewayRoute(spend('10', { recipient: '0x0000000000000000000000000000000000000000' })) })).toContain('recipient')
    expect(failing({ checks: checkGatewayRoute(deposit('abc')) })).toContain('amount')
    expect(failing({ checks: checkGatewayRoute(deposit('10', { owner: undefined })) })).toContain('wallet')
  })

  test('forwarding that Circle no longer supports blocks a spend', () => {
    const noForwarder = { ...arc, gateway: { ...arc.gateway, forwarderSupported: { source: false, destination: false } } } as unknown as EvmChain
    expect(failing({ checks: checkGatewayRoute(spend('10', { arc: noForwarder })) })).toContain('route')
  })
})

describe('gateway guardian: top up', () => {
  test('a normal top up is ready and the amount and recipient are untouched', async () => {
    const input = deposit('10')
    const report = await runGatewayPreflight(input, reads())
    expect(report.verdict).toBe('ready')
    expect(input.amount).toBe('10')
    expect(input.recipient).toBe(OWNER)
  })

  test('not enough USDC, wrong decimals or not enough gas block it before the wallet', async () => {
    expect(failing(await runGatewayPreflight(deposit('10'), reads({ tokenBalance: async () => 9n * USDC6 })))).toContain('balance')
    expect(failing(await runGatewayPreflight(deposit('10'), reads({ tokenDecimals: async () => 18 })))).toContain('decimals')
    const noGas = await runGatewayPreflight(deposit('10'), reads({ nativeBalance: async () => 0n }))
    expect(noGas.verdict).toBe('blocked')
    expect(failing(noGas)).toContain('gas')
  })

  test('fees charged in USDC that reach the amount block it, with the plain message', async () => {
    const small = await runGatewayPreflight(deposit('0.01'), reads({ quote: async () => fees(['gasFee', 'ETH', '0.0002'], ['forwarder', 'USDC', '0.12']) }))
    expect(small.verdict).toBe('blocked')
    expect(failing(small)).toEqual(['fee'])
    expect(small.reason?.startsWith(GATEWAY_FEE_MESSAGE)).toBe(true)
    const equal = await runGatewayPreflight(deposit('0.12'), reads({ quote: async () => fees(['forwarder', 'USDC', '0.12']) }))
    expect(equal.verdict).toBe('blocked')
    const below = await runGatewayPreflight(deposit('0.120001'), reads({ quote: async () => fees(['forwarder', 'USDC', '0.12']) }))
    expect(below.verdict).toBe('ready')
  })

  test('a request that Circle rejects when estimating is blocked as a failed estimate (never called a simulation); a timeout is a network problem', async () => {
    const rejected = await runGatewayPreflight(deposit('10'), reads({ quote: async () => Promise.reject(new Error('execution reverted: deposit not allowed')) }))
    expect(rejected.verdict).toBe('blocked')
    expect(rejected.rpcFailure).toBe(false)
    expect(failing(rejected)).toContain('estimate')
    expect(failing(rejected)).not.toContain('simulation')
    expect(rejected.technical).toContain('deposit not allowed')
    const timeout = await runGatewayPreflight(deposit('10'), reads({ quote: async () => Promise.reject(new Error('The request timed out.')) }))
    expect(timeout.verdict).toBe('blocked')
    expect(timeout.rpcFailure).toBe(true)
  })

  test('a rate-limited balance read blocks as a retryable network problem, never as a pass', async () => {
    const report = await runGatewayPreflight(deposit('10'), reads({ tokenBalance: async () => Promise.reject(new Error('429 Too Many Requests')) }))
    expect(report.verdict).toBe('blocked')
    expect(report.rpcFailure).toBe(true)
  })
})

describe('gateway guardian: spend to Arc', () => {
  test('a spend within the Gateway balance is ready', async () => {
    const report = await runGatewayPreflight(spend('10'), reads({ quote: async () => fees(['provider', 'USDC', '0.002'], ['forwarder', 'USDC', '0.01']) }))
    expect(report.verdict).toBe('ready')
  })

  test('more than the Gateway balance, or fees at or above the amount, block it', async () => {
    expect(failing(await runGatewayPreflight(spend('60'), reads()))).toContain('balance')
    const tiny = await runGatewayPreflight(spend('0.000063'), reads({ quote: async () => fees(['provider', 'USDC', '0.002']) }))
    expect(tiny.verdict).toBe('blocked')
    expect(tiny.reason?.startsWith(GATEWAY_FEE_MESSAGE)).toBe(true)
  })

  test('amounts are compared as 6-decimal base units', async () => {
    expect(parseUsdc('0.000063')).toBe(63n)
    const exact = await runGatewayPreflight(spend('50'), reads({ gatewayBalance: async () => 50n * USDC6, quote: async () => fees(['provider', 'USDC', '0.001']) }))
    expect(exact.verdict).toBe('ready')
    const over = await runGatewayPreflight(spend('50.000001'), reads({ gatewayBalance: async () => 50n * USDC6 }))
    expect(failing(over)).toContain('balance')
  })
})

describe('gateway tracking', () => {
  const record = (extra: Partial<GatewayRecord> = {}): GatewayRecord => ({ id: 'a', createdAt: 1, owner: OWNER, kind: 'deposit', chainName: 'Ethereum', chainKey: 'Ethereum', amount: '10', state: 'pending', ...extra })

  test('pending, unconfirmed and verified are told apart from real facts only', () => {
    expect(gatewayGuardianPhase(record())).toBe('SIGNING')
    expect(gatewayGuardianPhase(record({ txHash: `0x${'12'.repeat(32)}` }))).toBe('PENDING')
    expect(gatewayGuardianPhase(record({ state: 'unconfirmed', txHash: `0x${'12'.repeat(32)}` }))).toBe('PENDING')
    // A confirmed receipt alone is CONFIRMED. VERIFIED needs the expected result read back (verified: true).
    expect(gatewayGuardianPhase(record({ state: 'success', txHash: `0x${'12'.repeat(32)}` }))).toBe('CONFIRMED')
    expect(gatewayGuardianPhase(record({ state: 'success', verified: false, txHash: `0x${'12'.repeat(32)}` }))).toBe('CONFIRMED')
    expect(gatewayGuardianPhase(record({ state: 'success', verified: true, txHash: `0x${'12'.repeat(32)}` }))).toBe('VERIFIED')
    expect(gatewayGuardianPhase(record({ state: 'error', error: 'You rejected the request in your wallet.' }))).toBe('USER_REJECTED')
    expect(gatewayGuardianPhase(record({ state: 'error', error: 'The deposit transaction reverted on Ethereum.', txHash: `0x${'12'.repeat(32)}` }))).toBe('REVERTED')
  })

  test('the registry forgets a request that never submitted and keeps one that did', () => {
    expect(gatewaySubmissionState(record({ state: 'error', error: 'You rejected the request in your wallet.' }))).toBe('DROP')
    expect(gatewaySubmissionState(record({ state: 'error', txHash: `0x${'12'.repeat(32)}` }))).toBe('PENDING')
    expect(gatewaySubmissionState(record({ state: 'unconfirmed', txHash: `0x${'12'.repeat(32)}` }))).toBe('PENDING')
    expect(gatewaySubmissionState(record({ state: 'success' }))).toBe('CONFIRMED')
    expect(gatewaySubmissionState(record({ state: 'success', verified: true }))).toBe('VERIFIED')
    expect(gatewayFingerprint({ owner: OWNER, kind: 'spend', amount: '1' })).toBe(`gateway:${OWNER.toLowerCase()}:spend:arc:1`)
  })
})
