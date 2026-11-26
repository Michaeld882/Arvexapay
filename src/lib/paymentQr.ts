import { isAddress, isAddressEqual, type Address } from 'viem'
import { ARC_CHAIN_ID, USDC } from '@/chain'
import { formatUsdc } from '@/onchain-money'
import { checkAmount, checkRecipient } from '@/lib/validate'

export type PaymentQr = { ok: true; address: Address; amount?: string } | { ok: false; message: string }

const NOT_PAYMENT = 'This QR code is not a wallet address or a payment link.'

/**
 * Reads what a scanned QR code or a payment link contains. Supported:
 * - a plain wallet address (what the Receive screen shows)
 * - an `ethereum:` payment URI (EIP-681), including a USDC `transfer` request
 * - an Arvexa link such as `/send?to=0x...`
 * Anything else is rejected, and every address passes the same checks as the Send screen.
 */
export function parsePaymentQr(input: string): PaymentQr {
  const text = input.trim()
  if (text === '' || text.length > 2048) return { ok: false, message: NOT_PAYMENT }

  let address: string | undefined
  let amount: string | undefined

  if (isAddress(text)) {
    address = text
  } else if (/^ethereum:/i.test(text)) {
    const body = text.replace(/^ethereum:(pay-)?/i, '')
    const [target, queryPart = ''] = body.split('?')
    const [head, ...pathParts] = target.split('/')
    const [subject, chainId] = head.split('@')
    if (chainId !== undefined && Number(chainId) !== ARC_CHAIN_ID) return { ok: false, message: 'This payment request is for a different network. Arvexa only pays on Arc Mainnet.' }
    const params = new URLSearchParams(queryPart)
    if (pathParts[0] === 'transfer') {
      if (!isAddress(subject) || !isAddressEqual(subject, USDC.address)) return { ok: false, message: 'This payment request is for a token other than USDC.' }
      address = params.get('address') ?? undefined
      const raw = params.get('uint256')
      if (raw && /^\d+$/.test(raw)) amount = formatUsdc(BigInt(raw))
    } else {
      address = subject
      const value = params.get('value')
      if (value && value !== '0') return { ok: false, message: 'This payment request asks for the network coin, not USDC.' }
    }
  } else {
    try {
      const url = new URL(text)
      address = url.searchParams.get('to') ?? undefined
      amount = url.searchParams.get('amount') ?? undefined
    } catch {
      return { ok: false, message: NOT_PAYMENT }
    }
  }

  if (!address) return { ok: false, message: NOT_PAYMENT }
  const to = checkRecipient(address)
  if (!to.ok) return { ok: false, message: to.message }
  const parsed = amount ? checkAmount(amount) : undefined
  return { ok: true, address: to.address, amount: parsed?.ok ? amount : undefined }
}

/** The Send screen address for a scanned or shared payment, with the recipient already filled in. */
export const sendLink = (address: string, amount?: string): string => `/send?to=${address}${amount ? `&amount=${encodeURIComponent(amount)}` : ''}`
