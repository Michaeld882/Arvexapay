import { erc20Abi, getAddress, parseAbi, zeroAddress, type Address } from 'viem'
import { AppError } from '@/lib/errors'
import { getArcClient } from '@/lib/rpc'
import { SWAP_ADDRESSES, SWAP_DEADLINE_SECONDS, SWAP_TOKENS, isNativeSentinel } from '@/lib/uniswap'
import { assertSlippage, buildExecuteCalldata, describeRouterRevert, findRoutes, minOut, quoteBest, routeLabel, type RoutedQuote, type Route } from '@/lib/uniswapRouting'
import type { SwapProvider, SwapQuote, SwapRequest, SwapTransaction } from '@/swap-config'

const roleAbi = parseAbi(['function poolManager() view returns (address)', 'function factory() view returns (address)'])

/** Pool discovery changes slowly, so route lists are reused for a few minutes; quotes are always read live. */
const ROUTE_TTL_MS = 5 * 60_000
const routeCache = new Map<string, { at: number; routes: Promise<Route[]> }>()

function cachedRoutes(tokenIn: Address, tokenOut: Address): Promise<Route[]> {
  const key = `${tokenIn}:${tokenOut}`
  const hit = routeCache.get(key)
  if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.routes
  const routes = findRoutes(getArcClient(), tokenIn, tokenOut)
  routeCache.set(key, { at: Date.now(), routes })
  routes.catch(() => routeCache.delete(key))
  return routes
}

function assertTokens(request: SwapRequest): void {
  for (const token of [request.tokenIn, request.tokenOut]) {
    if (isNativeSentinel(token.address)) throw new AppError('token_not_configured', 'The native token sentinel is not a swappable token')
    if (!SWAP_TOKENS.some((known) => known.address === token.address && known.decimals === token.decimals)) {
      throw new AppError('token_not_configured', `${token.symbol} is not a verified swap token`)
    }
  }
  if (request.tokenIn.address === request.tokenOut.address) throw new AppError('swap_unavailable', 'Choose two different tokens')
  if (request.amountIn <= 0n) throw new AppError('invalid_amount')
}

interface ProviderData {
  routed: RoutedQuote
}

export const uniswapArcProvider: SwapProvider = {
  id: 'uniswap-arc-mainnet',
  name: 'Uniswap on Arc Mainnet',
  tokens: SWAP_TOKENS,
  approval: { permit2: SWAP_ADDRESSES.permit2, router: SWAP_ADDRESSES.universalRouter },

  /** Re-checks every contract the swap uses against the live chain before the form is enabled. */
  async verify() {
    const client = getArcClient()
    const addresses: Array<[string, Address]> = [
      ...Object.entries(SWAP_ADDRESSES),
      ...SWAP_TOKENS.map((token): [string, Address] => [`${token.symbol} token`, token.address]),
    ]
    const codes = await Promise.all(addresses.map(([, address]) => client.getCode({ address })))
    const missing = addresses.filter((_, index) => !codes[index] || codes[index] === '0x').map(([name]) => name)
    if (missing.length > 0) throw new AppError('swap_unavailable', `No contract code at: ${missing.join(', ')}`)

    const [quoterPm, statePm, positionPm, v3QuoterFactory, routerFactory] = await Promise.all([
      client.readContract({ address: SWAP_ADDRESSES.v4Quoter, abi: roleAbi, functionName: 'poolManager' }),
      client.readContract({ address: SWAP_ADDRESSES.v4StateView, abi: roleAbi, functionName: 'poolManager' }),
      client.readContract({ address: SWAP_ADDRESSES.v4PositionManager, abi: roleAbi, functionName: 'poolManager' }),
      client.readContract({ address: SWAP_ADDRESSES.v3QuoterV2, abi: roleAbi, functionName: 'factory' }),
      client.readContract({ address: SWAP_ADDRESSES.v3SwapRouter02, abi: roleAbi, functionName: 'factory' }),
    ])
    const sameAddress = (a: Address, b: Address) => a !== zeroAddress && getAddress(a) === getAddress(b)
    if (![quoterPm, statePm, positionPm].every((pm) => sameAddress(pm, SWAP_ADDRESSES.v4PoolManager)) || ![v3QuoterFactory, routerFactory].every((f) => sameAddress(f, SWAP_ADDRESSES.v3Factory))) {
      throw new AppError('swap_unavailable', 'Uniswap contracts on Arc do not link to each other as expected')
    }
    const decimals = await Promise.all(SWAP_TOKENS.map((token) => client.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' })))
    if (decimals.some((value, index) => value !== SWAP_TOKENS[index].decimals)) {
      throw new AppError('swap_unavailable', 'A swap token has different decimals than configured')
    }
  },

  async quote(request): Promise<SwapQuote> {
    assertTokens(request)
    assertSlippage(request.slippageBps)
    const client = getArcClient()
    const routes = await cachedRoutes(request.tokenIn.address, request.tokenOut.address)
    if (routes.length === 0) throw new AppError('swap_unavailable', 'No pool with liquidity exists for this pair')
    const routed = await quoteBest(client, routes, request.tokenIn.address, request.tokenOut.address, request.amountIn)
    const data: ProviderData = { routed }
    return {
      amountOut: routed.amountOut,
      minAmountOut: minOut(routed.amountOut, request.slippageBps),
      deadline: Math.floor(Date.now() / 1000) + 30,
      routeLabel: routeLabel(routed.route),
      feeFraction: routed.route.feeFraction,
      priceImpact: routed.priceImpact,
      providerData: data,
    }
  },

  async buildTransaction(request, quote): Promise<SwapTransaction> {
    assertTokens(request)
    const data = quote.providerData as ProviderData | undefined
    if (!data) throw new AppError('swap_unavailable', 'Quote is missing its route')
    const client = getArcClient()
    const block = await client.getBlock()
    const deadline = block.timestamp + SWAP_DEADLINE_SECONDS
    const calldata = buildExecuteCalldata(data.routed, request.tokenIn.address, request.tokenOut.address, request.recipient, request.slippageBps, deadline)
    // Simulate from the user's address first. A revert is shown in plain language and nothing is sent.
    try {
      await client.call({ account: request.recipient, to: SWAP_ADDRESSES.universalRouter, data: calldata })
    } catch (error) {
      throw new AppError('reverted', describeRouterRevert(error), { cause: error })
    }
    return { to: SWAP_ADDRESSES.universalRouter, data: calldata, value: 0n, spender: SWAP_ADDRESSES.permit2, deadline: Number(deadline) }
  },
}
