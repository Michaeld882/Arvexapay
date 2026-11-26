import { getAddress, type Address, type Hex } from 'viem'
import { NETWORK_NAME, explorerTxUrl } from '@/chain'
import { createOwnerStore } from '@/lib/ownerStore'
import { formatTimestamp, formatUsdcDisplay } from '@/lib/format'
import type { LedgerEntry } from '@/lib/payments/ledger'
import type { PaymentRequest } from '@/lib/payments/requests'
import type { LocalTx } from '@/lib/txLog'
import { isCategory, type Category, type TxMeta } from '@/lib/txMeta'

/** A clean record of a verified USDC payment. Built only from payments that were confirmed onchain. */
export interface Receipt {
  hash: Hex
  direction: 'received' | 'sent'
  amount: bigint
  from: Address
  to: Address
  timestamp?: number
  network: string
  status: 'Verified'
  description?: string
  invoiceNo?: string
  reference?: string
  note?: string
  category?: Category
}

/** Receipts for verified payments: those that settled your requests, sends you confirmed here, and transfers found onchain. Newest first. */
export function buildReceipts(owner: Address, requests: readonly PaymentRequest[], localTxs: readonly LocalTx[], metas: Record<string, TxMeta> = {}, ledger: readonly LedgerEntry[] = []): Receipt[] {
  const byHash = new Map<string, Receipt>()
  for (const entry of ledger) {
    if (!entry.counterparty) continue
    const meta = metas[entry.hash.toLowerCase()]
    byHash.set(entry.hash.toLowerCase(), {
      hash: entry.hash,
      direction: entry.direction === 'in' ? 'received' : 'sent',
      amount: entry.amount,
      from: entry.direction === 'in' ? entry.counterparty : getAddress(owner),
      to: entry.direction === 'in' ? getAddress(owner) : entry.counterparty,
      timestamp: entry.timestamp,
      network: NETWORK_NAME,
      status: 'Verified',
      note: meta?.note,
      category: meta?.category,
    })
  }
  for (const tx of localTxs) {
    if (tx.kind !== 'send' || tx.status !== 'success' || !tx.to) continue
    const meta = metas[tx.hash.toLowerCase()]
    byHash.set(tx.hash.toLowerCase(), { hash: tx.hash, direction: 'sent', amount: BigInt(tx.amount), from: getAddress(owner), to: tx.to, timestamp: tx.createdAt, network: NETWORK_NAME, status: 'Verified', note: meta?.note, category: meta?.category })
  }
  for (const request of requests) {
    if (!request.paid) continue
    const meta = metas[request.paid.hash.toLowerCase()]
    byHash.set(request.paid.hash.toLowerCase(), {
      hash: request.paid.hash,
      direction: 'received',
      amount: BigInt(request.paid.amount),
      from: request.paid.from,
      to: request.to,
      timestamp: request.paid.timestamp,
      network: NETWORK_NAME,
      status: 'Verified',
      description: request.description || undefined,
      invoiceNo: request.invoiceNo,
      reference: request.reference,
      note: meta?.note,
      category: meta?.category ?? (isCategory(request.category) ? request.category : undefined),
    })
  }
  return [...byHash.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
}

export function receiptText(receipt: Receipt): string {
  return [
    'Arvexa payment receipt',
    `Amount: ${formatUsdcDisplay(receipt.amount)} USDC`,
    `From: ${receipt.from}`,
    `To: ${receipt.to}`,
    receipt.timestamp ? `Date: ${formatTimestamp(receipt.timestamp)}` : undefined,
    `Network: ${receipt.network}`,
    'Status: Verified onchain',
    receipt.invoiceNo ? `Invoice: ${receipt.invoiceNo}` : undefined,
    receipt.description ? `For: ${receipt.description}` : undefined,
    receipt.reference ? `Reference: ${receipt.reference}` : undefined,
    `Transaction: ${receipt.hash}`,
    explorerTxUrl(receipt.hash),
  ]
    .filter(Boolean)
    .join('\n')
}

/** Payments you made through a payment link, remembered in this browser so reopening the link shows it as paid. */
export interface PaidLinkRecord {
  hash: Hex
  to: Address
  amount: string
  requestId?: string
  reference?: string
  description?: string
  at: number
}

const EMPTY: PaidLinkRecord[] = []
const paidLinks = createOwnerStore<PaidLinkRecord[]>('arvexa:paidlinks:v1', EMPTY, (raw) => {
  if (!Array.isArray(raw)) return EMPTY
  return (raw as PaidLinkRecord[]).filter((entry) => typeof entry?.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(entry.hash) && typeof entry.to === 'string' && /^\d+$/.test(String(entry.amount)))
})
export const usePaidLinks = (payer: string | undefined): PaidLinkRecord[] => paidLinks.useOwner(payer)
export function rememberPaidLink(payer: string, record: PaidLinkRecord): void {
  paidLinks.write(payer, [record, ...paidLinks.read(payer).filter((entry) => entry.hash !== record.hash)].slice(0, 100))
}

/** Store or business name shown on Merchant Mode and on links you create. */
const merchant = createOwnerStore<{ name?: string }>('arvexa:merchant:v1', {}, (raw) => {
  const name = typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  return name ? { name } : {}
})
export const useMerchantName = (owner: string | undefined): string | undefined => merchant.useOwner(owner).name
export const readMerchantName = (owner: string): string | undefined => merchant.read(owner).name
export function saveMerchantName(owner: string, name: string): void {
  merchant.write(owner, { name: name.replace(/\s+/g, ' ').trim().slice(0, 40) || undefined })
}
