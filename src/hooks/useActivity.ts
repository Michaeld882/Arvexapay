import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { parseAbiItem, type Address } from 'viem'
import { ARC_CHAIN_ID, ARVEXA_ADDRESS, ARVEXA_DEPLOY_BLOCK, USDC } from '@/chain'
import {
  buildActivity,
  sortActivity,
  mergeLocalTxs,
  type ActivityItem,
  type TransferLogLike,
  type VaultLogLike,
} from '@/lib/activity'
import { backoffDelay, sleep } from '@/lib/backoff'
import { classifyError, isTransientError } from '@/lib/errors'
import { getArcClient } from '@/lib/rpc'
import { readLocalTxs, updateLocalTxStatus, useLocalTxs } from '@/lib/txLog'

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const depositedEvent = parseAbiItem('event Deposited(address indexed account, uint256 amount, uint256 newBalance)')
const withdrawnEvent = parseAbiItem('event Withdrawn(address indexed account, address indexed to, uint256 amount, uint256 newBalance)')

// Measured against the Arc Mainnet RPC: 5,000 blocks per getLogs call is accepted, 10,000 is rejected.
const INITIAL_WINDOW = 5_000n
const MIN_WINDOW = 500n
const FIRST_PAGE_WINDOWS = 4
const NEXT_PAGE_WINDOWS = 8
// Measured: the public RPC rate limits eth_getLogs when windows are scanned faster than about one per
// second (8 of 8 windows failed at 0 ms spacing, none at 1,000 ms). Pace the scan instead of failing and retrying.
const MIN_GAP_MS = 900
let lastScanAt = 0
const WINDOW_RETRIES = 3
const PARALLEL_WINDOWS = 1
const ENOUGH_ITEMS = 15

/** Largest block range the RPC accepted this session. Learned by halving on range errors. */
let windowSize = INITIAL_WINDOW
const blockTimes = new Map<bigint, number>()

interface ActivityPage {
  items: ActivityItem[]
  fromBlock: bigint
  toBlock: bigint
  head: bigint
  /** True when a later window failed; older activity can still be loaded with Load older. */
  incomplete: boolean
  /** True for an interim page published while the rest of the first scan is still running. */
  partial?: boolean
}

function looksLikeRangeError(err: unknown): boolean {
  const app = classifyError(err)
  if (app.kind === 'rpc_rate_limited') return false
  return /range|too (large|many|big)|more than|response size|results|-32012/i.test(app.detail)
}

async function scanWindow(user: Address, fromBlock: bigint, toBlock: bigint) {
  const client = getArcClient()
  const range = { fromBlock, toBlock }
  const vault = ARVEXA_ADDRESS
  const vaultFrom = ARVEXA_DEPLOY_BLOCK && ARVEXA_DEPLOY_BLOCK > fromBlock ? ARVEXA_DEPLOY_BLOCK : fromBlock
  const scanVault = Boolean(vault) && vaultFrom <= toBlock

  const [sent, received, deposits, withdrawals] = await Promise.all([
    client.getLogs({ address: USDC.address, event: transferEvent, args: { from: user }, ...range }),
    client.getLogs({ address: USDC.address, event: transferEvent, args: { to: user }, ...range }),
    scanVault
      ? client.getLogs({ address: vault, event: depositedEvent, args: { account: user }, fromBlock: vaultFrom, toBlock })
      : Promise.resolve([]),
    scanVault
      ? client.getLogs({ address: vault, event: withdrawnEvent, args: { account: user }, fromBlock: vaultFrom, toBlock })
      : Promise.resolve([]),
  ])

  const transfers = new Map<string, TransferLogLike>()
  for (const log of [...sent, ...received]) {
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue
    transfers.set(`${log.transactionHash}:${log.logIndex}`, {
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      from: log.args.from as Address,
      to: log.args.to as Address,
      value: log.args.value as bigint,
    })
  }

  const vaultLogs: VaultLogLike[] = []
  for (const log of deposits) {
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue
    vaultLogs.push({
      kind: 'deposit',
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      account: log.args.account as Address,
      amount: log.args.amount as bigint,
    })
  }
  for (const log of withdrawals) {
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue
    vaultLogs.push({
      kind: 'withdraw',
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      account: log.args.account as Address,
      to: log.args.to,
      amount: log.args.amount as bigint,
    })
  }
  return { transfers: [...transfers.values()], vaultLogs }
}

