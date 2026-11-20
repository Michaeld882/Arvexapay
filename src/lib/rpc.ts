import { getPublicClient } from 'wagmi/actions'
import type { Hex, TransactionReceipt } from 'viem'
import { config } from '@/config'
import { ARC_CHAIN_ID } from '@/chain'
import { backoffDelay, sleep } from '@/lib/backoff'
import { AppError, classifyError, isTransientError } from '@/lib/errors'

/** The one shared read client. wagmi owns the transport, so retries/batching live in one place. */
export function getArcClient() {
  const client = getPublicClient(config, { chainId: ARC_CHAIN_ID })
  if (!client) throw new AppError('rpc_unavailable', 'No public client for Arc Mainnet')
  return client
}

/**
 * Waits for a transaction receipt without turning a temporary RPC failure into a
 * false "failed" result. Only the READ is retried; the transaction is never resent.
 */
export async function waitForReceipt(hash: Hex, timeoutMs = 180_000): Promise<TransactionReceipt> {
  const client = getArcClient()
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AppError('rpc_timeout', `No receipt for ${hash} within ${Math.round(timeoutMs / 1000)}s`)
    }
    try {
      let replacedReason: string | undefined
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        pollingInterval: 1_500,
        timeout: Math.min(60_000, remaining),
        onReplaced: (info) => {
          replacedReason = info.reason
        },
      })
      if (replacedReason === 'cancelled') throw new AppError('reverted', `Transaction ${hash} was cancelled and replaced`)
      return receipt
    } catch (err) {
      if (err instanceof AppError) throw err
      const app = classifyError(err)
      const keepWaiting = app.kind === 'rpc_timeout' || isTransientError(err)
      if (!keepWaiting) throw err
      await sleep(backoffDelay(attempt++))
    }
  }
}
