import { isAddressEqual, type Address, type Hex } from 'viem'
import type { ActivityItem } from '@/lib/activity'
import { CATEGORIES, type Category, type TxMeta } from '@/lib/txMeta'
import { statusOf, type PaymentRequest, type RequestKind } from '@/lib/payments/requests'

/**
 * One list of verified USDC payments made or received by a wallet. It is built only from confirmed onchain
 * transfers (found by the activity scan) and from requests that were settled by a real transfer. Nothing is invented.
 */
export interface LedgerEntry {
  hash: Hex
  direction: 'in' | 'out'
  amount: bigint
  counterparty?: Address
  /** Unix seconds from the block, when known. */
  timestamp?: number
  requestId?: string
  requestKind?: RequestKind
  description?: string
}

export function buildLedger(activity: readonly ActivityItem[], requests: readonly PaymentRequest[]): LedgerEntry[] {
  const byHash = new Map<string, LedgerEntry>()
  for (const item of activity) {
    if (item.status !== 'confirmed' || (item.kind !== 'send' && item.kind !== 'receive')) continue
    byHash.set(item.hash.toLowerCase(), { hash: item.hash, direction: item.kind === 'send' ? 'out' : 'in', amount: item.amount, counterparty: item.counterparty, timestamp: item.timestamp })
  }
  for (const request of requests) {
    if (!request.paid) continue
    const key = request.paid.hash.toLowerCase()
    const existing = byHash.get(key)
    const base: LedgerEntry = existing ?? { hash: request.paid.hash, direction: 'in', amount: BigInt(request.paid.amount), counterparty: request.paid.from, timestamp: request.paid.timestamp }
    byHash.set(key, { ...base, timestamp: base.timestamp ?? request.paid.timestamp, requestId: request.id, requestKind: request.kind, description: request.description || undefined })
  }
  return [...byHash.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
}

/** The ledger as activity items, so the existing list, labels and trend code can show it. */
export function ledgerAsActivity(entries: readonly LedgerEntry[]): ActivityItem[] {
  return entries.map((entry) => ({
    id: `ledger:${entry.hash}`,
    kind: entry.direction === 'in' ? ('receive' as const) : ('send' as const),
    hash: entry.hash,
    timestamp: entry.timestamp,
    amount: entry.amount,
    counterparty: entry.counterparty,
    token: 'USDC' as const,
    status: 'confirmed' as const,
  }))
}

export interface Overview {
  received: bigint
  sent: bigint
  /** Verified USDC sends and receives found. */
  paymentCount: number
  /** Open requests, links, invoices and split shares waiting to be paid. */
  pendingCount: number
  pendingAmount: bigint
  /** Requests settled by a verified payment. */
  completedCount: number
  outstandingInvoices: number
  outstandingInvoiceAmount: bigint
  expiredCount: number
}

export function computeOverview(ledger: readonly LedgerEntry[], requests: readonly PaymentRequest[], nowSeconds: number): Overview {
  const overview: Overview = { received: 0n, sent: 0n, paymentCount: ledger.length, pendingCount: 0, pendingAmount: 0n, completedCount: 0, outstandingInvoices: 0, outstandingInvoiceAmount: 0n, expiredCount: 0 }
  for (const entry of ledger) {
    if (entry.direction === 'in') overview.received += entry.amount
    else overview.sent += entry.amount
  }
  for (const request of requests) {
    const status = statusOf(request, nowSeconds)
    if (status === 'paid') overview.completedCount += 1
    else if (status === 'expired') overview.expiredCount += 1
    else if (status === 'pending') {
      overview.pendingCount += 1
      overview.pendingAmount += BigInt(request.amount)
      if (request.kind === 'invoice') {
        overview.outstandingInvoices += 1
        overview.outstandingInvoiceAmount += BigInt(request.amount)
      }
    }
  }
  return overview
}

export interface CategoryTotal {
  category: Category | 'Uncategorized'
  sent: bigint
  received: bigint
  count: number
}

/** Totals per category, from the categories you set on transactions and requests. Uncategorized is shown last. */
export function categoryTotals(ledger: readonly LedgerEntry[], metas: Record<string, TxMeta>, requests: readonly PaymentRequest[]): CategoryTotal[] {
  const totals = new Map<string, CategoryTotal>()
  const slot = (category: CategoryTotal['category']) => {
    let entry = totals.get(category)
    if (!entry) {
      entry = { category, sent: 0n, received: 0n, count: 0 }
      totals.set(category, entry)
    }
    return entry
  }
  for (const entry of ledger) {
    const request = requests.find((candidate) => candidate.id === entry.requestId)
    const category = metas[entry.hash.toLowerCase()]?.category ?? request?.category ?? 'Uncategorized'
    const row = slot(category)
    row.count += 1
    if (entry.direction === 'in') row.received += entry.amount
    else row.sent += entry.amount
  }
  const order = (category: string) => (category === 'Uncategorized' ? 99 : (CATEGORIES as readonly string[]).indexOf(category))
  return [...totals.values()].sort((a, b) => order(a.category) - order(b.category))
}

export interface CustomerGroup {
  address: Address
  count: number
  received: bigint
  sent: bigint
  lastTimestamp?: number
  /** Requests, invoices or split shares this wallet paid. */
  related: PaymentRequest[]
}

/** Groups payments by the other wallet, locally. Only addresses already visible onchain; nothing private. */
export function groupCustomers(ledger: readonly LedgerEntry[], requests: readonly PaymentRequest[]): CustomerGroup[] {
  const groups: CustomerGroup[] = []
  for (const entry of ledger) {
    if (!entry.counterparty) continue
    const address = entry.counterparty
    let group = groups.find((candidate) => isAddressEqual(candidate.address, address))
    if (!group) {
      group = { address, count: 0, received: 0n, sent: 0n, related: [] }
      groups.push(group)
    }
    group.count += 1
    if (entry.direction === 'in') group.received += entry.amount
    else group.sent += entry.amount
    if (entry.timestamp !== undefined && (group.lastTimestamp === undefined || entry.timestamp > group.lastTimestamp)) group.lastTimestamp = entry.timestamp
  }
  for (const request of requests) {
    if (!request.paid) continue
    const from = request.paid.from
    const group = groups.find((candidate) => isAddressEqual(candidate.address, from))
    if (group) group.related.push(request)
  }
  return groups.sort((a, b) => b.count - a.count || (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0))
}
