import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { AppError } from '@/lib/errors'
import {
  NO_HOOKS,
  SLIPPAGE_MAX_BPS,
  SWAP_ADDRESSES,
  V3_FEE_TIERS,
  V4_POOL_KEYS,
  poolId,
  sortTokens,
  type PoolKey,
} from '@/lib/uniswap'

/**
 * Live Uniswap routing on Arc Mainnet: v3 and hookless v4 single-pool routes, quoted onchain.
 * Exact-input swaps only. Nothing here returns a number it did not read from the chain.
 */

const abi = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])
const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
])

export type Route =
  | { version: 'v3'; fee: number; sqrtPriceX96: bigint; feeFraction: number }
  | { version: 'v4'; key: PoolKey; sqrtPriceX96: bigint; feeFraction: number }

export interface RoutedQuote {
  route: Route
  amountIn: bigint
  amountOut: bigint
  /** Loss against the fee-free mid price, as a fraction (0.01 is 1%). The pool fee is not counted as impact. */
  priceImpact: number
}

export const routeLabel = (route: Route): string => `Uniswap ${route.version} · ${(route.feeFraction * 100).toFixed(route.feeFraction * 100 < 0.1 ? 3 : 2).replace(/\.?0+$/, '')}% pool`

const isRevert = (error: unknown): boolean => error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null

export async function findRoutes(client: PublicClient, tokenIn: Address, tokenOut: Address): Promise<Route[]> {
  const [currency0, currency1] = sortTokens(tokenIn, tokenOut)
  const zeroForOne = tokenIn === currency0
  const v3 = V3_FEE_TIERS.map(async (fee): Promise<Route | null> => {
    const pool = await client.readContract({ address: SWAP_ADDRESSES.v3Factory, abi, functionName: 'getPool', args: [tokenIn, tokenOut, fee] })
    if (pool === zeroAddress) return null
    const [liquidity, slot0] = await Promise.all([
      client.readContract({ address: pool, abi, functionName: 'liquidity' }),
      client.readContract({ address: pool, abi, functionName: 'slot0' }),
    ])
    if (liquidity === 0n || slot0[0] === 0n) return null
    return { version: 'v3', fee, sqrtPriceX96: slot0[0], feeFraction: fee / 1e6 }
  })
  const v4 = V4_POOL_KEYS.map(async ([fee, tickSpacing]): Promise<Route | null> => {
    const key: PoolKey = { currency0, currency1, fee, tickSpacing, hooks: NO_HOOKS }
    const id = poolId(key)
    const [liquidity, slot0] = await Promise.all([
      client.readContract({ address: SWAP_ADDRESSES.v4StateView, abi, functionName: 'getLiquidity', args: [id] }),
      client.readContract({ address: SWAP_ADDRESSES.v4StateView, abi, functionName: 'getSlot0', args: [id] }),
    ])
    if (liquidity === 0n || slot0[0] === 0n) return null
    const protocolPips = zeroForOne ? slot0[2] & 0xfff : slot0[2] >> 12
    const lpPips = slot0[3]
    const totalPips = protocolPips + lpPips - (protocolPips * lpPips) / 1_000_000
    return { version: 'v4', key, sqrtPriceX96: slot0[0], feeFraction: totalPips / 1e6 }
  })
  const routes = await Promise.all([...v3, ...v4])
  return routes.filter((route): route is Route => route !== null)
}

function midPrice(route: Route, tokenIn: Address, tokenOut: Address): number {
  const price = (Number(route.sqrtPriceX96) / 2 ** 96) ** 2
  return BigInt(tokenIn) < BigInt(tokenOut) ? price : 1 / price
}

async function quoteRoute(client: PublicClient, route: Route, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  if (route.version === 'v3') {
    const { result } = await client.simulateContract({
      address: SWAP_ADDRESSES.v3QuoterV2,
      abi,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }],
    })
    return result[0]
  }
  const { result } = await client.simulateContract({
    address: SWAP_ADDRESSES.v4Quoter,
    abi: v4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: route.key, zeroForOne: tokenIn === route.key.currency0, exactAmount: amountIn, hookData: '0x' }],
  })
  return result[0]
}

