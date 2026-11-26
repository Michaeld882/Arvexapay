import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address, type Hex } from 'viem'
import { ARC_RPC_URL, USDC } from '../src/chain'
import type { ActivityItem } from '../src/lib/activity'
import { buildLedger, categoryTotals, computeOverview, groupCustomers, ledgerAsActivity } from '../src/lib/payments/ledger'
import { parsePayLink, payLinkPath } from '../src/lib/payments/links'
import { buildReceipts, receiptText } from '../src/lib/payments/receipts'
import { FREQUENCIES, advanceDate, checkReminder, completeReminder, dueLabel, dueState, nextAfter, readReminders, saveReminder, upcoming } from '../src/lib/payments/reminders'
import { cancelRequest, checkRequestInput, createRequest, readRequests, reopenRequest, statusOf, type PaymentRequest } from '../src/lib/payments/requests'
import { claimKey, claimedKeys, matchPayments, syncPayments, verifyPaymentByHash, type IncomingTransfer } from '../src/lib/payments/settle'
import { checkSplit, createSplit, splitEqually, splitProgress } from '../src/lib/payments/splits'
import type { LocalTx } from '../src/lib/txLog'

const OWNER = getAddress('0x1111111111111111111111111111111111111111')
const PAYER = getAddress('0x2222222222222222222222222222222222222222')
const OTHER = getAddress('0x3333333333333333333333333333333333333333')
/** The public RPC can answer "rate limit exceeded" when a whole suite runs at once; the app retries reads, and so does this test. */
async function withRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (attempt >= attempts) throw err
      await new Promise((resolve) => setTimeout(resolve, 2500 * attempt))
    }
  }
}
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

afterEach(() => {
  window.localStorage.clear()
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
})

const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({ id: 'r1', kind: 'request', to: OWNER, amount: '5000000', description: 'Lunch', createdAt: 1000, createdBlock: '100', ...over })
const transfer = (over: Partial<IncomingTransfer> = {}): IncomingTransfer => ({ hash: hash(1), logIndex: 0, from: PAYER, value: 5_000_000n, blockNumber: 120n, ...over })

describe('requests, links and invoices', () => {
  test('validation: amount, description, customer, reference and expiry', () => {
    const base = { amount: '5', description: '', expiresInDays: 7 }
    expect(checkRequestInput('request', base).ok).toBe(true)
    expect(checkRequestInput('request', { ...base, amount: '0' })).toMatchObject({ ok: false, field: 'amount' })
    expect(checkRequestInput('request', { ...base, amount: '1.1234567' })).toMatchObject({ ok: false, field: 'amount' })
    expect(checkRequestInput('link', base)).toMatchObject({ ok: false, field: 'description' })
    expect(checkRequestInput('invoice', { ...base, description: 'Work' })).toMatchObject({ ok: false, field: 'customer' })
    expect(checkRequestInput('invoice', { ...base, description: 'Work', customer: 'Acme' }).ok).toBe(true)
    expect(checkRequestInput('request', { ...base, reference: 'x'.repeat(41) })).toMatchObject({ ok: false, field: 'reference' })
    expect(checkRequestInput('request', { ...base, expiresInDays: -1 })).toMatchObject({ ok: false, field: 'expiry' })
  })

  test('creating saves a pending request with the real block it was made at, numbers invoices, and statuses follow the rules', () => {
    const made = createRequest(OWNER, 'invoice', { amount: '12.5', description: 'Design', customer: 'Acme', expiresInDays: 30 }, 4242n)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.request.invoiceNo).toBe('INV-0001')
    expect(made.request.amount).toBe('12500000')
    expect(made.request.createdBlock).toBe('4242')
    const second = createRequest(OWNER, 'invoice', { amount: '1', description: 'More', customer: 'Acme', expiresInDays: 0 })
    expect(second.ok && second.request.invoiceNo).toBe('INV-0002')
    expect(readRequests(OWNER)).toHaveLength(2)
    const now = made.request.createdAt
    expect(statusOf(made.request, now)).toBe('pending')
    expect(statusOf(made.request, (made.request.expiresAt ?? 0) + 1)).toBe('expired')
    cancelRequest(OWNER, made.request.id)
    expect(statusOf(readRequests(OWNER).find((r) => r.id === made.request.id) as PaymentRequest, now)).toBe('cancelled')
    reopenRequest(OWNER, made.request.id, now)
    expect(statusOf(readRequests(OWNER).find((r) => r.id === made.request.id) as PaymentRequest, now)).toBe('pending')
  })

  test('a paid request can never be cancelled, and nothing marks a request paid without a transfer', () => {
    const made = createRequest(OWNER, 'request', { amount: '1', description: '', expiresInDays: 7 })
    if (!made.ok) throw new Error('create failed')
    expect(made.request.paid).toBeUndefined()
    const paid = { ...made.request, paid: { hash: hash(9), from: PAYER, amount: '1000000', verifiedAt: 1 } }
    expect(statusOf(paid, 0)).toBe('paid')
    expect(statusOf({ ...paid, cancelled: true }, 0)).toBe('paid')
  })

  test('pay links round-trip, and a tampered link cannot smuggle in a bad recipient or amount', () => {
    const path = payLinkPath({ to: OWNER, amount: '12.5', description: 'Lunch & drinks', reference: 'PO 1', name: 'Corner Cafe', expires: 2_000_000_000, requestId: 'abc123' })
    expect(path.startsWith('/pay?')).toBe(true)
    const parsed = parsePayLink(path.slice(path.indexOf('?')))
    expect(parsed).toMatchObject({ ok: true, link: { to: OWNER, amount: '12.5', description: 'Lunch & drinks', reference: 'PO 1', name: 'Corner Cafe', expires: 2_000_000_000, requestId: 'abc123' } })
    expect(parsePayLink('?to=nope&amount=1').ok).toBe(false)
    expect(parsePayLink('').ok).toBe(false)
    expect(parsePayLink(`?to=${OWNER}&amount=-3`).ok).toBe(false)
    expect(parsePayLink(`?to=${OWNER}&amount=1.1234567`).ok).toBe(false)
    expect(parsePayLink(`?to=${USDC.address}&amount=1`).ok).toBe(false)
    const open = parsePayLink(`?to=${OWNER}`)
    expect(open.ok && open.link.amount).toBeUndefined()
  })
})

