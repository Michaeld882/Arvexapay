import { erc20Abi, getAddress, isAddressEqual, parseAbiItem, parseEventLogs, type Address, type Hex } from 'viem'
import { USDC } from '@/chain'
import { sleep } from '@/lib/backoff'
import { applySettlement, readRequests, type PaidInfo, type PaymentRequest } from '@/lib/payments/requests'
import { getArcClient } from '@/lib/rpc'
import { formatUsdcDisplay } from '@/lib/format'

/**
 * Finding out whether a request was really paid. USDC transfers carry no memo, so a payment is matched by what the
 * chain does record: it went to the requester's wallet, for exactly the requested amount, in a block at or after the
 * request was created (and, for a split share with a known address, from that address). When two open requests ask for
 * the same amount, the older request takes the earlier transfer. Each transfer can settle only one request. Nothing is
 * ever marked paid without a real transfer found on Arc Mainnet.
 */
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

export interface IncomingTransfer {
  hash: Hex
  logIndex: number
  from: Address
  value: bigint
  blockNumber: bigint
}

export const claimKey = (hash: string, logIndex: number) => `${hash.toLowerCase()}:${logIndex}`

/** Transfers already used to settle a request. */
export function claimedKeys(requests: readonly PaymentRequest[]): Set<string> {
  const keys = new Set<string>()
  for (const request of requests) if (request.paid) keys.add(claimKey(request.paid.hash, request.paid.logIndex ?? 0))
  return keys
}

/** Pure matching of open requests to incoming transfers. Used by the live search and tested on its own. */
export function matchPayments(pending: readonly PaymentRequest[], transfers: readonly IncomingTransfer[], claimed: ReadonlySet<string> = new Set()): Map<string, IncomingTransfer> {
  const used = new Set(claimed)
  const result = new Map<string, IncomingTransfer>()
  const requests = [...pending].sort((a, b) => a.createdAt - b.createdAt)
  const ordered = [...transfers].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
  for (const request of requests) {
    const amount = BigInt(request.amount)
    const since = request.createdBlock ? BigInt(request.createdBlock) : 0n
    const hit = ordered.find(
      (transfer) =>
        !used.has(claimKey(transfer.hash, transfer.logIndex)) &&
        transfer.value === amount &&
        transfer.blockNumber >= since &&
        !isAddressEqual(transfer.from, request.to) &&
        (!request.payer || isAddressEqual(transfer.from, request.payer)),
    )
    if (hit) {
      used.add(claimKey(hit.hash, hit.logIndex))
      result.set(request.id, hit)
    }
  }
  return result
}

const WINDOW = 5000n
const MAX_WINDOWS = 24
const LOOKBACK = 60_000n
const EXPIRED_GRACE_SECONDS = 3600

export interface SyncResult {
  checked: number
  newlyPaid: number
  /** True when the search reached the latest block. False means it will continue on the next check. */
  caughtUp: boolean
  head?: bigint
}

async function blockTimestamp(blockNumber: bigint, cache: Map<bigint, number>): Promise<number | undefined> {
  const known = cache.get(blockNumber)
  if (known !== undefined) return known
  try {
    const block = await getArcClient().getBlock({ blockNumber })
    cache.set(blockNumber, Number(block.timestamp))
    return Number(block.timestamp)
  } catch {
    return undefined
  }
}

/**
 * Reads new Arc blocks for USDC sent to `owner` and settles the open requests it can match. It only reads: it never
 * signs or sends anything. Each call continues from where the last one stopped.
 */