/** Quotes every live pool and returns the best output. A pool that cannot fill the size is skipped; RPC errors are rethrown. */
export async function quoteBest(client: PublicClient, routes: readonly Route[], tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<RoutedQuote> {
  const quoted = await Promise.all(
    routes.map(async (route): Promise<RoutedQuote | null> => {
      const amountOut = await quoteRoute(client, route, tokenIn, tokenOut, amountIn).catch((error: unknown) => {
        if (isRevert(error)) return null
        throw error
      })
      if (amountOut === null || amountOut === 0n) return null
      const fair = Number(amountIn) * midPrice(route, tokenIn, tokenOut) * (1 - route.feeFraction)
      return { route, amountIn, amountOut, priceImpact: Math.max(0, 1 - Number(amountOut) / fair) }
    }),
  )
  const live = quoted.filter((quote): quote is RoutedQuote => quote !== null)
  if (live.length === 0) throw new AppError('swap_unavailable', 'No live pool can fill this size')
  live.sort((a, b) => (a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1))
  return live[0]
}

export function assertSlippage(slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > SLIPPAGE_MAX_BPS) {
    throw new AppError('invalid_amount', `Slippage must be a whole number of basis points from 0 to ${SLIPPAGE_MAX_BPS}`)
  }
}

export function minOut(amountOut: bigint, slippageBps: number): bigint {
  assertSlippage(slippageBps)
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
}

const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const COMMAND = { V3_SWAP_EXACT_IN: 0x00, V4_SWAP: 0x10 } as const
const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const

/**
 * Universal Router 2.1.2 `execute` calldata for one exact-input swap. Permit2 allowances are set by
 * earlier transactions, so no PERMIT2_PERMIT command is included. Value is always zero on Arc.
 */
export function buildExecuteCalldata(quote: RoutedQuote, tokenIn: Address, tokenOut: Address, recipient: Address, slippageBps: number, deadline: bigint): Hex {
  const limitOut = minOut(quote.amountOut, slippageBps)
  const commands: number[] = []
  const inputs: Hex[] = []
  if (quote.route.version === 'v3') {
    const path = encodePacked(['address', 'uint24', 'address'], [tokenIn, quote.route.fee, tokenOut])
    commands.push(COMMAND.V3_SWAP_EXACT_IN)
    inputs.push(encodeAbiParameters(parseAbiParameters('address,uint256,uint256,bytes,bool,uint256[]'), [recipient, quote.amountIn, limitOut, path, true, []]))
  } else {
    const zeroForOne = tokenIn === quote.route.key.currency0
    const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL])
    const swap = encodeAbiParameters(
      parseAbiParameters(`(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`),
      [{ poolKey: quote.route.key, zeroForOne, amountIn: quote.amountIn, amountOutMinimum: limitOut, minHopPriceX36: 0n, hookData: '0x' }],
    )
    const settle = encodeAbiParameters(parseAbiParameters('address,uint256'), [tokenIn, quote.amountIn])
    const take = encodeAbiParameters(parseAbiParameters('address,uint256'), [tokenOut, limitOut])
    commands.push(COMMAND.V4_SWAP)
    inputs.push(encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), [actions, [swap, settle, take]]))
  }
  return encodeFunctionData({ abi, functionName: 'execute', args: [toHex(new Uint8Array(commands)), inputs, deadline] })
}

const UNISWAP_ERRORS = parseAbi([
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error TransactionDeadlinePassed()',
  'error SliceOutOfBounds()',
  'error V3TooLittleReceived()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
])

const ERROR_MESSAGES: Record<string, string> = {
  TransactionDeadlinePassed: 'The swap deadline passed. Get a fresh quote and try again.',
  V3TooLittleReceived: 'The price moved past your slippage limit. Get a fresh quote and try again.',
  V4TooLittleReceived: 'The price moved past your slippage limit. Get a fresh quote and try again.',
  AllowanceExpired: 'The swap allowance expired. Approve again and retry.',
  InsufficientAllowance: 'The swap allowance is too small. Approve again and retry.',
  SliceOutOfBounds: 'The router rejected the swap data.',
}

/** Turns a router revert into a plain-language message. Returns the raw hint when it is not a known router error. */
export function describeRouterRevert(error: unknown): string {
  const data = findRevertData(error)
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: UNISWAP_ERRORS, data })
      return ERROR_MESSAGES[decoded.errorName] ?? `The router reverted (${decoded.errorName}).`
    } catch {
      /* not a router error */
    }
  }
  return error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : 'The swap simulation failed.'
}

function findRevertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined
  const hit = error.walk((e) => typeof (e as { data?: unknown }).data === 'string' && String((e as { data?: string }).data).startsWith('0x') && String((e as { data?: string }).data).length >= 10)
  const data = (hit as { data?: string } | null)?.data
  return data as Hex | undefined
}
