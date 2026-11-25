import { classifyError } from '@/lib/errors'

/**
 * Friendly text for an error thrown by the Circle SDK or the wallet. Known wallet and RPC failures use the app's
 * shared messages; an SDK error keeps its own message, which says what Circle rejected (route, amount, fee).
 */
export function describeCircleError(err: unknown): string {
  const app = classifyError(err)
  if (app.kind !== 'unknown') return app.message
  const message = err instanceof Error ? err.message : String(err)
  const trimmed = message.replace(/\s+/g, ' ').trim()
  return trimmed ? (trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed) : app.message
}

/** True when retrying the same call could succeed (network trouble), not when the user or the route said no. */
export function isRetryableCircleError(err: unknown): boolean {
  const kind = classifyError(err).kind
  return kind === 'rpc_unavailable' || kind === 'rpc_timeout' || kind === 'rpc_rate_limited'
}