describe('matching payments to requests (pure rules)', () => {
  test('exact amount, recipient wallet and a block at or after creation', () => {
    expect(matchPayments([request()], [transfer()]).get('r1')?.hash).toBe(hash(1))
    expect(matchPayments([request()], [transfer({ value: 5_000_001n })]).size).toBe(0)
    expect(matchPayments([request()], [transfer({ blockNumber: 99n })]).size).toBe(0)
    expect(matchPayments([request()], [transfer({ from: OWNER })]).size).toBe(0)
  })

  test('one transfer settles only one request, and the older request goes first', () => {
    const a = request({ id: 'a', createdAt: 1 })
    const b = request({ id: 'b', createdAt: 2 })
    const one = matchPayments([b, a], [transfer()])
    expect([...one.keys()]).toEqual(['a'])
    const two = matchPayments([b, a], [transfer(), transfer({ hash: hash(2), blockNumber: 130n })])
    expect(two.get('a')?.hash).toBe(hash(1))
    expect(two.get('b')?.hash).toBe(hash(2))
  })

  test('already-claimed transfers are skipped, and a split share with a payer address only accepts that payer', () => {
    const paid = request({ id: 'old', paid: { hash: hash(1), from: PAYER, amount: '5000000', logIndex: 0, verifiedAt: 1 } })
    expect(claimedKeys([paid]).has(claimKey(hash(1), 0))).toBe(true)
    expect(matchPayments([request()], [transfer()], claimedKeys([paid])).size).toBe(0)
    const share = request({ payer: OTHER })
    expect(matchPayments([share], [transfer()]).size).toBe(0)
    expect(matchPayments([share], [transfer({ from: OTHER })]).size).toBe(1)
  })
})

