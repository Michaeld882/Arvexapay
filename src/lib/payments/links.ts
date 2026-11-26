import { isAddress, type Address } from 'viem'
import { checkAmount, checkRecipient } from '@/lib/validate'
import { CUSTOMER_MAX, DESC_MAX, REF_MAX, type PaymentRequest } from '@/lib/payments/requests'
import { formatUsdc } from '@/onchain-money'

/** What a payment link says. It is public by design: a recipient address, an amount and a description. Nothing private. */
export interface PayLink {
  to: Address
  /** Decimal USDC such as "12.5", or undefined when the payer chooses the amount. */
  amount?: string
  description?: string
  reference?: string
  /** The business or person being paid, shown to the payer. */
  name?: string
  /** Unix seconds after which the link should no longer be paid. */
  expires?: number
  requestId?: string
}

const clip = (value: string | null, max: number) => {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  return clean === '' ? undefined : clean
}

export type ParsedPayLink = { ok: true; link: PayLink } | { ok: false; message: string }

/** Reads /pay?to=...&amount=... . Every value is checked, so a tampered link can only show or pay what passes the normal rules. */
export function parsePayLink(search: string): ParsedPayLink {
  const params = new URLSearchParams(search)
  const to = checkRecipient(params.get('to') ?? '')
  if (!to.ok) return { ok: false, message: params.get('to') ? to.message : 'This payment link has no recipient.' }
  const rawAmount = params.get('amount')
  let amount: string | undefined
  if (rawAmount) {
    const parsed = checkAmount(rawAmount)
    if (!parsed.ok) return { ok: false, message: 'This payment link has an invalid amount.' }
    amount = rawAmount
  }
  const exp = Number(params.get('exp'))
  const id = clip(params.get('id'), 16)
  return {
    ok: true,
    link: {
      to: to.address,
      amount,
      description: clip(params.get('desc'), DESC_MAX),
      reference: clip(params.get('ref'), REF_MAX),
      name: clip(params.get('name'), CUSTOMER_MAX),
      expires: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : undefined,
      requestId: id && /^[a-z0-9]+$/i.test(id) ? id : undefined,
    },
  }
}

/** The path and query for a link; add the app's base URL in front to share it. */
export function payLinkPath(link: PayLink): string {
  const params = new URLSearchParams({ to: link.to })
  if (link.amount) params.set('amount', link.amount)
  if (link.description) params.set('desc', link.description)
  if (link.reference) params.set('ref', link.reference)
  if (link.name) params.set('name', link.name)
  if (link.expires) params.set('exp', String(link.expires))
  if (link.requestId) params.set('id', link.requestId)
  return `/pay?${params.toString()}`
}

export function linkForRequest(request: PaymentRequest, merchantName?: string): PayLink {
  return {
    to: request.to,
    amount: formatUsdc(BigInt(request.amount)),
    description: request.kind === 'invoice' ? `${request.invoiceNo ?? 'Invoice'}: ${request.description}` : request.description || undefined,
    reference: request.reference,
    name: merchantName,
    expires: request.expiresAt,
    requestId: request.id,
  }
}

export const isPayAddress = (value: string): value is Address => isAddress(value)
