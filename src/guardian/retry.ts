import { backoffDelay, sleep } from '@/lib/backoff'
import { classifyError, isTransientError } from '@/lib/errors'

/**
 * Read-only RPC helpers. These are for READS ONLY. A transaction that was handed to a wallet is never retried here:
 * the caller checks the hash's status first (see `lock.ts` and the flow hook).
 */

export interface RetryOptions {
  /** Total tries, first one included. Kept small so a rate-limited endpoint is not hammered. */
  attempts?: number
  /** Wait before try number `attempt` (1-based count of failures so far). Injected so tests do not sleep. */
  wait?: (attempt: number, rateLimited: boolean) => Promise<void>
  shouldRetry?: (err: unknown) => boolean
}

const defaultWait = (attempt: number, rateLimited: boolean): Promise<void> =>
  // A 429 is a request to slow down: wait at least two seconds before the next try.
  sleep(Math.max(backoffDelay(attempt - 1), rateLimited ? 2_000 : 0))

/** Runs a read, retrying only transient RPC failures (timeout, unavailable, rate limited) with exponential backoff. */
export async function retryRead<T>(read: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const wait = options.wait ?? defaultWait
  const shouldRetry = options.shouldRetry ?? isTransientError
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read()
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err
      await wait(attempt, classifyError(err).kind === 'rpc_rate_limited')
    }
  }
}

interface Entry {
  at: number
  value: Promise<unknown>
}

const cache = new Map<string, Entry>()

/**
 * Deduplicates and briefly caches a read. Two callers asking for the same key at once share one request, and a
 * recent answer is reused for `ttlMs`. A failed read is never cached, so the next call tries again.
 */
export function dedupedRead<T>(key: string, ttlMs: number, read: () => Promise<T>, options: { fresh?: boolean; now?: () => number } = {}): Promise<T> {
  const now = (options.now ?? Date.now)()
  const hit = cache.get(key)
  if (hit && !options.fresh && now - hit.at < ttlMs) return hit.value as Promise<T>
  const value = read()
  const entry: Entry = { at: now, value }
  cache.set(key, entry)
  value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return value
}

export function clearReadCache(): void {
  cache.clear()
}