export async function syncPayments(owner: Address, nowSeconds = Math.floor(Date.now() / 1000), signal?: AbortSignal): Promise<SyncResult> {
  const all = readRequests(owner)
  const open = all.filter((request) => !request.paid && !request.cancelled && (request.expiresAt === undefined || nowSeconds - request.expiresAt < EXPIRED_GRACE_SECONDS))
  if (open.length === 0) return { checked: 0, newlyPaid: 0, caughtUp: true }

  const client = getArcClient()
  const head = await client.getBlockNumber()
  const startOf = (request: PaymentRequest): bigint => (request.scannedTo ? BigInt(request.scannedTo) + 1n : request.createdBlock ? BigInt(request.createdBlock) : head > LOOKBACK ? head - LOOKBACK : 0n)
  let from = open.map(startOf).reduce((lowest, value) => (value < lowest ? value : lowest))

  const transfers: IncomingTransfer[] = []
  let scanned = from - 1n
  for (let window = 0; window < MAX_WINDOWS && from <= head; window++) {
    signal?.throwIfAborted()
    const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n
    if (window > 0) await sleep(500)
    const logs = await client.getLogs({ address: USDC.address, event: TRANSFER, args: { to: owner }, fromBlock: from, toBlock: to })
    for (const log of logs) {
      if (log.args.from === undefined || log.args.value === undefined || log.blockNumber === null || log.logIndex === null) continue
      transfers.push({ hash: log.transactionHash, logIndex: log.logIndex, from: getAddress(log.args.from), value: log.args.value, blockNumber: log.blockNumber })
    }
    scanned = to
    from = to + 1n
  }

  const matches = matchPayments(open, transfers, claimedKeys(all))
  const times = new Map<bigint, number>()
  const paid = new Map<string, PaidInfo>()
  for (const [id, transfer] of matches) {
    const request = open.find((candidate) => candidate.id === id)
    const timestamp = await blockTimestamp(transfer.blockNumber, times)
    // A payment that arrived after the request expired does not count as paying it.
    if (request?.expiresAt !== undefined && timestamp !== undefined && timestamp > request.expiresAt) continue
    paid.set(id, { hash: transfer.hash, from: transfer.from, amount: transfer.value.toString(), timestamp, blockNumber: transfer.blockNumber.toString(), logIndex: transfer.logIndex, verifiedAt: nowSeconds })
  }
  const scannedTo = new Map(open.map((request) => [request.id, scanned] as const))
  applySettlement(owner, paid, scannedTo)
  return { checked: open.length, newlyPaid: paid.size, caughtUp: scanned >= head, head }
}

export type HashCheck = { ok: true; paid: PaidInfo } | { ok: false; message: string }

/** Settles one request from a transaction hash you give, after reading that transaction from Arc. Read only. */
export async function verifyPaymentByHash(owner: Address, request: PaymentRequest, hashInput: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<HashCheck> {
  const hash = hashInput.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { ok: false, message: 'Enter a full transaction hash: 0x followed by 64 characters.' }
  if (request.paid) return { ok: false, message: 'This request is already paid.' }
  const client = getArcClient()
  let receipt
  try {
    receipt = await client.getTransactionReceipt({ hash: hash as Hex })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name.includes('NotFound')) return { ok: false, message: 'That transaction was not found on Arc Mainnet yet.' }
    return { ok: false, message: 'Arc could not be reached to read that transaction. Try again in a moment.' }
  }
  if (receipt.status !== 'success') return { ok: false, message: 'That transaction failed onchain, so no payment was made.' }
  const amount = BigInt(request.amount)
  const claimed = claimedKeys(readRequests(owner))
  const hit = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).find(
    (log) =>
      isAddressEqual(log.address, USDC.address) &&
      isAddressEqual(log.args.to, request.to) &&
      log.args.value === amount &&
      !isAddressEqual(log.args.from, request.to) &&
      (!request.payer || isAddressEqual(log.args.from, request.payer)),
  )
  if (!hit) return { ok: false, message: `No transfer of ${formatUsdcDisplay(amount)} USDC to this wallet was found in that transaction.` }
  if (claimed.has(claimKey(hash, hit.logIndex))) return { ok: false, message: 'That payment was already used for another request.' }
  if (request.createdBlock && receipt.blockNumber < BigInt(request.createdBlock)) return { ok: false, message: 'That payment was made before this request was created.' }
  const timestamp = await blockTimestamp(receipt.blockNumber, new Map())
  if (request.expiresAt !== undefined && timestamp !== undefined && timestamp > request.expiresAt) return { ok: false, message: 'That payment arrived after this request expired.' }
  const paid: PaidInfo = { hash: hash as Hex, from: getAddress(hit.args.from), amount: amount.toString(), timestamp, blockNumber: receipt.blockNumber.toString(), logIndex: hit.logIndex, verifiedAt: nowSeconds }
  applySettlement(owner, new Map([[request.id, paid]]), new Map())
  return { ok: true, paid }
}
