import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { cctpFingerprint, cctpGuardianPhase, cctpSubmissionState, checkCctpRoute, runCctpPreflight, type CctpPreflightInput, type CctpReads } from '../src/guardian/cctp'
import { clearReadCache } from '../src/guardian/retry'
import { FEE_TOO_SMALL_MESSAGE } from '../src/circle/cctpFee'
import { newTransferRecord, retryTransfer, runTransfer, type KitLike, type TransferEstimate, type TransferRecord } from '../src/circle/cctp'
import { chainKey, loadCctpChains, type EvmChain } from '../src/circle/sdk'
import { parseUsdc } from '../src/onchain-money'

const OWNER = '0x2222222222222222222222222222222222222222' as Address
let arbitrum: EvmChain
let arc: EvmChain

beforeAll(async () => {
  const chains = await loadCctpChains()
  arbitrum = chains.sources.find((chain) => chainKey(chain) === 'Arbitrum') as EvmChain
  arc = chains.destination
})

beforeEach(() => {
  clearReadCache()
  window.localStorage.clear()
})

const ETH = 10n ** 18n

function quote(amount: string, fees: Array<{ type: string; amount: string }>, extra: Partial<TransferEstimate> = {}): TransferEstimate {
  const lines = fees.map((fee) => ({ label: fee.type, token: 'USDC', ...fee }))
  const maxFee = fees.filter((fee) => fee.type === 'provider' || fee.type === 'forwarder').reduce((sum, fee) => sum + parseUsdc(fee.amount), 0n)
  return { amount, fees: lines, maxFee, gas: [{ label: 'Network fee (approve)', token: 'ETH', amount: '0.00001' }, { label: 'Network fee (burn)', token: 'ETH', amount: '0.00004' }], gasErrors: [], ...extra }
}

function reads(overrides: Partial<CctpReads> & { estimate?: TransferEstimate } = {}): CctpReads {
  const { estimate, ...rest } = overrides
  return {
    tokenDecimals: async () => 6,
    tokenBalance: async () => 100n * 1_000_000n,
    nativeBalance: async () => ETH / 100n,
    allowance: async () => 0n,
    txCounts: async () => ({ latest: 3, pending: 3 }),
    arcBalance: async () => 5n * 1_000_000n,
    quote: async () => estimate ?? quote('10', [{ type: 'provider', amount: '0.0007' }, { type: 'forwarder', amount: '0.017379' }]),
    ...rest,
  }
}

const route = (amount: string, extra: Partial<CctpPreflightInput> = {}): CctpPreflightInput => ({ owner: OWNER, source: arbitrum, destination: arc, amount, recipient: OWNER, speed: 'FAST', useForwarder: true, ...extra })
const failing = (report: { checks: Array<{ id: string; status: string }> }) => report.checks.filter((check) => check.status === 'fail').map((check) => check.id)

describe('cctp guardian: the route', () => {
  test('a supported source to Arc passes the route, token and recipient checks', () => {
    const checks = checkCctpRoute(route('10'))
    expect(checks.filter((check) => check.status === 'fail')).toEqual([])
    expect(checks.find((check) => check.id === 'route')?.message).toContain('domain')
  })

  test('a wrong destination, a missing domain or no forwarding support is blocked', () => {
    expect(failing({ checks: checkCctpRoute(route('10', { destination: arbitrum })) })).toContain('route')
    const noDomain = { ...arbitrum, cctp: undefined } as unknown as EvmChain
    expect(failing({ checks: checkCctpRoute(route('10', { source: noDomain })) })).toContain('route')
    const noForwarder = { ...arc, cctp: { ...arc.cctp, forwarderSupported: { source: false, destination: false } } } as unknown as EvmChain
    expect(failing({ checks: checkCctpRoute(route('10', { destination: noForwarder })) })).toContain('route')
    expect(failing({ checks: checkCctpRoute(route('10', { destination: noForwarder, useForwarder: false })) })).not.toContain('route')
  })

  test('an invalid recipient, a token contract recipient and a bad amount are blocked', () => {
    expect(failing({ checks: checkCctpRoute(route('10', { recipient: '0x0000000000000000000000000000000000000000' })) })).toContain('recipient')
    expect(failing({ checks: checkCctpRoute(route('10', { recipient: arbitrum.usdcAddress as Address })) })).toContain('recipient')
    expect(failing({ checks: checkCctpRoute(route('0.0000001')) })).toContain('amount')
    expect(failing({ checks: checkCctpRoute(route('0')) })).toContain('amount')
    expect(failing({ checks: checkCctpRoute(route('10', { owner: undefined })) })).toContain('wallet')
  })
})

