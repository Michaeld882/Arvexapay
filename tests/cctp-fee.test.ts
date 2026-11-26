import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { CctpFeeError, assertBurnFeeCovered, estimateTransfer, findUnsettledDuplicate, isResumable, newTransferRecord, recoveryAdvice, runTransfer, type KitLike, type TransferRecord } from '../src/circle/cctp'
import { FEE_TOO_SMALL_MESSAGE, checkBurnFee, maxFeeFromQuote } from '../src/circle/cctpFee'
import { describeCircleError } from '../src/circle/errors'
import { parseUsdc } from '../src/onchain-money'

/**
 * These tests drive the real CCTP fee and transfer logic with a stand-in for the Circle kit, so no wallet, network or
 * signature is involved. The stand-in never invents a transaction hash and never reports a finished transfer.
 */

const OWNER = '0x2222222222222222222222222222222222222222' as Address
const ARBITRUM = { chain: 'Arbitrum', name: 'Arbitrum', chainId: 42161, explorerUrl: 'https://arbiscan.io/tx/{hash}' } as never
const ADAPTER = {} as never
const REVERT = 'Simulation failed on Arbitrum: Max fee must be less than amount'

interface FeeItem {
  type: string
  amount: string | null
}

function quoteKit(fees: FeeItem[], calls: { bridge: number } = { bridge: 0 }): KitLike {
  return {
    estimateBridge: async () => ({ gasFees: [], fees: fees.map((fee) => ({ token: 'USDC', ...fee })) }),
    bridge: async () => {
      calls.bridge += 1
      throw new Error('bridge must not be reached')
    },
    retryBridge: async () => {
      throw new Error('not used')
    },
    on: () => undefined,
    off: () => undefined,
  } as unknown as KitLike
}

const route = (amount: string, kit: KitLike, useForwarder = true) => ({ adapter: ADAPTER, source: ARBITRUM, amount, recipient: OWNER, speed: 'FAST' as const, useForwarder, kit })

describe('CCTP burn fee check', () => {
  test('a normal transfer: the fee is far below the amount', () => {
    const maxFee = maxFeeFromQuote([{ type: 'provider', amount: '0.00143' }])
    expect(maxFee).toBe(1_430n)
    expect(checkBurnFee(parseUsdc('10'), maxFee)).toEqual({ ok: true, maxFee })
  })

  test('a very small amount cannot cover the forwarding fee, and says so before any signature', () => {
    const maxFee = maxFeeFromQuote([{ type: 'provider', amount: '0.000007' }, { type: 'forwarder', amount: '0.2' }])
    const check = checkBurnFee(parseUsdc('0.000063'), maxFee)
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.message.startsWith(FEE_TOO_SMALL_MESSAGE)).toBe(true)
      expect(check.message).toContain('0.200007 USDC')
    }
  })

  test('maxFee equal to or above the amount is refused; one base unit below is accepted', () => {
    const amount = parseUsdc('0.5')
    expect(checkBurnFee(amount, amount).ok).toBe(false)
    expect(checkBurnFee(amount, amount + 1n).ok).toBe(false)
    expect(checkBurnFee(amount, amount - 1n).ok).toBe(true)
  })

  test('amounts and fees are compared as 6-decimal base units, never as human text', () => {
    expect(parseUsdc('0.000063')).toBe(63n)
    expect(parseUsdc('1')).toBe(1_000_000n)
    // "0.5" and "10" as text would sort the wrong way; as base units 0.5 USDC is below 1 USDC.
    expect(checkBurnFee(parseUsdc('1'), parseUsdc('0.5')).ok).toBe(true)
    expect(checkBurnFee(parseUsdc('0.5'), parseUsdc('1')).ok).toBe(false)
    // Only the protocol and forwarding fees are part of maxFee; a separate service fee is not.
    expect(maxFeeFromQuote([{ type: 'provider', amount: '0.000001' }, { type: 'forwarder', amount: '0.1' }, { type: 'kit', amount: '5' }])).toBe(100_001n)
  })

  test('the contract revert is shown as an instruction, not as a raw simulation error', () => {
    expect(describeCircleError(new Error(REVERT))).toBe(FEE_TOO_SMALL_MESSAGE)
  })
})

