/**
 * Circle integration configuration. The ONLY place the Circle layer reads environment variables.
 *
 * Everything here is public and shipped to the browser (VITE_ prefix). Secrets (Circle API keys, entity
 * secrets, CPN credentials, private keys) never belong in a VITE_ variable: they live on a server you run.
 *
 * Contract addresses are deliberately NOT duplicated here. USDC on Arc comes from `@/chain`, and the CCTP and
 * Gateway contract addresses come from Circle's own SDK chain registry at runtime, so they cannot drift.
 */

import { ARC_CHAIN_ID } from '@/chain'

const env = import.meta.env as Record<string, string | undefined>

function flag(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim()
  if (!value) return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

function httpsUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : undefined
  } catch {
    return undefined
  }
}

function list(raw: string | undefined): string[] | undefined {
  const items = raw
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items && items.length > 0 ? items : undefined
}

export type TransferSpeed = 'FAST' | 'SLOW'

export const CIRCLE_CONFIG = {
  /** Arvexa settles on Arc Mainnet, so Circle calls use mainnet routes. */
  networkType: 'mainnet' as const,
  arcChainId: ARC_CHAIN_ID,
  /** Circle SDK identifier for Arc Mainnet. */
  arcIdentifier: 'Arc' as const,
  cctpEnabled: flag(env.VITE_CIRCLE_CCTP_ENABLED, true),
  gatewayEnabled: flag(env.VITE_CIRCLE_GATEWAY_ENABLED, true),
  /** FAST completes in seconds and may carry a fee; SLOW waits for source-chain finality. */
  transferSpeed: (env.VITE_CIRCLE_CCTP_SPEED?.trim().toUpperCase() === 'SLOW' ? 'SLOW' : 'FAST'),
  /** Let Circle submit the Arc mint, so a first-time user needs no USDC for gas on Arc. */
  useForwarder: flag(env.VITE_CIRCLE_CCTP_FORWARDER, true),
  /** Optional allow-list of source chain identifiers (for example "Ethereum,Base"). Empty means every supported chain. */
  sourceChains: list(env.VITE_CIRCLE_CCTP_SOURCE_CHAINS),
  /** A larger transfer shows an extra warning before it can be started. */
  largeTransferUsdc: Number(env.VITE_CIRCLE_LARGE_TRANSFER_USDC) > 0 ? Number(env.VITE_CIRCLE_LARGE_TRANSFER_USDC) : 100,
  /**
   * Base URL of YOUR backend that holds Circle Payments Network credentials. Never a Circle API key.
   * Circle Payments Network access is granted by Circle, so this stays empty until you have it.
   */
  cpnApiUrl: httpsUrl(env.VITE_CPN_API_URL),
} as const
