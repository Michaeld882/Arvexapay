import { isAddress, isAddressEqual, type Address } from 'viem'
import { ARC_CHAIN_ID, NETWORK_NAME, USDC } from '@/chain'
import { parsePayLink, payLinkPath } from '@/lib/payments/links'
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

/** What a scanned code or pasted text means for the app. */
export type ScanTarget =
  | { kind: 'send'; address: Address; amount?: string }
  /** An Arvexa payment link (invoice, request, PayHub, pay link): opens the Pay screen with the same details. */
  | { kind: 'pay'; path: string; to: Address; amount?: string }
  /** A web address that is not a wallet payment. It may be an API that asks for payment through x402. */
  | { kind: 'api'; url: string }
  | { kind: 'invalid'; title: string; message: string }

const NOT_A_PAYMENT: ScanTarget = { kind: 'invalid', title: 'Not a valid payment code', message: NOT_PAYMENT }

/** Other payment apps and networks are named so the message is useful instead of a generic failure. */
const OTHER_SCHEMES: Record<string, string> = {
  bitcoin: 'Bitcoin',
  litecoin: 'Litecoin',
  solana: 'Solana',
  lightning: 'the Lightning Network',
  lnbc: 'the Lightning Network',
  upi: 'UPI',
  tel: 'a phone number',
  mailto: 'an email address',
  sms: 'a text message',
  wifi: 'a Wi-Fi network',
  geo: 'a map location',
}

/**
 * Decides what to do with decoded or pasted text. Every route ends on a screen that shows the payment before the
 * wallet is asked to sign: wallet addresses and USDC requests open Send, Arvexa payment links open Pay.
 */
export function resolveScan(input: string): ScanTarget {
  const text = input.trim()
  if (text === '' || text.length > 2048) return NOT_A_PAYMENT

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase()
  if (scheme === 'wc') return { kind: 'invalid', title: 'Unsupported code', message: 'This is a WalletConnect pairing code, not a payment. Connect a wallet with the wallet button instead.' }
  if (scheme && OTHER_SCHEMES[scheme]) return { kind: 'invalid', title: 'Unsupported payment code', message: `This code is for ${OTHER_SCHEMES[scheme]}. Arvexa pays USDC on ${NETWORK_NAME} only.` }

  if (scheme === 'http' || scheme === 'https') {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return NOT_A_PAYMENT
    }
    const path = url.pathname.replace(/\/+$/, '')
    if (path.endsWith('/pay') && url.searchParams.has('to')) {
      const parsed = parsePayLink(url.search)
      if (!parsed.ok) return { kind: 'invalid', title: 'Not a valid payment link', message: parsed.message }
      return { kind: 'pay', path: payLinkPath(parsed.link), to: parsed.link.to, amount: parsed.link.amount }
    }
    if (url.searchParams.has('to')) {
      const parsed = parsePaymentQr(text)
      return parsed.ok ? { kind: 'send', address: parsed.address, amount: parsed.amount } : { kind: 'invalid', title: 'Not a valid payment code', message: parsed.message }
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol === 'http:' && !local) return { kind: 'invalid', title: 'Unsupported link', message: 'This is an unsecured web link (http). Arvexa only opens secure (https) links.' }
    if (url.username || url.password) return { kind: 'invalid', title: 'Unsupported link', message: 'This web link contains a username or password, so Arvexa will not open it.' }
    return { kind: 'api', url: url.toString() }
  }

  const parsed = parsePaymentQr(text)
  return parsed.ok ? { kind: 'send', address: parsed.address, amount: parsed.amount } : { kind: 'invalid', title: 'Not a valid payment code', message: parsed.message }
}

/** The Send screen for a scanned payment. With an amount it opens the review screen straight away. */
export const sendReviewLink = (address: string, amount?: string): string => `${sendLink(address, amount)}${amount ? '&review=1' : ''}`
