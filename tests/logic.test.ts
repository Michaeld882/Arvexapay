import { describe, expect, test } from 'bun:test'
import { HttpRequestError, TimeoutError, UserRejectedRequestError } from 'viem'
import { USDC } from '../src/chain'
import { backoffDelay } from '../src/lib/backoff'
import { AppError, classifyError, isTransientError } from '../src/lib/errors'
import { formatUsdcDisplay } from '../src/lib/format'
import { MAX_READ_RETRIES, shouldRetryRead } from '../src/lib/queryClient'
import { checkAmount, checkRecipient } from '../src/lib/validate'

const VALID = '0x1111111111111111111111111111111111111111'

describe('amount validation', () => {
  test('rejects empty, zero, negative, junk and too many decimals', () => {
    expect(checkAmount('').ok).toBe(false)
    expect(checkAmount('0').ok).toBe(false)
    expect(checkAmount('0.000000').ok).toBe(false)
    expect(checkAmount('-5').ok).toBe(false)
    expect(checkAmount('.').ok).toBe(false)
    expect(checkAmount('1e6').ok).toBe(false)
    expect(checkAmount('1.0000001').ok).toBe(false)
  })
  test('parses valid amounts into 6-decimal base units', () => {
    expect(checkAmount('1')).toEqual({ ok: true, raw: 1_000_000n })
    expect(checkAmount('0.000001')).toEqual({ ok: true, raw: 1n })
    expect(checkAmount('12.5')).toEqual({ ok: true, raw: 12_500_000n })
  })
})

describe('recipient validation', () => {
  test('rejects invalid, zero-address, bad-checksum and USDC contract addresses', () => {
    expect(checkRecipient('').ok).toBe(false)
    expect(checkRecipient('0x123').ok).toBe(false)
    expect(checkRecipient('not an address').ok).toBe(false)
    expect(checkRecipient('0x0000000000000000000000000000000000000000').ok).toBe(false)
    expect(checkRecipient(USDC.address).ok).toBe(false)
    // mixed case that is not a valid EIP-55 checksum must be rejected
    expect(checkRecipient('0xAbCdEf0000000000000000000000000000000000').ok).toBe(false)
  })
  test('accepts a valid address', () => {
    const result = checkRecipient(VALID)
    expect(result.ok).toBe(true)
  })
})

describe('usdc display', () => {
  test('truncates, never rounds up, and groups thousands', () => {
    expect(formatUsdcDisplay(0n)).toBe('0.00')
    expect(formatUsdcDisplay(1_500_000n)).toBe('1.50')
    expect(formatUsdcDisplay(1_234_567_890_000n)).toBe('1,234,567.89')
    expect(formatUsdcDisplay(1n)).toBe('0.000001')
    expect(formatUsdcDisplay(999_999n)).toBe('0.999999')
    expect(formatUsdcDisplay(5_000n)).toBe('0.005') // a small real balance is never shown as 0.00
    expect(formatUsdcDisplay(52_626n)).toBe('0.052626')
  })
})

describe('error classification', () => {
  test('wallet rejection is classified and is not transient', () => {
    const err = classifyError(new UserRejectedRequestError(new Error('no')))
    expect(err.kind).toBe('user_rejected')
    expect(isTransientError(err)).toBe(false)
  })
  test('timeouts, HTTP failures and 429s are transient', () => {
    expect(classifyError(new TimeoutError({ body: {}, url: 'https://x' })).kind).toBe('rpc_timeout')
    expect(classifyError(new HttpRequestError({ url: 'https://x', status: 503 })).kind).toBe('rpc_unavailable')
    expect(classifyError(new Error('HTTP 429 Too Many Requests')).kind).toBe('rpc_rate_limited')
    expect(isTransientError(new Error('Failed to fetch'))).toBe(true)
  })
  test('reverts and unknown errors are not transient and never expose raw text as the message', () => {
    const reverted = classifyError(new Error('execution reverted: ERC20: transfer amount exceeds balance'))
    expect(reverted.kind).toBe('insufficient_usdc')
    expect(isTransientError(reverted)).toBe(false)
    const unknown = classifyError(new Error('weird internal failure 0xdeadbeef'))
    expect(unknown.kind).toBe('unknown')
    expect(unknown.message).not.toContain('0xdeadbeef')
    expect(unknown.detail).toContain('0xdeadbeef')
    expect(classifyError(new AppError('unverified')).kind).toBe('unverified')
  })
})

describe('retry and backoff', () => {
  test('backoff grows exponentially, is capped at 8s plus jitter, and stays jittered', () => {
    const mid = () => 0.5
    expect(backoffDelay(0, mid)).toBe(500)
    expect(backoffDelay(1, mid)).toBe(1000)
    expect(backoffDelay(2, mid)).toBe(2000)
    expect(backoffDelay(10, mid)).toBe(8000)
    expect(backoffDelay(3, () => 0)).toBe(Math.round(4000 * 0.75))
    expect(backoffDelay(3, () => 1)).toBe(Math.round(4000 * 1.25))
  })
  test('reads retry only transient failures, and only a bounded number of times', () => {
    const transient = new Error('Failed to fetch')
    const revert = new Error('execution reverted')
    expect(shouldRetryRead(0, transient)).toBe(true)
    expect(shouldRetryRead(MAX_READ_RETRIES - 1, transient)).toBe(true)
    expect(shouldRetryRead(MAX_READ_RETRIES, transient)).toBe(false)
    expect(shouldRetryRead(0, revert)).toBe(false)
    expect(shouldRetryRead(0, new UserRejectedRequestError(new Error('x')))).toBe(false)
  })
})
