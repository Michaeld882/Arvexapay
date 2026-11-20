/**
 * wagmi configuration for Arvexa (Arc Mainnet only).
 * Chain, RPC and contract values come from `@/config/chain`.
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { ARC_CHAIN_ID, ARC_RPC_URL, arcMainnet } from './chain'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(ARC_CHAIN_ID, ARC_RPC_URL)

export const RPC_TIMEOUT_MS = 10_000

export const config = createConfig({
  chains: [arcMainnet],
  connectors: [injected()],
  transports: {
    // JSON-RPC batching merges same-tick reads into one HTTP request.
    // Retries are limited to transport-level failures (timeouts, 429, 5xx).
    [ARC_CHAIN_ID]: http(ARC_RPC_URL, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: 2,
      retryDelay: 500,
      batch: { wait: 25, batchSize: 50 },
    }),
  },
})
export default config
