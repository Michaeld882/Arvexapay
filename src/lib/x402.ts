/**
 * x402 API payments: paying a web API that answers HTTP 402 "Payment Required".
 *
 * This is NOT a wallet-to-wallet payment. The wallet signs a USDC transfer authorization (EIP-3009, an off-chain
 * signature, no gas) and the API's facilitator submits it. The protocol work (reading the 402, building and
 * encoding the payment) is done by the official x402 libraries. This file only decides what Arvexa is willing to
 * sign, checks what was signed, and verifies the settlement on chain.
 */
import { getAddress, isAddress, isAddressEqual, parseEventLogs, type Address, type Hex, type TransactionReceipt, erc20Abi, zeroAddress } from 'viem'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { ARC_CHAIN_ID, USDC, explorerTxUrl } from '@/chain'

/** Where payments are accepted: one chain and its USDC. Arvexa uses Arc Mainnet; tests use Arc Testnet. */
export interface X402Target {
  chainId: number
  network: `eip155:${number}`
  asset: Address
  label: string
  explorerTx: (hash: string) => string
}

export const ARC_TARGET: X402Target = { chainId: ARC_CHAIN_ID, network: `eip155:${ARC_CHAIN_ID}`, asset: USDC.address, label: 'Arc Mainnet', explorerTx: explorerTxUrl }

/** The most one API call may cost. A price above this is refused, however it is presented. */
export const MAX_API_PRICE = 10_000_000n // 10 USDC (6 decimals)

export const REQUEST_TIMEOUT_MS = 20_000
const BODY_PREVIEW_CHARS = 4_000

/** The reader for response headers that the x402 library expects. */
type Fetch = typeof globalThis.fetch

export type UrlCheck = { ok: true; url: string } | { ok: false; message: string }

/** Only secure addresses are fetched. Plain http is allowed for localhost only, for local development. */
export function parseResourceUrl(input: string): UrlCheck {
  const text = input.trim()
  if (text === '') return { ok: false, message: 'Enter the web address of the API.' }
  if (text.length > 2048) return { ok: false, message: 'That web address is too long.' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, message: 'That is not a valid web address. It should look like https://api.example.com/data.' }
  }
  if (url.username || url.password) return { ok: false, message: 'Web addresses with a username or password are not allowed.' }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { ok: false, message: 'Only secure https:// addresses can be used.' }
  return { ok: true, url: url.toString() }
}

export interface PayableOffer {
  url: string
  description?: string
  mimeType?: string
  requirement: PaymentRequirements
  amount: bigint
  payTo: Address
  /** The 402 as the server sent it, narrowed to the one requirement Arvexa accepts. This is all that is ever signed. */
  paymentRequired: PaymentRequired
  /** How long the signed authorization stays valid. */
  validForSeconds: number
}

export type Discovery =
  | { kind: 'free'; status: number; preview: string }
  | { kind: 'payable'; offer: PayableOffer }
  | { kind: 'unsupported'; message: string; accepted: string[] }
  | { kind: 'failed'; message: string }

const getAmount = (requirement: PaymentRequirements): string | undefined => (requirement as { amount?: string }).amount

/** Why a single payment option cannot be used, or undefined when it can. */
export function refuseRequirement(requirement: PaymentRequirements, target: X402Target): string | undefined {
  if (requirement.scheme !== 'exact') return `uses the "${String(requirement.scheme)}" payment type, which Arvexa does not sign`
  if (requirement.network !== target.network) return `asks for payment on ${String(requirement.network)}, not ${target.label}`
  if (!isAddress(requirement.asset) || !isAddressEqual(requirement.asset, target.asset)) return `asks for a token other than USDC on ${target.label}`
  if (!isAddress(requirement.payTo) || isAddressEqual(requirement.payTo, zeroAddress) || isAddressEqual(requirement.payTo, target.asset)) return 'has no valid payee address'
  const raw = getAmount(requirement)
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) return 'has no valid price'
  if (BigInt(raw) > MAX_API_PRICE) return 'costs more than Arvexa allows for a single API call (10 USDC)'
  const method = (requirement.extra as { assetTransferMethod?: unknown } | undefined)?.assetTransferMethod
  if (method !== undefined && method !== 'eip3009') return 'needs a token approval first, which is not supported here'
  return undefined
}

