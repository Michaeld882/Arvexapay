import { numberToHex, type EIP1193Provider } from 'viem'
import type { ViemAdapter } from '@circle-fin/adapter-viem-v2'
import type { AppKit, ChainDefinition } from '@circle-fin/app-kit'
import { CIRCLE_CONFIG } from '@/circle/config'

export type EvmChain = Extract<ChainDefinition, { type: 'evm' }>
export type WalletAdapter = ViemAdapter

/** The string identifier Circle uses for a chain (for example "Ethereum"). */
export const chainKey = (chain: Pick<ChainDefinition, 'chain'>): string => String(chain.chain)

export const isEvmChain = (chain: ChainDefinition): chain is EvmChain => chain.type === 'evm'

let kitPromise: Promise<AppKit> | undefined

/**
 * The shared Circle App Kit instance. It is loaded on first use so the wallet screens stay light, and it holds no
 * credentials: bridging and unified balance need no API key, and every transaction is signed by the user's wallet.
 */
export function getAppKit(): Promise<AppKit> {
  kitPromise ??= import('@circle-fin/app-kit').then(({ AppKit: Kit }) => new Kit()).catch((err: unknown) => {
    kitPromise = undefined // allow a retry after a failed download
    throw err
  })
  return kitPromise
}

const FEE_LABELS: Record<string, string> = {
  provider: 'Circle protocol fee',
  forwarder: 'Circle forwarding fee',
  kit: 'Service fee',
}

/** Plain label for a fee type the SDK reports. */
export const feeLabel = (type: string): string => FEE_LABELS[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)} fee`

export function explorerTxUrl(chain: Pick<ChainDefinition, 'explorerUrl'>, hash: string): string {
  return chain.explorerUrl.replace('{hash}', hash)
}

export interface CctpChains {
  destination: EvmChain
  /** CCTP source chains the user can bridge from, excluding Arc itself. */
  sources: EvmChain[]
}

/** CCTP routes straight from Circle's registry. Throws when Arc is not a supported destination. */
export async function loadCctpChains(): Promise<CctpChains> {
  const kit = await getAppKit()
  const all = kit.getSupportedChains('bridge', { chainType: 'evm', isTestnet: false }).filter(isEvmChain)
  const destination = all.find((chain) => chainKey(chain) === CIRCLE_CONFIG.arcIdentifier)
  if (!destination) throw new Error('Arc is not listed as a CCTP destination by Circle.')
  const allow = CIRCLE_CONFIG.sourceChains
  const sources = all
    .filter((chain) => chainKey(chain) !== chainKey(destination) && chain.cctp && chain.usdcAddress)
    .filter((chain) => !allow || allow.includes(chainKey(chain)))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { destination, sources }
}

export interface GatewayChains {
  arc: EvmChain
  /** Chains where USDC can be deposited into the Gateway unified balance. */
  chains: EvmChain[]
}

export async function loadGatewayChains(): Promise<GatewayChains> {
  const kit = await getAppKit()
  const chains = kit.unifiedBalance.getSupportedChains('USDC').filter(isEvmChain).filter((chain) => !chain.isTestnet)
  const arc = chains.find((chain) => chainKey(chain) === CIRCLE_CONFIG.arcIdentifier)
  if (!arc) throw new Error('Arc is not listed as a Gateway chain by Circle.')
  return { arc, chains: chains.sort((a, b) => a.name.localeCompare(b.name)) }
}

const isUnrecognizedChain = (error: unknown): boolean => {
  const e = error as { code?: number; data?: { originalError?: { code?: number } } }
  return e?.code === 4902 || e?.data?.originalError?.code === 4902
}

/**
 * Wraps a wallet provider so switching to a chain the wallet does not know yet first adds it (from Circle's own
 * chain registry), then retries the switch. Without this a CCTP transfer can fail after the burn.
 */
export function withAddChainFallback(provider: EIP1193Provider, chains: readonly EvmChain[]): EIP1193Provider {
  const send = provider.request.bind(provider) as (args: { method: string; params?: unknown }) => Promise<unknown>
  const request = (async (args: { method: string; params?: unknown }) => {
    try {
      return await send(args)
    } catch (error) {
      if (args.method !== 'wallet_switchEthereumChain' || !isUnrecognizedChain(error)) throw error
      const [{ chainId }] = args.params as [{ chainId: string }]
      const chain = chains.find((candidate) => candidate.chainId === Number(chainId))
      if (!chain) throw error
      await send({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: numberToHex(chain.chainId),
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: [...chain.rpcEndpoints],
            blockExplorerUrls: [new URL(chain.explorerUrl).origin],
          },
        ],
      })
      return send(args)
    }
  }) as EIP1193Provider['request']

  // A Proxy, not a spread: wallet providers are class instances.
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') return request
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

export async function switchWalletChain(provider: EIP1193Provider, chain: EvmChain, known: readonly EvmChain[]): Promise<void> {
  await withAddChainFallback(provider, known).request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: numberToHex(chain.chainId) }],
  })
}

export async function createWalletAdapter(provider: EIP1193Provider, known: readonly EvmChain[]) {
  const { createViemAdapterFromProvider } = await import('@circle-fin/adapter-viem-v2')
  return createViemAdapterFromProvider({ provider: withAddChainFallback(provider, known) })
}
