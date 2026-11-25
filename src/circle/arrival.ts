import { createPublicClient, erc20Abi, fallback, http, isAddressEqual, parseAbiItem, parseEventLogs, zeroAddress, type Address, type Hex } from 'viem'
import { USDC } from '@/chain'
import { backoffDelay, sleep } from '@/lib/backoff'
import { getArcClient } from '@/lib/rpc'

/**
 * Proof that USDC really arrived on Arc. A Circle SDK result is a claim; these helpers read Arc itself.
 * Nothing is marked successful until one of them returns `verified`.
 */

export type ArrivalResult =
  | { state: 'verified'; hash: Hex; received: bigint }
  /** Arc answered, and the expected mint is not there (yet, or at all). */
  | { state: 'not_found'; reason: string }
  /** Arc could not be read right now. This says nothing about the transfer. */
  | { state: 'unavailable' }

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const MINT_SCAN_BLOCKS = 4_999n
const CLOCK_SKEW_SECONDS = 120

/** Reads one Arc transaction and checks that it credited USDC to the recipient. `maxAmount` is a raw 6-decimal ceiling. */
export async function verifyArcMintByHash(input: { hash: Hex; recipient: Address; maxAmount: bigint }): Promise<ArrivalResult> {
  try {
    const receipt = await getArcClient().getTransactionReceipt({ hash: input.hash })
    if (receipt.status !== 'success') return { state: 'not_found', reason: 'The mint transaction on Arc reverted.' }
    const credited = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
      .filter((log) => isAddressEqual(log.address, USDC.address) && isAddressEqual(log.args.to, input.recipient))
      .reduce((sum, log) => sum + log.args.value, 0n)
    if (credited <= 0n) return { state: 'not_found', reason: 'The transaction succeeded but it did not credit USDC to your address.' }
    if (credited > input.maxAmount) return { state: 'not_found', reason: 'The credited amount is larger than the amount you bridged, so it is not this transfer.' }
    return { state: 'verified', hash: input.hash, received: credited }
  } catch {
    return { state: 'unavailable' }
  }
}

const MAX_SCAN_WINDOWS = 6
const SCAN_GAP_MS = 1_000

/**
 * When no mint transaction hash is known (Circle's forwarding service submits it), look for the newest USDC mint
 * to the recipient on Arc that happened after the transfer started and is not larger than the amount. It scans back
 * in 5,000-block windows, paced like the activity scan, until it passes the moment the transfer started.
 */
export async function findArcMintSince(input: { recipient: Address; maxAmount: bigint; sinceMs: number }): Promise<ArrivalResult> {
  const none: ArrivalResult = { state: 'not_found', reason: 'No mint to your address on Arc since this transfer started.' }
  try {
    const client = getArcClient()
    const head = await client.getBlockNumber()
    const sinceSeconds = BigInt(Math.floor(input.sinceMs / 1000) - CLOCK_SKEW_SECONDS)
    for (let window = 0; window < MAX_SCAN_WINDOWS; window++) {
      const to = head - BigInt(window) * (MINT_SCAN_BLOCKS + 1n)
      if (to < 0n) return none
      const from = to > MINT_SCAN_BLOCKS ? to - MINT_SCAN_BLOCKS : 0n
      if (window > 0) await sleep(SCAN_GAP_MS)
      const logs = await client.getLogs({ address: USDC.address, event: transferEvent, args: { from: zeroAddress, to: input.recipient }, fromBlock: from, toBlock: to })
      for (const log of [...logs].reverse()) {
        const value = log.args.value ?? 0n
        if (value <= 0n || value > input.maxAmount || log.transactionHash === null || log.blockNumber === null) continue
        const block = await client.getBlock({ blockNumber: log.blockNumber })
        if (block.timestamp < sinceSeconds) return none
        return { state: 'verified', hash: log.transactionHash, received: value }
      }
      if (from === 0n) return none
      // Stop once this window already starts before the transfer did.
      const start = await client.getBlock({ blockNumber: from })
      if (start.timestamp < sinceSeconds) return none
    }
    return { state: 'not_found', reason: 'No mint found in the recent blocks searched. If the transfer is older than a few hours, open the Arc explorer for your address.' }
  } catch {
    return { state: 'unavailable' }
  }
}

/** Polls with backoff for a while: Arc can lag the attestation by a few seconds. Stops early on anything but not_found. */
export async function waitForArcArrival(check: () => Promise<ArrivalResult>, attempts = 6): Promise<ArrivalResult> {
  let last: ArrivalResult = { state: 'unavailable' }
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await check()
    if (last.state === 'verified') return last
    if (attempt < attempts - 1) await sleep(backoffDelay(attempt + 1))
  }
  return last
}

/** Reads a deposit transaction on a source chain from that chain's own public endpoints. */
export async function verifyTxOnChain(input: { rpcEndpoints: readonly string[]; hash: Hex }): Promise<'success' | 'reverted' | 'unavailable'> {
  try {
    const client = createPublicClient({ transport: fallback(input.rpcEndpoints.map((url) => http(url, { timeout: 10_000 }))) })
    const receipt = await client.getTransactionReceipt({ hash: input.hash })
    return receipt.status === 'success' ? 'success' : 'reverted'
  } catch {
    return 'unavailable'
  }
}
