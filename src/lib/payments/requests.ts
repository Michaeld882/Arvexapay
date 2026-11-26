import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import { createOwnerStore } from '@/lib/ownerStore'
import { type Category, isCategory } from '@/lib/txMeta'
import { checkAmount, checkRecipient } from '@/lib/validate'

/**
 * Payment requests, payment links, invoices and split-bill shares are all the same thing: "this wallet expects this
 * much USDC". They differ only in the fields shown. They are kept in this browser, per wallet. A request is marked
 * Paid only when a real USDC transfer on Arc is found for it (see settle.ts); it can never be marked paid by hand.
 */
export type RequestKind = 'request' | 'link' | 'invoice' | 'split'
export type RequestStatus = 'pending' | 'paid' | 'expired' | 'cancelled'

export interface PaidInfo {
  hash: Hex
  from: Address
  /** Raw 6-decimal USDC base units, as a decimal string. */
  amount: string
  /** Block time in unix seconds, read from Arc. */
  timestamp?: number
  blockNumber?: string
  logIndex?: number
  verifiedAt: number
}

export interface PaymentRequest {
  id: string
  kind: RequestKind
  /** The wallet that receives the USDC (the creator). */
  to: Address
  /** Raw 6-decimal USDC base units, as a decimal string. */
  amount: string
  description: string
  reference?: string
  customer?: string
  invoiceNo?: string
  /** When set, only a transfer from this wallet counts (split participants who gave an address). */
  payer?: Address
  createdAt: number
  /** Arc block height when it was created: the earliest block a matching payment can be in. */
  createdBlock?: string
  expiresAt?: number
  cancelled?: boolean
  paid?: PaidInfo
  /** Highest block already searched for a matching payment, so each poll only reads new blocks. */
  scannedTo?: string
  category?: Category
  splitId?: string
  participantName?: string
}

export const MAX_REQUESTS = 300
export const DESC_MAX = 80
export const REF_MAX = 40
export const CUSTOMER_MAX = 40
const EMPTY: PaymentRequest[] = []
const KINDS: readonly string[] = ['request', 'link', 'invoice', 'split']

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return clean === '' ? undefined : clean
}

function sanitizePaid(raw: unknown): PaidInfo | undefined {
  const paid = raw as Partial<PaidInfo> | undefined
  if (!paid || typeof paid !== 'object' || !isHex(paid.hash, { strict: true }) || paid.hash.length !== 66 || !isAddress(paid.from ?? '') || !/^\d+$/.test(String(paid.amount))) return undefined
  return {
    hash: paid.hash,
    from: getAddress(paid.from as string),
    amount: String(paid.amount),
    timestamp: typeof paid.timestamp === 'number' ? paid.timestamp : undefined,
    blockNumber: paid.blockNumber !== undefined && /^\d+$/.test(String(paid.blockNumber)) ? String(paid.blockNumber) : undefined,
    logIndex: typeof paid.logIndex === 'number' ? paid.logIndex : undefined,
    verifiedAt: Number(paid.verifiedAt) || 0,
  }
}

function sanitize(raw: unknown): PaymentRequest[] {
  if (!Array.isArray(raw)) return EMPTY
  const out: PaymentRequest[] = []
  for (const entry of raw as Array<Partial<PaymentRequest>>) {
    if (typeof entry?.id !== 'string' || !KINDS.includes(String(entry.kind)) || !isAddress(entry.to ?? '') || !/^\d+$/.test(String(entry.amount)) || BigInt(String(entry.amount)) <= 0n) continue
    const block = (value: unknown) => (typeof value === 'string' && /^\d+$/.test(value) ? value : undefined)
    out.push({
      id: entry.id,
      kind: entry.kind as RequestKind,
      to: getAddress(entry.to as string),
      amount: String(entry.amount),
      description: text(entry.description, DESC_MAX) ?? '',
      reference: text(entry.reference, REF_MAX),
      customer: text(entry.customer, CUSTOMER_MAX),
      invoiceNo: text(entry.invoiceNo, 16),
      payer: entry.payer && isAddress(entry.payer) ? getAddress(entry.payer) : undefined,
      createdAt: Number(entry.createdAt) || 0,
      createdBlock: block(entry.createdBlock),
      expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : undefined,
      cancelled: entry.cancelled === true ? true : undefined,
      paid: sanitizePaid(entry.paid),
      scannedTo: block(entry.scannedTo),
      category: isCategory(entry.category) ? entry.category : undefined,
      splitId: text(entry.splitId, 32),
      participantName: text(entry.participantName, 40),
    })
  }
  return out
}

const store = createOwnerStore<PaymentRequest[]>('arvexa:requests:v1', EMPTY, sanitize)

export const useRequests = (owner: string | undefined): PaymentRequest[] => store.useOwner(owner)
export const readRequests = (owner: string): PaymentRequest[] => store.read(owner)
const write = (owner: string, next: PaymentRequest[]) => store.write(owner, next.slice(0, MAX_REQUESTS))

/** A short random id used in links. Not a secret: it only tells a link which request it belongs to. */
export function newRequestId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 10)
}

