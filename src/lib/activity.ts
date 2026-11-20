import { isAddressEqual, type Address, type Hex } from 'viem'
import type { LocalTx } from '@/lib/txLog'

export type ActivityKind = 'send' | 'receive' | 'deposit' | 'withdraw' | 'swap' | 'approve'
export type ActivityStatus = 'confirmed' | 'pending' | 'failed' | 'unverified'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  hash: Hex
  /** Undefined only for transactions this app submitted that are not yet indexed in a scanned range. */
  blockNumber?: bigint
  logIndex?: number
  timestamp?: number
  /** Raw 6-decimal USDC base units. */
  amount: bigint
  counterparty?: Address
  token: 'USDC'
  status: ActivityStatus
}

export interface TransferLogLike {
  transactionHash: Hex
  blockNumber: bigint
  logIndex: number
  from: Address
  to: Address
  value: bigint
}

export interface VaultLogLike {
  kind: 'deposit' | 'withdraw'
  transactionHash: Hex
  blockNumber: bigint
  logIndex: number
  account: Address
  to?: Address
  amount: bigint
}

/**
 * Turns raw logs into user-facing activity. Logs only exist for successful transactions,
 * so every item produced here is confirmed. A vault deposit or withdrawal already moves USDC,
 * so its USDC Transfer log is folded into one item instead of appearing twice.
 */
export function buildActivity(
  user: Address,
  vault: Address | undefined,
  transfers: readonly TransferLogLike[],
  vaultLogs: readonly VaultLogLike[],
): ActivityItem[] {
  const vaultTxs = new Set<string>(vaultLogs.map((log) => log.transactionHash))
  const items = new Map<string, ActivityItem>()

  for (const log of vaultLogs) {
    const id = `${log.transactionHash}:${log.logIndex}`
    items.set(id, {
      id,
      kind: log.kind,
      hash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      amount: log.amount,
      counterparty: log.kind === 'deposit' ? vault : log.to,
      token: 'USDC',
      status: 'confirmed',
    })
  }

  for (const log of transfers) {
    if (vaultTxs.has(log.transactionHash)) continue
    const outgoing = isAddressEqual(log.from, user)
    const id = `${log.transactionHash}:${log.logIndex}`
    items.set(id, {
      id,
      kind: outgoing ? 'send' : 'receive',
      hash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      amount: log.value,
      counterparty: outgoing ? log.to : log.from,
      token: 'USDC',
      status: 'confirmed',
    })
  }

  return sortActivity([...items.values()])
}

export function sortActivity(items: ActivityItem[]): ActivityItem[] {
  return items.sort((a, b) => {
    if (a.blockNumber === undefined && b.blockNumber === undefined) return 0
    if (a.blockNumber === undefined) return -1
    if (b.blockNumber === undefined) return 1
    if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1
    return (b.logIndex ?? 0) - (a.logIndex ?? 0)
  })
}

const LOCAL_STATUS: Record<LocalTx['status'], ActivityStatus> = {
  pending: 'pending',
  success: 'confirmed',
  failed: 'failed',
  unverified: 'unverified',
}

/**
 * Merges transactions this app submitted. Onchain logs win for amounts and ordering;
 * the local record contributes status, and covers pending or failed transactions,
 * which have no logs.
 */
export function mergeLocalTxs(onchain: readonly ActivityItem[], local: readonly LocalTx[]): ActivityItem[] {
  const seen = new Set(onchain.map((item) => item.hash))
  const pendingFirst: ActivityItem[] = []
  const merged = onchain.map((item) => {
    const record = local.find((tx) => tx.hash === item.hash)
    return record && record.status === 'unverified' ? { ...item, status: 'unverified' as const } : item
  })
  for (const tx of local) {
    if (seen.has(tx.hash)) continue
    pendingFirst.push({
      id: `local:${tx.hash}`,
      kind: tx.kind,
      hash: tx.hash,
      timestamp: tx.createdAt,
      amount: BigInt(tx.amount),
      counterparty: tx.to,
      token: 'USDC',
      status: LOCAL_STATUS[tx.status],
    })
  }
  pendingFirst.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  return [...pendingFirst, ...merged]
}
