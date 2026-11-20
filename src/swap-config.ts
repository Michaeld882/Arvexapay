/**
 * Swap provider configuration point.
 *
 * Arvexa never fabricates quotes or swaps. A swap is only offered when a verified
 * provider is registered in SWAP_PROVIDERS below. The list is empty on purpose:
 * add a provider only after its router address, token list and route have been
 * independently verified on Arc Mainnet.
 */

import type { Address, Hex } from 'viem'

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
  /** Unix seconds after which the quote must not be executed. */
  deadline: number
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
}

export interface SwapProvider {
  id: string
  name: string
  tokens: readonly SwapToken[]
  /** Must read live onchain state. Throw when no route exists. */
  quote(request: SwapRequest): Promise<SwapQuote>
  /** Build the exact transaction the wallet will sign for a quote. */
  buildTransaction(request: SwapRequest, quote: SwapQuote): Promise<SwapTransaction>
}

export const SWAP_PROVIDERS: readonly SwapProvider[] = []

export const SWAP_PROVIDER: SwapProvider | undefined = SWAP_PROVIDERS[0]
export const SWAP_CONFIGURED = SWAP_PROVIDER !== undefined