describe('cctp guardian: the fee against the amount (Max fee must be less than amount)', () => {
  test('a normal transfer is ready, and the amount and recipient are never changed', async () => {
    const input = route('10')
    const { report } = await runCctpPreflight(input, reads())
    expect(report.verdict).toBe('ready')
    expect(report.simulated).toBe(true)
    expect(input.amount).toBe('10')
    expect(input.recipient).toBe(OWNER)
  })

  test('0.000063 USDC cannot cover the forwarding fee: blocked before any wallet prompt, with the plain message', async () => {
    const { report } = await runCctpPreflight(route('0.000063'), reads({ estimate: quote('0.000063', [{ type: 'provider', amount: '0.000001' }, { type: 'forwarder', amount: '0.017379' }]) }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toEqual(['fee'])
    expect(report.reason?.startsWith(FEE_TOO_SMALL_MESSAGE)).toBe(true)
    expect(report.technical).toContain('6-decimal base units')
    expect(report.rpcFailure).toBe(false)
  })

  test('maxFee equal to the amount is blocked; one base unit below is allowed', async () => {
    const equal = await runCctpPreflight(route('0.5'), reads({ estimate: quote('0.5', [{ type: 'provider', amount: '0.5' }]) }))
    expect(equal.report.verdict).toBe('blocked')
    const above = await runCctpPreflight(route('0.5'), reads({ estimate: quote('0.5', [{ type: 'provider', amount: '0.500001' }]) }))
    expect(above.report.verdict).toBe('blocked')
    const below = await runCctpPreflight(route('0.5'), reads({ estimate: quote('0.5', [{ type: 'provider', amount: '0.499999' }]) }))
    expect(below.report.verdict).toBe('ready')
  })

  test('a quote made for a different amount is never used', async () => {
    const { report } = await runCctpPreflight(route('10'), reads({ estimate: quote('1', [{ type: 'provider', amount: '0.0001' }]) }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toEqual(['fee'])
  })
})

describe('cctp guardian: balance, gas and simulation', () => {
  test('not enough USDC or not enough gas on the source chain is blocked', async () => {
    const lowUsdc = await runCctpPreflight(route('10'), reads({ tokenBalance: async () => parseUsdc('9.99') }))
    expect(lowUsdc.report.verdict).toBe('blocked')
    expect(failing(lowUsdc.report)).toContain('balance')
    const noGas = await runCctpPreflight(route('10'), reads({ nativeBalance: async () => 0n }))
    expect(noGas.report.verdict).toBe('blocked')
    expect(failing(noGas.report)).toContain('gas')
    expect(noGas.report.reason).toContain('ETH')
  })

  test('wrong token decimals block the transfer', async () => {
    const { report } = await runCctpPreflight(route('10'), reads({ tokenDecimals: async () => 18 }))
    expect(failing(report)).toContain('decimals')
  })

  test('a failed burn simulation blocks when the approval already covers the amount', async () => {
    const failed = quote('10', [{ type: 'provider', amount: '0.0007' }], { gasErrors: [{ name: 'Burn', error: new Error('execution reverted: Burn token not supported') }] })
    const { report } = await runCctpPreflight(route('10', { useForwarder: false }), reads({ estimate: failed, allowance: async () => parseUsdc('10') }))
    expect(report.verdict).toBe('blocked')
    expect(failing(report)).toEqual(['simulation'])
    expect(report.technical).toContain('Burn token not supported')
  })

  test('before the approval exists the burn cannot be simulated: that is stated, not guessed as a pass or a failure', async () => {
    const failed = quote('10', [{ type: 'provider', amount: '0.0007' }], { gasErrors: [{ name: 'Burn', error: new Error('insufficient allowance') }] })
    const { report } = await runCctpPreflight(route('10', { useForwarder: false }), reads({ estimate: failed, allowance: async () => 0n }))
    expect(report.verdict).not.toBe('blocked')
    expect(report.simulated).toBe(false)
    expect(report.checks.find((check) => check.id === 'simulation')?.status).toBe('skipped')
  })

  test('an unforwarded mint without Arc USDC is flagged, not hidden', async () => {
    const withMint = quote('10', [{ type: 'provider', amount: '0.0007' }], { gas: [{ label: 'Network fee (approve)', token: 'ETH', amount: '0.00001' }, { label: 'Network fee (mint)', token: 'USDC', amount: '0.02' }] })
    const { report } = await runCctpPreflight(route('10', { useForwarder: false }), reads({ estimate: withMint, arcBalance: async () => 0n }))
    expect(report.verdict).toBe('review')
    expect(report.checks.find((check) => check.id === 'mint-gas')?.status).toBe('warn')
  })
})

describe('cctp guardian: the network misbehaves', () => {
  test('a timeout or rate limit while quoting blocks as a retryable network problem', async () => {
    const timeout = await runCctpPreflight(route('10'), reads({ quote: async () => Promise.reject(new Error('The request timed out.')) }))
    expect(timeout.report.verdict).toBe('blocked')
    expect(timeout.report.rpcFailure).toBe(true)
    const limited = await runCctpPreflight(route('10'), reads({ tokenBalance: async () => Promise.reject(new Error('429 Too Many Requests')) }))
    expect(limited.report.verdict).toBe('blocked')
    expect(limited.report.rpcFailure).toBe(true)
  })

  test('a quote that Circle rejects is a block with its reason, not a network retry', async () => {
    const { report } = await runCctpPreflight(route('10'), reads({ quote: async () => Promise.reject(new Error('Unsupported route')) }))
    expect(report.verdict).toBe('blocked')
    expect(report.rpcFailure).toBe(false)
    expect(failing(report)).toContain('quote')
    expect(failing(report)).not.toContain('simulation')
  })
})

describe('cctp transfers tracked by the Guardian', () => {
  function kitWith(bridge: (emit: (payload: unknown) => void) => Promise<unknown>, calls = { bridge: 0, retry: 0 }): KitLike {
    let handler: ((payload: unknown) => void) | undefined
    return {
      on: (_event: string, fn: (payload: unknown) => void) => {
        handler = fn
      },
      off: () => {
        handler = undefined
      },
      bridge: async () => {
        calls.bridge += 1
        return bridge((payload) => handler?.(payload))
      },
      retryBridge: async () => {
        calls.retry += 1
        return bridge((payload) => handler?.(payload))
      },
      estimateBridge: async () => ({ gasFees: [], fees: [] }),
    } as unknown as KitLike
  }
  const newRecord = () => newTransferRecord({ owner: OWNER, source: arbitrum, amount: '10', recipient: OWNER, speed: 'FAST', useForwarder: true })
  const state = (record: TransferRecord, name: string) => record.steps.find((step) => step.name === name)?.state

  test('a burn that confirms and an attestation that is still pending is monitored, never completed', async () => {
    const updates: TransferRecord[] = []
    const kit = kitWith(async (emit) => {
      emit({ method: 'approve', values: { state: 'success' } })
      emit({ method: 'burn', values: { state: 'success' } })
      return { state: 'pending', steps: [{ name: 'approve', state: 'success' }, { name: 'burn', state: 'success' }, { name: 'fetchAttestation', state: 'pending' }] }
    })
    const record = newRecord()
    const done = await runTransfer({ record, source: arbitrum, adapter: {} as never, onUpdate: (next) => updates.push(next), kit })
    expect(state(done, 'burn')).toBe('success')
    expect(state(done, 'fetchAttestation')).toBe('active')
    expect(done.state).toBe('pending')
    expect(cctpGuardianPhase(done)).toBe('PENDING')
    expect(cctpSubmissionState(done)).toBe('PENDING')
    expect(updates.some((item) => item.state === 'success')).toBe(false)
  })

  test('the kit reporting the mint done is verification pending until Arc shows it', async () => {
    const kit = kitWith(async () => ({ state: 'success', steps: ['approve', 'burn', 'fetchAttestation', 'mint'].map((name) => ({ name, state: 'success' })) }))
    const done = await runTransfer({ record: newRecord(), source: arbitrum, adapter: {} as never, onUpdate: () => undefined, kit })
    expect(done.state).toBe('unconfirmed')
    expect(done.mintHash).toBeUndefined()
    expect(cctpGuardianPhase(done)).toBe('PENDING')
  }, 60_000)

  test('a failed burn simulation after a good approval is a stopped transfer that drops out of the registry', async () => {
    const kit = kitWith(async () => ({
      state: 'error',
      steps: [{ name: 'approve', state: 'success' }, { name: 'burn', state: 'error', errorMessage: 'Simulation failed on Arbitrum: Max fee must be less than amount' }],
    }))
    const done = await runTransfer({ record: newRecord(), source: arbitrum, adapter: {} as never, onUpdate: () => undefined, kit })
    expect(done.state).toBe('error')
    expect(cctpGuardianPhase(done)).toBe('SIMULATION_FAILED')
    expect(cctpSubmissionState(done)).toBe('DROP')
  })

  test('resuming a burned transfer calls the resume path only: it never burns a second time', async () => {
    const calls = { bridge: 0, retry: 0 }
    const first = kitWith(async () => ({ state: 'error', steps: [{ name: 'approve', state: 'success' }, { name: 'burn', state: 'success' }, { name: 'fetchAttestation', state: 'error', errorMessage: 'Attestation timed out.' }] }), calls)
    const stopped = await runTransfer({ record: newRecord(), source: arbitrum, adapter: {} as never, onUpdate: () => undefined, kit: first })
    expect(cctpSubmissionState(stopped)).toBe('PENDING')
    expect(stopped.result).toBeDefined()
    const resumed = kitWith(async () => ({ state: 'pending', steps: [{ name: 'approve', state: 'success' }, { name: 'burn', state: 'success' }, { name: 'fetchAttestation', state: 'pending' }] }), calls)
    const next = await retryTransfer({ record: stopped, adapter: {} as never, onUpdate: () => undefined, kit: resumed })
    expect(calls.bridge).toBe(1)
    expect(calls.retry).toBe(1)
    expect(state(next, 'burn')).toBe('success')
  })

  test('phase and fingerprint helpers describe real state only', () => {
    const record = newRecord()
    expect(cctpGuardianPhase(record)).toBe('SIGNING')
    expect(cctpFingerprint(record)).toBe(`cctp:${OWNER.toLowerCase()}:Arbitrum:10:${OWNER.toLowerCase()}:FAST:true`)
    expect(cctpGuardianPhase({ ...record, state: 'error', error: 'You rejected the request in your wallet.' })).toBe('USER_REJECTED')
    // Success without the Arc mint hash is only CONFIRMED; the hash is what makes it VERIFIED.
    expect(cctpGuardianPhase({ ...record, state: 'success' })).toBe('CONFIRMED')
    expect(cctpGuardianPhase({ ...record, state: 'success', mintHash: `0x${'34'.repeat(32)}` })).toBe('VERIFIED')
  })
})