/** Turns the answer of an API into one of four outcomes. Nothing is signed here. */
export async function discover(input: string, target: X402Target = ARC_TARGET, fetchFn: Fetch = fetch): Promise<Discovery> {
  const checked = parseResourceUrl(input)
  if (!checked.ok) return { kind: 'failed', message: checked.message }
  let response: Response
  try {
    response = await fetchFn(checked.url, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    return { kind: 'failed', message: networkMessage(err) }
  }
  const text = await readText(response)
  if (response.status !== 402) {
    if (response.ok) return { kind: 'free', status: response.status, preview: text.slice(0, BODY_PREVIEW_CHARS) }
    return { kind: 'failed', message: `The API answered with status ${response.status} instead of asking for payment.` }
  }

  let paymentRequired: PaymentRequired
  try {
    const { x402Client, x402HTTPClient } = await import('@x402/core/client')
    const http = new x402HTTPClient(new x402Client())
    paymentRequired = http.getPaymentRequiredResponse((name) => response.headers.get(name), safeJson(text))
  } catch {
    return { kind: 'failed', message: 'The API asked for payment, but its payment details could not be read. It may not use the x402 standard, or it does not let browsers read its payment headers.' }
  }
  if (paymentRequired.x402Version !== 2) return { kind: 'unsupported', message: 'This API uses an older x402 version that Arvexa does not support.', accepted: [] }

  const accepted = paymentRequired.accepts.map((item) => `${String(item.scheme)} on ${String(item.network)}`)
  const reasons: string[] = []
  for (const requirement of paymentRequired.accepts) {
    const reason = refuseRequirement(requirement, target)
    if (reason) {
      reasons.push(`This API ${reason}.`)
      continue
    }
    return {
      kind: 'payable',
      offer: {
        url: checked.url,
        description: paymentRequired.resource?.description,
        mimeType: paymentRequired.resource?.mimeType,
        requirement,
        amount: BigInt(getAmount(requirement) as string),
        payTo: getAddress(requirement.payTo),
        paymentRequired: { ...paymentRequired, accepts: [requirement] },
        validForSeconds: requirement.maxTimeoutSeconds,
      },
    }
  }
  return { kind: 'unsupported', message: reasons[0] ?? `This API does not accept USDC on ${target.label}.`, accepted }
}

/** What can sign for the connected wallet. It only signs typed data; it can never send a transaction. */
export interface X402Signer {
  address: Address
  signTypedData: (message: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) => Promise<Hex>
}

export type PaidResult =
  | { kind: 'paid'; status: number; body: string; settlement: { transaction: Hex; payer?: string; network: string } }
  /** The API answered 200 but sent no readable settlement. Funds may or may not have moved: check Activity. */
  | { kind: 'paid-unconfirmed'; status: number; body: string }
  | { kind: 'refused'; status: number; message: string }

export class X402SigningMismatch extends Error {}

/** Signs exactly the offer on screen and sends it. The wallet shows its own signature request first. */
export async function payOffer(offer: PayableOffer, signer: X402Signer, target: X402Target = ARC_TARGET, fetchFn: Fetch = fetch): Promise<PaidResult> {
  const { x402Client, x402HTTPClient } = await import('@x402/core/client')
  const { ExactEvmScheme } = await import('@x402/evm/exact/client')
  const http = new x402HTTPClient(new x402Client().register(target.network, new ExactEvmScheme(signer)))

  const payload: PaymentPayload = await http.createPaymentPayload(offer.paymentRequired)
  assertSignedExactly(payload, offer, signer.address)

  const response = await fetchFn(offer.url, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { ...http.encodePaymentSignatureHeader(payload), Accept: 'application/json, text/plain, */*' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3) })
  const body = (await readText(response)).slice(0, BODY_PREVIEW_CHARS)
  if (!response.ok) return { kind: 'refused', status: response.status, message: refusalReason(response, body) }
  try {
    const settle = http.getPaymentSettleResponse((name) => response.headers.get(name))
    if (settle.success && /^0x[0-9a-fA-F]{64}$/.test(settle.transaction)) return { kind: 'paid', status: response.status, body, settlement: { transaction: settle.transaction as Hex, payer: settle.payer, network: String(settle.network) } }
  } catch {
    // no readable settlement header
  }
  return { kind: 'paid-unconfirmed', status: response.status, body }
}

/** The signed authorization must pay the shown payee the shown amount from the connected wallet, and nothing else. */
export function assertSignedExactly(payload: PaymentPayload, offer: PayableOffer, from: Address): void {
  const authorization = (payload.payload as { authorization?: { from?: string; to?: string; value?: string } }).authorization
  const ok = authorization !== undefined && typeof authorization.from === 'string' && typeof authorization.to === 'string' && authorization.value !== undefined && isAddress(authorization.from) && isAddress(authorization.to) && isAddressEqual(authorization.from, from) && isAddressEqual(authorization.to, offer.payTo) && BigInt(authorization.value) === offer.amount
  if (!ok) throw new X402SigningMismatch('The payment that was prepared does not match the price shown, so it was not sent.')
}

/**
 * Checks a settlement against the chain: the transaction must have succeeded and moved exactly the price in USDC
 * from the payer to the payee. Anything else is not called settled.
 */
export function verifySettlement(receipt: Pick<TransactionReceipt, 'status' | 'logs'>, expected: { asset: Address; payer: Address; payTo: Address; amount: bigint }): boolean {
  if (receipt.status !== 'success') return false
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).some((log) => isAddressEqual(log.address, expected.asset) && isAddressEqual(log.args.from, expected.payer) && isAddressEqual(log.args.to, expected.payTo) && log.args.value === expected.amount)
}

function refusalReason(response: Response, body: string): string {
  if (response.status === 402) {
    const parsed = safeJson(body) as { error?: unknown; reason?: unknown } | undefined
    const reason = typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.reason === 'string' ? parsed.reason : undefined
    return reason ? `The API did not accept the payment: ${reason}.` : 'The API did not accept the payment, so nothing was charged.'
  }
  return `The API answered with status ${response.status}. If your wallet signed a payment, it is only valid for a short time and the API did not collect it.`
}

function networkMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'The API did not answer in time.'
  return 'Could not reach the API. It may be offline, or it does not allow requests from a browser (CORS).'
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
