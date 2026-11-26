import { beforeEach, describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { USDC } from '../src/chain'
import { expectationsFor, type Expectation } from '../src/guardian/expect'
import { buildSendPlan } from '../src/lib/plan'
import { newTransferRecord, type TransferRecord } from '../src/circle/cctp'
import type { GatewayRecord } from '../src/circle/gateway'
import { chainKey, loadCctpChains } from '../src/circle/sdk'
import { beginSubmission, inFlight, readSubmissions, updateSubmission } from '../src/guardian/lock'
import { INTERRUPTED_BEFORE_HASH, pendingSubmissions, recoverCctp, recoverGateway, recoverSubmissions, recoveryDelay } from '../src/guardian/recovery'

const OWNER = '0x2222222222222222222222222222222222222222' as Address
// A real Arc transaction (a USDC mint). Only its hash is used, to stand in for "something this wallet submitted".
const REAL_HASH = '0x003573a264975f93cfa0c1fbde09b31683574498232941b0bbb16a5b6896e7e8' as Hex

beforeEach(() => window.localStorage.clear())


// A stand-in for what the chain returns for a receipt. The logs are real encodings of the events the expectations name.
const RECIPIENT = '0x1111111111111111111111111111111111111111' as Address
const AMOUNT = 2_500_000n
const transferLog = (from: Address, to: Address, value: bigint) => ({
  address: USDC.address,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  blockNumber: 1n,
  blockHash: `0x${'00'.repeat(32)}`,
  logIndex: 0,
  transactionHash: REAL_HASH,
  transactionIndex: 0,
  removed: false,
})
const receipt = (status: 'success' | 'reverted', logs: ReturnType<typeof transferLog>[] = []) => ({ status, logs }) as unknown as TransactionReceipt
const sendExpectation = (): Expectation[] => [{ type: 'erc20-transfer', token: USDC.address, from: OWNER, to: RECIPIENT, value: AMOUNT.toString() }]

function stored(kind: string, expect: Expectation[] | undefined, state: 'SUBMITTED' | 'PENDING' = 'PENDING') {
  const item = beginSubmission(OWNER, { fingerprint: `fp-${kind}-${Math.random()}`, kind, title: `${kind} test`, expect })
  updateSubmission(OWNER, item.id, { state, hash: REAL_HASH })
  return item.id
}
const stateOf = (id: string) => readSubmissions(OWNER).find((item) => item.id === id)?.state

describe('recovery of direct transactions after a reload', () => {
  test('VERIFIED only when the receipt holds the expected transfer: right token, sender, recipient and amount', async () => {
    const id = stored('send', sendExpectation())
    const [result] = await recoverSubmissions(OWNER, { readReceipt: async () => receipt('success', [transferLog(OWNER, RECIPIENT, AMOUNT)]) })
    expect(result.outcome).toBe('verified')
    expect(stateOf(id)).toBe('VERIFIED')
  })

  test('a confirmed receipt with a different amount, recipient or sender is UNVERIFIED, never VERIFIED', async () => {
    for (const log of [transferLog(OWNER, RECIPIENT, AMOUNT - 1n), transferLog(OWNER, '0x3333333333333333333333333333333333333333', AMOUNT), transferLog('0x4444444444444444444444444444444444444444', RECIPIENT, AMOUNT)]) {
      window.localStorage.clear()
      const id = stored('send', sendExpectation())
      const [result] = await recoverSubmissions(OWNER, { readReceipt: async () => receipt('success', [log]) })
      expect(result.outcome).toBe('unverified')
      expect(result.missing).toEqual(['token transfer'])
      expect(stateOf(id)).toBe('UNVERIFIED')
    }
    window.localStorage.clear()
    const empty = stored('send', sendExpectation())
    await recoverSubmissions(OWNER, { readReceipt: async () => receipt('success') })
    expect(stateOf(empty)).toBe('UNVERIFIED')
  })

  test('a record with nothing to check against stays CONFIRMED: the chain confirmed it, nothing more is claimed', async () => {
    const withoutExpectation = stored('send', undefined)
    const empty = stored('send', [])
    const results = await recoverSubmissions(OWNER, { readReceipt: async () => receipt('success', [transferLog(OWNER, RECIPIENT, AMOUNT)]) })
    expect(results.every((item) => item.outcome === 'confirmed')).toBe(true)
    expect(stateOf(withoutExpectation)).toBe('CONFIRMED')
    expect(stateOf(empty)).toBe('CONFIRMED')
  })

  test('a revert becomes FAILED; a transaction that is not mined stays pending and keeps blocking duplicates', async () => {
    const reverted = stored('withdraw', sendExpectation(), 'SUBMITTED')
    const [failed] = await recoverSubmissions(OWNER, { readReceipt: async () => receipt('reverted') })
    expect(failed.outcome).toBe('failed')
    expect(stateOf(reverted)).toBe('FAILED')
    window.localStorage.clear()
    const waiting = stored('send', sendExpectation())
    const [pending] = await recoverSubmissions(OWNER, { readReceipt: async () => undefined })
    expect(pending.outcome).toBe('pending')
    expect(stateOf(waiting)).toBe('PENDING')
    expect(pendingSubmissions(OWNER).map((item) => item.id)).toEqual([waiting])
  })

  test('a failed read leaves the record exactly as it was and never marks anything', async () => {
    const id = stored('send', sendExpectation(), 'SUBMITTED')
    const [result] = await recoverSubmissions(OWNER, { readReceipt: async () => Promise.reject(new Error('The request timed out.')) })
    expect(result.outcome).toBe('unknown')
    expect(stateOf(id)).toBe('SUBMITTED')
  })

  test('expectations come from the plan itself: a send, an approval and a vault top up each name their own result', () => {
    const send = buildSendPlan(OWNER, RECIPIENT, AMOUNT)
    expect(expectationsFor(OWNER, send)).toEqual([{ type: 'erc20-transfer', token: USDC.address, from: OWNER, to: RECIPIENT, value: AMOUNT.toString() }])
    const items = expectationsFor(OWNER, { ...send, call: { type: 'contract', address: USDC.address, abi: erc20Abi, functionName: 'approve', args: [RECIPIENT, 5n] } })
    expect(items).toEqual([{ type: 'erc20-approval', token: USDC.address, owner: OWNER, spender: RECIPIENT, value: '5' }])
    expect(expectationsFor(OWNER, { ...send, call: { type: 'raw', to: RECIPIENT, data: '0x', value: 0n } })).toBeUndefined()
  })

  test('requests with no hash, and CCTP and Gateway records, are not touched here', async () => {
    const none = beginSubmission(OWNER, { fingerprint: 'fp-none', kind: 'send', title: 'send test' })
    updateSubmission(OWNER, none.id, { state: 'SUBMITTED' })
    stored('cctp', undefined)
    stored('gateway-deposit', undefined)
    let reads = 0
    const results = await recoverSubmissions(OWNER, { readReceipt: async () => (reads += 1, receipt('success')) })
    expect(results).toEqual([])
    expect(reads).toBe(0)
  })

  test('an old record that has aged out of the in-flight window no longer counts', () => {
    const id = stored('send', undefined)
    updateSubmission(OWNER, id, {}, Date.now() - 31 * 60_000)
    expect(inFlight(OWNER)).toEqual([])
  })
})

describe('recovery of Gateway operations', () => {
  const base: GatewayRecord = { id: 'g1', createdAt: 1, owner: OWNER, kind: 'deposit', chainName: 'Ethereum', chainKey: 'Ethereum', amount: '5', state: 'pending' }

  test('one with a hash is read back from its chain; one with none is closed honestly and never retried', async () => {
    const withHash: GatewayRecord = { ...base, id: 'g1', txHash: REAL_HASH }
    const noHash: GatewayRecord = { ...base, id: 'g2' }
    const finished: GatewayRecord = { ...base, id: 'g3', state: 'success', txHash: REAL_HASH }
    const rechecked: string[] = []
    const updated: GatewayRecord[] = []
    const out = await recoverGateway([withHash, noHash, finished], {
      recheck: async (record) => (rechecked.push(record.id), { ...record, state: 'unconfirmed' as const }),
      update: (record) => updated.push(record),
    })
    expect(rechecked).toEqual(['g1'])
    expect(out.find((record) => record.id === 'g1')?.state).toBe('unconfirmed')
    const closed = out.find((record) => record.id === 'g2')
    expect(closed?.state).toBe('error')
    expect(closed?.error).toBe(INTERRUPTED_BEFORE_HASH)
    expect(updated.map((record) => record.id)).toEqual(['g2'])
    expect(out.some((record) => record.state === 'success')).toBe(false)
  })
})

describe('recovery of CCTP transfers', () => {
  test('only a transfer that a read-only look at Arc can settle is rechecked; nothing needing a wallet is run', async () => {
    const { sources } = await loadCctpChains()
    const make = (state: TransferRecord['state'], steps: Array<[string, string]>, useForwarder = true): TransferRecord => {
      const base = newTransferRecord({ owner: OWNER, source: sources.find((chain) => chainKey(chain) === 'Arbitrum') ?? sources[0], amount: '10', recipient: OWNER, speed: 'FAST', useForwarder })
      return { ...base, state, steps: base.steps.map((step) => ({ ...step, state: (steps.find(([name]) => name === step.name)?.[1] ?? 'idle') as never })) }
    }
    const unconfirmed = make('unconfirmed', [['burn', 'success']])
    const burnedForwarded = make('error', [['burn', 'success'], ['fetchAttestation', 'error']])
    const notBurned = make('error', [['approve', 'success'], ['burn', 'error']])
    const done = make('success', [['burn', 'success'], ['mint', 'success']])
    const seen: string[] = []
    await recoverCctp([unconfirmed, burnedForwarded, notBurned, done], { recheck: async (record) => (seen.push(record.id), record) })
    expect(seen).toEqual([unconfirmed.id, burnedForwarded.id])
  })
})

describe('controlled polling', () => {
  test('the delay starts at 15 seconds, grows, and never passes two minutes', () => {
    expect(recoveryDelay(0)).toBe(15_000)
    expect(recoveryDelay(1)).toBeGreaterThan(recoveryDelay(0))
    expect(recoveryDelay(30)).toBe(120_000)
  })
})
