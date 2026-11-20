import { QueryClient } from '@tanstack/react-query'
import { backoffDelay } from '@/lib/backoff'
import { isTransientError } from '@/lib/errors'

export const MAX_READ_RETRIES = 2

/** Retry rule for reads: only transient RPC failures, at most MAX_READ_RETRIES times. */
export const shouldRetryRead = (failureCount: number, error: unknown): boolean =>
  failureCount < MAX_READ_RETRIES && isTransientError(error)

/** Shared QueryClient: dedupes by key, caches 30s, retries transient read failures only. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: shouldRetryRead,
        retryDelay: (attempt) => backoffDelay(attempt),
      },
      mutations: { retry: false },
    },
  })
}
