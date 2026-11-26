import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { ARC_CHAIN_ID } from '@/chain'
import { useActivity } from '@/hooks/useActivity'
import { useNow } from '@/hooks/useNow'
import { buildLedger, computeOverview } from '@/lib/payments/ledger'
import { statusOf, useRequests } from '@/lib/payments/requests'
import { syncPayments } from '@/lib/payments/settle'
import { useTxMetas } from '@/lib/txMeta'

/**
 * Keeps open requests up to date with the chain: while any request is waiting, it reads new Arc blocks every 15
 * seconds for a matching USDC payment (reading only). It stops when nothing is waiting.
 */
export function usePaymentSync(owner: Address | undefined) {
  const requests = useRequests(owner)
  const nowSeconds = Math.floor(useNow(60_000) / 1000)
  const waiting = requests.some((request) => ['pending'].includes(statusOf(request, nowSeconds)))
  const query = useQuery({
    queryKey: ['arvexa', 'payment-sync', ARC_CHAIN_ID, owner],
    enabled: Boolean(owner) && waiting,
    queryFn: ({ signal }) => syncPayments(owner as Address, Math.floor(Date.now() / 1000), signal),
    refetchInterval: 15_000,
    staleTime: 8_000,
  })
  return {
    waiting,
    isChecking: query.isFetching,
    error: query.error,
    isError: query.isError,
    caughtUp: query.data?.caughtUp,
    checkedAt: query.dataUpdatedAt || undefined,
    checkNow: () => void query.refetch(),
  }
}

/** Everything the payment screens show: real activity, your requests, and the numbers derived from them. */
export function usePaymentsData(owner: Address | undefined) {
  const activity = useActivity(owner)
  const requests = useRequests(owner)
  const metas = useTxMetas(owner)
  const sync = usePaymentSync(owner)
  const nowSeconds = Math.floor(useNow(60_000) / 1000)
  const ledger = useMemo(() => buildLedger(activity.items, requests), [activity.items, requests])
  const overview = useMemo(() => computeOverview(ledger, requests, nowSeconds), [ledger, requests, nowSeconds])
  return { activity, requests, metas, sync, ledger, overview, nowSeconds }
}