describe('real Arc payments (read only)', () => {
  const client = createPublicClient({ transport: http(ARC_RPC_URL) })
  let real: { hash: Hex; to: Address; from: Address; value: bigint; blockNumber: bigint; logIndex: number }

  beforeAll(async () => {
    const head = await client.getBlockNumber()
    const logs = await withRetry(() => client.getLogs({ address: USDC.address, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: head - 300n, toBlock: head }))
    for (const log of logs) {
      const code = await client.getCode({ address: log.args.to as Address })
      if ((!code || code === '0x') && log.args.value && log.args.value > 0n) {
        real = { hash: log.transactionHash, to: getAddress(log.args.to as Address), from: getAddress(log.args.from as Address), value: log.args.value, blockNumber: log.blockNumber, logIndex: log.logIndex }
        return
      }
    }
    throw new Error('No transfer to an EOA found in recent blocks')
  }, 60_000)

  test('verifying by hash reads the transaction from Arc and accepts only the exact payment', async () => {
    const good = createRequest(real.to, 'request', { amount: (Number(real.value) / 1e6).toFixed(6), description: '', expiresInDays: 0 })
    if (!good.ok) throw new Error('create failed')
    const wrongAmount = createRequest(real.to, 'request', { amount: ((Number(real.value) + 7) / 1e6).toFixed(6), description: '', expiresInDays: 0 })
    if (!wrongAmount.ok) throw new Error('create failed')

    expect(await verifyPaymentByHash(real.to, good.request, 'not a hash')).toMatchObject({ ok: false })
    expect(await verifyPaymentByHash(real.to, good.request, `0x${'ab'.repeat(32)}`)).toMatchObject({ ok: false })
    expect(await verifyPaymentByHash(real.to, wrongAmount.request, real.hash)).toMatchObject({ ok: false, message: expect.stringMatching(/No transfer of/) })

    const result = await withRetry(async () => {
      const attempt = await verifyPaymentByHash(real.to, good.request, real.hash)
      if (!attempt.ok && /could not be reached/.test(attempt.message)) throw new Error(attempt.message)
      return attempt
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paid.hash.toLowerCase()).toBe(real.hash.toLowerCase())
    expect(result.paid.amount).toBe(real.value.toString())
    expect(result.paid.timestamp).toBeGreaterThan(1_700_000_000)
    expect(readRequests(real.to).find((r) => r.id === good.request.id)?.paid?.hash.toLowerCase()).toBe(real.hash.toLowerCase())
    // the same transfer cannot settle a second request for the same amount
    const twin = createRequest(real.to, 'request', { amount: (Number(real.value) / 1e6).toFixed(6), description: '', expiresInDays: 0 })
    if (!twin.ok) throw new Error('create failed')
    expect(await verifyPaymentByHash(real.to, twin.request, real.hash)).toMatchObject({ ok: false, message: expect.stringMatching(/already used/) })
  }, 60_000)

  test('the live search finds the real payment from the block a request was created at, and leaves other amounts pending', async () => {
    const hit = createRequest(real.to, 'request', { amount: (Number(real.value) / 1e6).toFixed(6), description: '', expiresInDays: 0 }, real.blockNumber - 1n)
    const miss = createRequest(real.to, 'request', { amount: ((Number(real.value) + 13) / 1e6).toFixed(6), description: '', expiresInDays: 0 }, real.blockNumber - 1n)
    if (!hit.ok || !miss.ok) throw new Error('create failed')
    const result = await withRetry(() => syncPayments(real.to))
    expect(result.checked).toBe(2)
    expect(result.newlyPaid).toBe(1)
    const saved = readRequests(real.to)
    const paid = saved.find((r) => r.id === hit.request.id)?.paid
    expect(paid?.amount).toBe(real.value.toString())
    expect(paid?.timestamp).toBeGreaterThan(1_700_000_000)
    expect(saved.find((r) => r.id === miss.request.id)?.paid).toBeUndefined()
    expect(saved.find((r) => r.id === miss.request.id)?.scannedTo).toBeDefined()
    // a second search only reads new blocks and settles nothing more
    expect((await withRetry(() => syncPayments(real.to))).newlyPaid).toBe(0)
    void erc20Abi
  }, 90_000)
})

describe('split bills', () => {
  test('equal shares add up exactly, with leftovers going to the first people', () => {
    expect(splitEqually(10_000_000n, 3)).toEqual([3_333_334n, 3_333_333n, 3_333_333n])
    expect(splitEqually(10_000_000n, 3).reduce((a, b) => a + b, 0n)).toBe(10_000_000n)
    expect(splitEqually(1n, 4)).toEqual([1n, 0n, 0n, 0n])
    expect(splitEqually(5n, 0)).toEqual([])
  })

  test('a bill is only valid when every share is valid and the shares equal the total', () => {
    const ok = { title: 'Dinner', total: '30', myShare: '10', participants: [{ name: 'Ann', address: '', amount: '10' }, { name: 'Bo', address: PAYER, amount: '10' }] }
    expect(checkSplit(OWNER, ok).ok).toBe(true)
    expect(checkSplit(OWNER, { ...ok, title: '' })).toMatchObject({ ok: false, field: 'title' })
    expect(checkSplit(OWNER, { ...ok, participants: [] })).toMatchObject({ ok: false, field: 'participants' })
    expect(checkSplit(OWNER, { ...ok, participants: [{ ...ok.participants[0], amount: '9' }, ok.participants[1]] })).toMatchObject({ ok: false, message: expect.stringMatching(/short/) })
    expect(checkSplit(OWNER, { ...ok, participants: [{ ...ok.participants[0], amount: '12' }, ok.participants[1]] })).toMatchObject({ ok: false, message: expect.stringMatching(/over/) })
    expect(checkSplit(OWNER, { ...ok, participants: [ok.participants[0], { ...ok.participants[0], amount: '10' }] })).toMatchObject({ ok: false, message: expect.stringMatching(/Two people/) })
    expect(checkSplit(OWNER, { ...ok, participants: [ok.participants[0], { ...ok.participants[1], address: 'nope' }] })).toMatchObject({ ok: false })
    expect(checkSplit(OWNER, { ...ok, participants: [ok.participants[0], { ...ok.participants[1], address: OWNER }] })).toMatchObject({ ok: false, message: expect.stringMatching(/own address/) })
  })

  test('creating a bill makes one exact request per person; it completes only when every share is verified paid', () => {
    const made = createSplit(OWNER, { title: 'Trip', total: '10', myShare: '', participants: [{ name: 'Ann', address: '', amount: '3.333334' }, { name: 'Bo', address: '', amount: '3.333333' }, { name: 'Cy', address: '', amount: '3.333333' }] }, 77n)
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const requests = readRequests(OWNER)
    expect(requests).toHaveLength(3)
    expect(requests.map((r) => r.amount).sort()).toEqual(['3333333', '3333333', '3333334'])
    expect(requests.every((r) => r.kind === 'split' && r.createdBlock === '77' && r.splitId === made.split.id)).toBe(true)
    const now = requests[0].createdAt
    let progress = splitProgress(made.split, requests, now)
    expect(progress).toMatchObject({ paidCount: 0, completed: false })
    expect(progress.remaining).toBe(10_000_000n)
    const settle = (ids: string[]) => requests.map((r) => (ids.includes(r.id) ? { ...r, paid: { hash: hash(5), from: PAYER, amount: r.amount, verifiedAt: 1 } } : r))
    progress = splitProgress(made.split, settle([requests[0].id, requests[1].id]), now)
    expect(progress.paidCount).toBe(2)
    expect(progress.completed).toBe(false)
    expect(progress.remaining).toBe(BigInt(requests[2].amount))
    progress = splitProgress(made.split, settle(requests.map((r) => r.id)), now)
    expect(progress).toMatchObject({ paidCount: 3, completed: true, remaining: 0n })
    const cancelled = requests.map((r, index) => (index === 0 ? { ...r, cancelled: true } : { ...r, paid: { hash: hash(5), from: PAYER, amount: r.amount, verifiedAt: 1 } }))
    expect(splitProgress(made.split, cancelled, now).completed).toBe(false)
  })
})

describe('recurring reminders (they remind, never pay)', () => {
  test('dates advance by the frequency and keep month ends', () => {
    expect(advanceDate('2026-01-31', 'monthly')).toBe('2026-02-28')
    expect(advanceDate('2028-01-31', 'monthly')).toBe('2028-02-29')
    expect(advanceDate('2026-11-30', 'quarterly')).toBe('2027-02-28')
    expect(advanceDate('2026-12-30', 'weekly')).toBe('2027-01-06')
    expect(advanceDate('2026-02-28', 'yearly')).toBe('2027-02-28')
    expect(FREQUENCIES).toHaveLength(4)
  })

  test('the next due date is always after today, even after long neglect', () => {
    expect(nextAfter({ nextDue: '2026-01-10', frequency: 'monthly' }, '2026-11-26')).toBe('2026-12-10')
    expect(nextAfter({ nextDue: '2026-11-26', frequency: 'weekly' }, '2026-11-26')).toBe('2026-12-03')
  })

  test('due states and the upcoming list', () => {
    const today = '2026-11-26'
    expect(dueState({ nextDue: '2026-11-20' }, today)).toEqual({ state: 'overdue', days: -6 })
    expect(dueState({ nextDue: today }, today).state).toBe('today')
    expect(dueState({ nextDue: '2026-12-05' }, today).state).toBe('soon')
    expect(dueState({ nextDue: '2027-03-01' }, today).state).toBe('later')
    expect(dueLabel({ state: 'overdue', days: -1 })).toBe('Overdue by 1 day')
    const list = [{ nextDue: '2027-03-01' }, { nextDue: '2026-11-20' }, { nextDue: '2026-12-01' }].map((r, i) => ({ id: String(i), name: 'n', frequency: 'monthly' as const, createdAt: 0, ...r }))
    expect(upcoming(list, today).map((r) => r.nextDue)).toEqual(['2026-11-20', '2026-12-01'])
  })

  test('validation, saving, and moving on only when told to', () => {
    expect(checkReminder({ name: '', amount: '', frequency: 'monthly', nextDue: '2026-12-01', to: '' })).toMatchObject({ ok: false, field: 'name' })
    expect(checkReminder({ name: 'Rent', amount: '-1', frequency: 'monthly', nextDue: '2026-12-01', to: '' })).toMatchObject({ ok: false, field: 'amount' })
    expect(checkReminder({ name: 'Rent', amount: '', frequency: 'monthly', nextDue: 'soon', to: '' })).toMatchObject({ ok: false, field: 'nextDue' })
    expect(checkReminder({ name: 'Rent', amount: '', frequency: 'monthly', nextDue: '2026-12-01', to: 'nope' })).toMatchObject({ ok: false, field: 'to' })
    const saved = saveReminder(OWNER, { name: 'Rent', amount: '800', frequency: 'monthly', nextDue: '2026-12-01', to: PAYER })
    expect(saved.ok).toBe(true)
    const [reminder] = readReminders(OWNER)
    expect(reminder).toMatchObject({ name: 'Rent', amount: '800000000', nextDue: '2026-12-01', to: PAYER })
    completeReminder(OWNER, reminder.id, hash(3), '2026-12-01')
    expect(readReminders(OWNER)[0]).toMatchObject({ nextDue: '2027-01-01', lastPaid: { hash: hash(3), on: '2026-12-01' } })
  })
})

const item = (over: Partial<ActivityItem>): ActivityItem => ({ id: 'x', kind: 'receive', hash: hash(1), amount: 1_000_000n, token: 'USDC', status: 'confirmed', timestamp: 1_700_000_000, counterparty: PAYER, ...over })

describe('ledger, overview, categories, customers and receipts (only real, confirmed payments)', () => {
  test('the ledger counts confirmed sends and receives, merges settled requests by hash, and ignores everything else', () => {
    const activity = [
      item({ id: 'a', hash: hash(1), kind: 'receive', amount: 5_000_000n }),
      item({ id: 'b', hash: hash(2), kind: 'send', amount: 2_000_000n, counterparty: OTHER, timestamp: 1_700_000_100 }),
      item({ id: 'c', hash: hash(3), kind: 'deposit', amount: 9_000_000n }),
      item({ id: 'd', hash: hash(4), kind: 'send', amount: 7_000_000n, status: 'pending' }),
      item({ id: 'e', hash: hash(5), kind: 'receive', amount: 3_000_000n, status: 'failed' }),
    ]
    const settled = request({ id: 'r', paid: { hash: hash(1), from: PAYER, amount: '5000000', timestamp: 1_700_000_000, verifiedAt: 1 } })
    const outsideWindow = request({ id: 's', amount: '4000000', paid: { hash: hash(8), from: OTHER, amount: '4000000', timestamp: 1_699_000_000, verifiedAt: 1 } })
    const ledger = buildLedger(activity, [settled, outsideWindow])
    expect(ledger.map((entry) => entry.hash)).toEqual([hash(2), hash(1), hash(8)])
    expect(ledger.find((entry) => entry.hash === hash(1))).toMatchObject({ requestId: 'r', direction: 'in', amount: 5_000_000n })
    const overview = computeOverview(ledger, [settled, outsideWindow, request({ id: 'p', amount: '1000000' }), request({ id: 'i', kind: 'invoice', amount: '2500000' }), request({ id: 'x', expiresAt: 5 })], 10)
    expect(overview).toMatchObject({ received: 9_000_000n, sent: 2_000_000n, paymentCount: 3, pendingCount: 2, pendingAmount: 3_500_000n, completedCount: 2, outstandingInvoices: 1, outstandingInvoiceAmount: 2_500_000n, expiredCount: 1 })
    expect(ledgerAsActivity(ledger).every((entry) => entry.status === 'confirmed')).toBe(true)
  })

  test('with no data every number is zero, never invented', () => {
    expect(computeOverview([], [], 0)).toMatchObject({ received: 0n, sent: 0n, paymentCount: 0, pendingCount: 0, completedCount: 0 })
    expect(buildLedger([], [])).toEqual([])
    expect(groupCustomers([], [])).toEqual([])
  })

  test('categories group by the labels you set on transactions or requests, with the rest as Uncategorized', () => {
    const ledger = buildLedger([item({ hash: hash(1), amount: 2_000_000n }), item({ id: 'b', hash: hash(2), kind: 'send', amount: 1_000_000n }), item({ id: 'c', hash: hash(3), amount: 4_000_000n })], [])
    const totals = categoryTotals(ledger, { [hash(1)]: { category: 'Business' }, [hash(2)]: { category: 'Food' } }, [])
    expect(totals.map((row) => [row.category, row.received, row.sent])).toEqual([['Food', 0n, 1_000_000n], ['Business', 2_000_000n, 0n], ['Uncategorized', 4_000_000n, 0n]])
  })

  test('customers group by wallet with counts, totals, last payment and the requests that wallet paid', () => {
    const paid = request({ id: 'r', paid: { hash: hash(1), from: PAYER, amount: '5000000', timestamp: 1_700_000_500, verifiedAt: 1 } })
    const ledger = buildLedger([item({ hash: hash(1), amount: 5_000_000n, timestamp: 1_700_000_500 }), item({ id: 'b', hash: hash(2), amount: 1_000_000n, timestamp: 1_700_000_900 }), item({ id: 'c', hash: hash(3), kind: 'send', amount: 2_000_000n, counterparty: PAYER, timestamp: 1_700_000_100 }), item({ id: 'd', hash: hash(4), counterparty: OTHER })], [paid])
    const groups = groupCustomers(ledger, [paid])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ address: PAYER, count: 3, received: 6_000_000n, sent: 2_000_000n, lastTimestamp: 1_700_000_900 })
    expect(groups[0].related.map((r) => r.id)).toEqual(['r'])
  })

  test('receipts exist only for verified payments, and carry the hash, parties, network and Verified status', () => {
    const settled = request({ id: 'r', invoiceNo: 'INV-0001', description: 'Design', paid: { hash: hash(1), from: PAYER, amount: '5000000', timestamp: 1_700_000_000, verifiedAt: 1 } })
    const local = (status: LocalTx['status'], n: number): LocalTx => ({ hash: hash(n), kind: 'send', amount: '2000000', to: OTHER, status, createdAt: 1_700_000_200 })
    const receipts = buildReceipts(OWNER, [settled, request({ id: 'open' })], [local('success', 2), local('pending', 3), local('failed', 4), local('unverified', 5)], { [hash(2)]: { note: 'Lunch', category: 'Food' } })
    expect(receipts.map((r) => [r.hash, r.direction])).toEqual([[hash(2), 'sent'], [hash(1), 'received']])
    expect(receipts[0]).toMatchObject({ from: OWNER, to: OTHER, amount: 2_000_000n, note: 'Lunch', category: 'Food', status: 'Verified', network: 'Arc Mainnet' })
    expect(receipts[1]).toMatchObject({ from: PAYER, to: OWNER, invoiceNo: 'INV-0001' })
    const text = receiptText(receipts[1])
    expect(text).toContain(hash(1))
    expect(text).toContain('Verified')
    expect(text).toContain('Arc Mainnet')
  })
})