describe('checking the fee before the wallet is involved', () => {
  test('the quote carries the exact maxFee the burn will use, for the amount it was quoted for', async () => {
    const estimate = await estimateTransfer(route('1', quoteKit([{ type: 'provider', amount: '0.00014' }, { type: 'forwarder', amount: '0.2' }])))
    expect(estimate.amount).toBe('1')
    expect(estimate.maxFee).toBe(200_140n)
  })

  test('a normal amount passes', async () => {
    const maxFee = await assertBurnFeeCovered(route('5', quoteKit([{ type: 'provider', amount: '0.0007' }, { type: 'forwarder', amount: '0.2' }])))
    expect(maxFee).toBe(200_700n)
  })

  test('0.000063 USDC is stopped before the burn is ever attempted', async () => {
    const calls = { bridge: 0 }
    const kit = quoteKit([{ type: 'provider', amount: '0.000007' }, { type: 'forwarder', amount: '0.2' }], calls)
    const error = await assertBurnFeeCovered(route('0.000063', kit)).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(CctpFeeError)
    expect((error as CctpFeeError).kind).toBe('too-small')
    expect((error as CctpFeeError).message.startsWith(FEE_TOO_SMALL_MESSAGE)).toBe(true)
    expect(calls.bridge).toBe(0)
  })

  test('when Circle cannot quote a fee the burn is not attempted either', async () => {
    const error = await assertBurnFeeCovered(route('1', quoteKit([{ type: 'provider', amount: null }]))).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(CctpFeeError)
    expect((error as CctpFeeError).kind).toBe('unavailable')
  })
})

describe('a transfer whose burn fails', () => {
  const approveDoneBurnFailed = {
    state: 'error',
    steps: [
      { name: 'approve', state: 'success' },
      { name: 'burn', state: 'error', errorMessage: REVERT },
    ],
  }

  async function run(kit: KitLike, amount = '0.000063'): Promise<{ record: TransferRecord; updates: TransferRecord[] }> {
    const record = newTransferRecord({ owner: OWNER, source: ARBITRUM, amount, recipient: OWNER, speed: 'FAST', useForwarder: true })
    const updates: TransferRecord[] = []
    const done = await runTransfer({ record, source: ARBITRUM, adapter: ADAPTER, onUpdate: (next) => updates.push(next), kit })
    return { record: done, updates }
  }

  function bridgeKit(outcome: () => Promise<unknown>, calls = { bridge: 0 }): KitLike {
    return {
      bridge: async () => {
        calls.bridge += 1
        return outcome()
      },
      estimateBridge: async () => ({ gasFees: [], fees: [] }),
      retryBridge: async () => outcome(),
      on: () => undefined,
      off: () => undefined,
    } as unknown as KitLike
  }

  test('approval succeeded, then the burn simulation failed: stopped, never successful, nothing burned', async () => {
    const { record, updates } = await run(bridgeKit(async () => approveDoneBurnFailed))
    expect(record.state).toBe('error')
    expect(record.steps.find((step) => step.name === 'approve')?.state).toBe('success')
    expect(record.steps.find((step) => step.name === 'burn')?.state).toBe('error')
    expect(record.steps.find((step) => step.name === 'burn')?.message).toBe(FEE_TOO_SMALL_MESSAGE)
    expect(record.error).toBe(FEE_TOO_SMALL_MESSAGE)
    expect(record.mintHash).toBeUndefined()
    expect(updates.some((item) => item.state === 'success' || item.state === 'confirming')).toBe(false)
    expect(isResumable(record)).toBe(false)
    expect(recoveryAdvice(record, false)?.body).toContain('No USDC was burned')
  })

  test('a thrown simulation failure ends as an error with the same plain message', async () => {
    const { record } = await run(bridgeKit(async () => Promise.reject(new Error(REVERT))))
    expect(record.state).toBe('error')
    expect(record.error).toBe(FEE_TOO_SMALL_MESSAGE)
    expect(record.steps.some((step) => step.state === 'success')).toBe(false)
    expect(record.steps.some((step) => step.state === 'active')).toBe(false)
  })

  test('after a failed burn a new transfer can start: no duplicate block and no stuck state', async () => {
    const calls = { bridge: 0 }
    const first = await run(bridgeKit(async () => approveDoneBurnFailed, calls))
    // Nothing was burned, so the duplicate guard does not block the same amount again.
    expect(findUnsettledDuplicate([first.record], { sourceChain: 'Arbitrum', amount: '0.000063' })).toBeUndefined()

    // The second attempt is its own record and runs on its own. It reaches the burn this time.
    const second = await run(
      bridgeKit(async () => ({
        state: 'error',
        steps: [
          { name: 'approve', state: 'success' },
          { name: 'burn', state: 'success' },
          { name: 'fetchAttestation', state: 'error', errorMessage: 'Attestation timed out.' },
        ],
      }), calls),
    )
    expect(calls.bridge).toBe(2)
    expect(second.record.id).not.toBe(first.record.id)
    expect(second.record.steps.find((step) => step.name === 'burn')?.state).toBe('success')
    expect(second.record.state).toBe('error')
    expect(second.record.mintHash).toBeUndefined()
    // The first record keeps its failed state.
    expect(first.record.state).toBe('error')
    expect(first.record.steps.find((step) => step.name === 'burn')?.state).toBe('error')
  })
})