/**
 * Scans up to `count` consecutive windows in parallel (the transport merges them into one HTTP
 * request). Halves the window when the RPC rejects the range, and retries transient failures
 * with backoff instead of restarting the whole scan.
 */
async function scanStep(user: Address, toBlock: bigint, count: number, signal: AbortSignal) {
  let transientFailures = 0
  for (;;) {
    signal.throwIfAborted()
    const wait = lastScanAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    signal.throwIfAborted()
    lastScanAt = Date.now()
    const ranges: Array<{ from: bigint; to: bigint }> = []
    let end = toBlock
    while (ranges.length < count && end >= 0n) {
      const from = end >= windowSize ? end - windowSize + 1n : 0n
      ranges.push({ from, to: end })
      if (from === 0n) break
      end = from - 1n
    }
    try {
      const results = await Promise.all(ranges.map((range) => scanWindow(user, range.from, range.to)))
      return { fromBlock: ranges[ranges.length - 1].from, results }
    } catch (err) {
      if (windowSize > MIN_WINDOW && looksLikeRangeError(err)) {
        windowSize = windowSize / 2n > MIN_WINDOW ? windowSize / 2n : MIN_WINDOW
        continue
      }
      if (isTransientError(err) && transientFailures < WINDOW_RETRIES) {
        await sleep(backoffDelay(transientFailures++))
        continue
      }
      throw err
    }
  }
}

async function attachTimestamps(items: ActivityItem[]): Promise<void> {
  const client = getArcClient()
  const missing = [...new Set(items.map((item) => item.blockNumber))].filter(
    (block): block is bigint => block !== undefined && !blockTimes.has(block),
  )
  await Promise.all(
    missing.map(async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber })
        blockTimes.set(blockNumber, Number(block.timestamp))
      } catch {
        // A missing timestamp is shown as a block number; it never blocks the list.
      }
    }),
  )
  for (const item of items) {
    if (item.blockNumber !== undefined) item.timestamp = blockTimes.get(item.blockNumber)
  }
}

async function loadPage(
  user: Address,
  cursor: bigint | undefined,
  signal: AbortSignal,
  onPartial?: (page: ActivityPage) => void,
): Promise<ActivityPage> {
  const head = cursor === undefined ? await getArcClient().getBlockNumber() : cursor
  const maxWindows = cursor === undefined ? FIRST_PAGE_WINDOWS : NEXT_PAGE_WINDOWS
  let toBlock = head
  let fromBlock = head + 1n
  let incomplete = false
  let scannedWindows = 0
  const items: ActivityItem[] = []
  while (scannedWindows < maxWindows && toBlock >= 0n) {
    try {
      const step = await scanStep(user, toBlock, Math.min(PARALLEL_WINDOWS, maxWindows - scannedWindows), signal)
      for (const logs of step.results) items.push(...buildActivity(user, ARVEXA_ADDRESS, logs.transfers, logs.vaultLogs))
      scannedWindows += step.results.length
      fromBlock = step.fromBlock
    } catch (err) {
      // Keep what was found. Only fail the page if nothing at all could be scanned (or it was cancelled).
      if (scannedWindows === 0 || signal.aborted) throw err
      incomplete = true
      break
    }
    if (fromBlock === 0n || items.length >= ENOUGH_ITEMS) break
    toBlock = fromBlock - 1n
    // Show what the first window found right away instead of waiting for every window to be scanned.
    if (onPartial && items.length > 0 && scannedWindows < maxWindows) {
      const interim = sortActivity([...items])
      await attachTimestamps(interim)
      if (signal.aborted) break
      onPartial({ items: interim, fromBlock, toBlock: head, head, incomplete: false, partial: true })
    }
  }
  signal.throwIfAborted()
  await attachTimestamps(sortActivity(items))
  return { items: sortActivity(items), fromBlock, toBlock: head, head, incomplete }
}

