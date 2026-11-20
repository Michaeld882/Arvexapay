/**
 * Single source of truth for Arc Mainnet and the Arvexa contract.
 *
 * Every chain ID, RPC URL, explorer URL, USDC address and contract address used
 * anywhere in the app is read from this file. Nothing else defines them.
 *
 * Deployed contract address: set VITE_ARVEXA_CONTRACT_ADDRESS in `.env`
 * (see `.env.example`). Leave it unset until the contract is deployed.
 */

import { defineChain, getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { buildAddressExplorerUrl, buildTxExplorerUrl, getUsdc, requireChain } from '@/onchain-facts'

export const ARC_CHAIN_ID = 5042
export const NETWORK_NAME = 'Arc Mainnet'
export const NETWORK_LABEL = `${NETWORK_NAME} (Chain ID ${ARC_CHAIN_ID})`

const facts = requireChain(ARC_CHAIN_ID)
const usdcFact = getUsdc(ARC_CHAIN_ID)

if (!usdcFact) {
  throw new Error(`USDC is not configured for chain ${ARC_CHAIN_ID}`)
}

function resolveRpcUrl(): string {
  const override = (import.meta.env.VITE_ARC_RPC_URL as string | undefined)?.trim()
  if (override) {
    try {
      const url = new URL(override)
      if (url.protocol === 'https:') return url.toString()
    } catch {
      // fall through to the registry URL
    }
  }
  return facts.rpcUrls[0]
}

export const ARC_RPC_URL = resolveRpcUrl()
export const ARC_EXPLORER_URL = facts.explorerBase

export const arcMainnet = defineChain({
  id: ARC_CHAIN_ID,
  name: NETWORK_NAME,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: facts.nativeCurrency.decimals },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: ARC_EXPLORER_URL } },
})

export const USDC = {
  symbol: 'USDC',
  address: getAddress(usdcFact.address),
  decimals: usdcFact.decimals,
} as const

export const explorerTxUrl = (hash: string): string => buildTxExplorerUrl(ARC_CHAIN_ID, hash)
export const explorerAddressUrl = (address: string): string => buildAddressExplorerUrl(ARC_CHAIN_ID, address)

export type ContractConfig =
  | { status: 'missing' }
  | { status: 'invalid'; raw: string }
  | { status: 'configured'; address: Address }

function readContractConfig(): ContractConfig {
  const raw = (import.meta.env.VITE_ARVEXA_CONTRACT_ADDRESS as string | undefined)?.trim()
  if (!raw) return { status: 'missing' }
  if (!isAddress(raw, { strict: false }) || raw.toLowerCase() === zeroAddress) {
    return { status: 'invalid', raw }
  }
  return { status: 'configured', address: getAddress(raw) }
}

export const ARVEXA = readContractConfig()
export const ARVEXA_ADDRESS: Address | undefined = ARVEXA.status === 'configured' ? ARVEXA.address : undefined

/** Optional lower bound for vault log scans (the block the contract was deployed at). */
function readDeployBlock(): bigint | undefined {
  const raw = (import.meta.env.VITE_ARVEXA_DEPLOY_BLOCK as string | undefined)?.trim()
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : undefined
}

export const ARVEXA_DEPLOY_BLOCK = readDeployBlock()
