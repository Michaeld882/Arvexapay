/**
 * Swap provider configuration point.
 *
 * Arvexa never fabricates quotes or swaps. A swap is only offered when a verified provider is
 * registered in SWAP_PROVIDERS below, and the Swap page re-checks that provider's contracts against the
 * live chain (provider.verify) before it enables the form. Remove the provider from the list to switch
 * swaps off. Run `bun run verify:swap` after any change to a provider's addresses or tokens.
 */

import type { Address, Hex } from 'viem'
import { uniswapArcProvider } from '@/lib/uniswapProvider'

export interface SwapToken {
  symbol: string
  address: Address
  decimals: number
}

export interface SwapQuote {
  /** Raw amount of the output token the provider expects to return. */
  amountOut: bigint
  /** Minimum output after slippage; the transaction must revert below this. */
  minAmountOut: bigint
  /** Unix seconds after which this quote is stale and must be re-read. */
  deadline: number
  /** Human-readable route, for example "Uniswap v3 · 0.05% pool". */
  routeLabel?: string
  /** Pool fee as a fraction (0.0005 is 0.05%). */
  feeFraction?: number
  /** Loss against the fee-free mid price as a fraction (0.01 is 1%). */
  priceImpact?: number
  /** Opaque data the provider needs again in buildTransaction. */
  providerData?: unknown
}

export interface SwapRequest {
  tokenIn: SwapToken
  tokenOut: SwapToken
  amountIn: bigint
  recipient: Address
  slippageBps: number
}

export interface SwapTransaction {
  to: Address
  data: Hex
  value: bigint
  /** Address that must be approved to spend tokenIn, if any. */
  spender?: Address
  /** Unix seconds after which the router rejects the transaction. */
  deadline?: number
}

export interface SwapProvider {
  id: string
  name: string
  tokens: readonly SwapToken[]
  /** The contracts that pull tokenIn. Set permit2 when the router takes tokens through Permit2. */
  approval: { router: Address; permit2?: Address }
  /** Re-checks the provider's contracts against the live chain. Throws when anything is wrong. */
  verify(): Promise<void>
  /** Must read live onchain state. Throw when no route exists. */
  quote(request: SwapRequest): Promise<SwapQuote>
  /** Build the exact transaction the wallet will sign for a quote. */
  buildTransaction(request: SwapRequest, quote: SwapQuote): Promise<SwapTransaction>
}

export const SWAP_PROVIDERS: readonly SwapProvider[] = [uniswapArcProvider]

export const SWAP_PROVIDER: SwapProvider | undefined = SWAP_PROVIDERS[0]
export const SWAP_CONFIGURED = SWAP_PROVIDER !== undefined