const reconciled = new Set<string>()

/**
 * A transaction this app submitted can stay "pending" locally if the page was closed before its
 * receipt arrived. Read each receipt once per session and settle the local record from the chain.
 */
async function reconcilePending(owner: string, hashes: readonly `0x${string}`[]): Promise<void> {
  const client = getArcClient()
  for (const hash of hashes) {
    if (reconciled.has(hash)) continue
    reconciled.add(hash)
    try {
      const receipt = await client.getTransactionReceipt({ hash })
      updateLocalTxStatus(owner, hash, receipt.status === 'success' ? 'success' : 'failed')
    } catch {
      reconciled.delete(hash) // not mined yet, or the RPC is unavailable: try again next session
    }
  }
}

/** Real activity from USDC Transfer logs and Arvexa vault events, newest first, loaded on demand. */
export function useActivity(user: Address | undefined) {
  const localTxs = useLocalTxs(user)
  const queryClient = useQueryClient()
  const queryKey = ['arvexa', 'activity', ARC_CHAIN_ID, ARVEXA_ADDRESS, user]
  const query = useInfiniteQuery({
    queryKey,
    enabled: Boolean(user),
    staleTime: 60_000,
    initialPageParam: undefined as bigint | undefined,
    queryFn: ({ pageParam, signal }) =>
      loadPage(
        user as Address,
        pageParam,
        signal,
        // Only the very first load publishes interim results; a refetch keeps the pages already shown.
        pageParam === undefined && queryClient.getQueryData(queryKey) === undefined
          ? (page) => queryClient.setQueryData(queryKey, { pages: [page], pageParams: [undefined] }, { updatedAt: 0 })
          : undefined,
      ),
    getNextPageParam: (last) => (last.fromBlock > 0n ? last.fromBlock - 1n : undefined),
  })

  const pendingKey = localTxs.filter((tx) => tx.status === 'pending').map((tx) => tx.hash).join(',')
  // While something is waiting for Arc to confirm it, keep asking the chain for its receipt (reading only) so the
  // status moves from Submitted to Confirmed on its own. Stops as soon as nothing is pending.
  useEffect(() => {
    if (!user || !pendingKey) return
    const hashes = pendingKey.split(',') as `0x${string}`[]
    const stop = new AbortController()
    const run = async () => {
      await reconcilePending(user, hashes)
      if (stop.signal.aborted) return
      if (readLocalTxs(user).some((tx) => hashes.includes(tx.hash) && tx.status !== 'pending')) void queryClient.invalidateQueries({ queryKey: ['arvexa'] })
    }
    void run()
    const timer = setInterval(() => void run(), 8000)
    return () => {
      stop.abort()
      clearInterval(timer)
    }
  }, [user, pendingKey, queryClient])

  const items = useMemo(() => {
    const onchain = (query.data?.pages ?? []).flatMap((page) => page.items)
    return mergeLocalTxs(onchain, localTxs)
  }, [query.data, localTxs])

  const pages = query.data?.pages ?? []
  const oldest = pages.length ? pages[pages.length - 1].fromBlock : undefined
  const head = pages.length ? pages[0].head : undefined

  return {
    items,
    isLoading: query.isPending && Boolean(user),
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    hasMore: query.hasNextPage && !pages.some((page) => page.partial),
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    refresh: () => void queryClient.resetQueries({ queryKey: ['arvexa', 'activity'] }),
    oldestScannedBlock: oldest,
    headBlock: head,
    hasWindowData: pages.length > 0,
    incomplete: pages.some((page) => page.incomplete),
  }
}