export function statusOf(request: PaymentRequest, nowSeconds: number): RequestStatus {
  if (request.paid) return 'paid'
  if (request.cancelled) return 'cancelled'
  if (request.expiresAt !== undefined && nowSeconds > request.expiresAt) return 'expired'
  return 'pending'
}

export const STATUS_LABEL: Record<RequestStatus, string> = { pending: 'Pending', paid: 'Paid', expired: 'Expired', cancelled: 'Cancelled' }

export interface RequestInput {
  amount: string
  description: string
  reference?: string
  customer?: string
  /** Days until it expires. 0 means it never expires. */
  expiresInDays: number
  category?: Category
}

export type RequestCheck =
  | { ok: true; amountRaw: bigint; description: string; reference?: string; customer?: string; expiresInDays: number }
  | { ok: false; field: 'amount' | 'description' | 'customer' | 'reference' | 'expiry'; message: string }

/** Validates the form for a request, link or invoice before anything is saved. */
export function checkRequestInput(kind: RequestKind, input: RequestInput): RequestCheck {
  const amount = checkAmount(input.amount)
  if (!amount.ok) return { ok: false, field: 'amount', message: amount.message }
  const description = text(input.description, DESC_MAX)
  const needsDescription = kind === 'link' || kind === 'invoice'
  if (needsDescription && !description) return { ok: false, field: 'description', message: kind === 'invoice' ? 'Describe what this invoice is for.' : 'Add a short description of what the payment is for.' }
  if (input.description.trim().length > DESC_MAX) return { ok: false, field: 'description', message: `Use ${DESC_MAX} characters or fewer.` }
  const customer = text(input.customer, CUSTOMER_MAX)
  if (kind === 'invoice' && !customer) return { ok: false, field: 'customer', message: 'Add the customer name.' }
  if ((input.reference ?? '').trim().length > REF_MAX) return { ok: false, field: 'reference', message: `Use ${REF_MAX} characters or fewer.` }
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 0 || input.expiresInDays > 365) return { ok: false, field: 'expiry', message: 'Choose when this expires.' }
  return { ok: true, amountRaw: amount.raw, description: description ?? '', reference: text(input.reference, REF_MAX), customer, expiresInDays: input.expiresInDays }
}

export function nextInvoiceNo(existing: readonly PaymentRequest[]): string {
  const highest = existing.reduce((top, request) => {
    const match = /^INV-(\d+)$/.exec(request.invoiceNo ?? '')
    return match ? Math.max(top, Number(match[1])) : top
  }, 0)
  return `INV-${String(highest + 1).padStart(4, '0')}`
}

export type CreateResult = { ok: true; request: PaymentRequest } | Extract<RequestCheck, { ok: false }>

/** Saves a new request for `owner`. `head` is Arc's current block height (matching payments cannot be earlier). */
export function createRequest(owner: Address, kind: RequestKind, input: RequestInput, head?: bigint, extra: Partial<PaymentRequest> = {}): CreateResult {
  const check = checkRequestInput(kind, input)
  if (!check.ok) return check
  const existing = readRequests(owner)
  const now = Math.floor(Date.now() / 1000)
  const request: PaymentRequest = {
    id: newRequestId(),
    kind,
    to: getAddress(owner),
    amount: check.amountRaw.toString(),
    description: check.description,
    reference: check.reference,
    customer: check.customer,
    invoiceNo: kind === 'invoice' ? nextInvoiceNo(existing) : undefined,
    createdAt: now,
    createdBlock: head === undefined ? undefined : head.toString(),
    expiresAt: check.expiresInDays > 0 ? now + check.expiresInDays * 86_400 : undefined,
    category: input.category,
    ...extra,
  }
  write(owner, [request, ...existing])
  return { ok: true, request }
}

function patch(owner: string, id: string, change: (request: PaymentRequest) => PaymentRequest) {
  write(
    owner,
    readRequests(owner).map((request) => (request.id === id ? change(request) : request)),
  )
}

export const cancelRequest = (owner: string, id: string) => patch(owner, id, (request) => (request.paid ? request : { ...request, cancelled: true }))
export const reopenRequest = (owner: string, id: string, now = Math.floor(Date.now() / 1000)) =>
  patch(owner, id, (request) => (request.paid ? request : { ...request, cancelled: undefined, expiresAt: request.expiresAt !== undefined && request.expiresAt < now ? now + 7 * 86_400 : request.expiresAt }))
export const setRequestCategory = (owner: string, id: string, category: Category | undefined) => patch(owner, id, (request) => ({ ...request, category }))
export const removeRequest = (owner: string, id: string) =>
  write(
    owner,
    readRequests(owner).filter((request) => request.id !== id),
  )

/** Applies what the chain search found: payments to record and the new "searched up to" block per request. */
export function applySettlement(owner: string, paid: ReadonlyMap<string, PaidInfo>, scannedTo: ReadonlyMap<string, bigint>): void {
  write(
    owner,
    readRequests(owner).map((request) => {
      const payment = paid.get(request.id)
      const upTo = scannedTo.get(request.id)
      if (!payment && upTo === undefined) return request
      return { ...request, paid: request.paid ?? payment, scannedTo: upTo !== undefined && (request.scannedTo === undefined || upTo > BigInt(request.scannedTo)) ? upTo.toString() : request.scannedTo }
    }),
  )
}

export { checkRecipient }
