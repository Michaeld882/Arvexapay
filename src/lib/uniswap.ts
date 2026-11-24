import { encodeAbiParameters, keccak256, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem'
import { USDC } from '@/chain'

/**
 * Uniswap deployments on Arc Mainnet (chain 5042). These are the only Uniswap addresses the app may call.
 * `bun run verify:swap` re-checks every one of them against the live chain (bytecode, role links,
 * token metadata, live pools and quotes) and must pass before swaps are enabled.
 */
export const SWAP_ADDRESSES = {
  universalRouter: '0x8702463e73f74d0b6765aBceb314Ef07aCb92650',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  v3Factory: '0xf0db7b58379503491d857dB50AC9ece64c653918',
  v3QuoterV2: '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468',
  v3SwapRouter02: '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77',
  v4PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  v4StateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  v4PositionManager: '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B',
} as const satisfies Record<string, Address>

export interface SwapToken {
  symbol: string
  name: string
  address: Address
  decimals: number
}

/** Tokens offered for swapping. The USDC entry is the project's official USDC; EURC is Circle's Arc Mainnet EURC. */
export const SWAP_TOKENS: readonly SwapToken[] = [
  { symbol: USDC.symbol, name: 'USD Coin', address: USDC.address, decimals: USDC.decimals },
  { symbol: 'EURC', name: 'Euro Coin', address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
]

export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const
/** Hookless v4 pools only: [fee, tickSpacing]. */
export const V4_POOL_KEYS = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
] as const

export const PRICE_IMPACT_WARN = 0.01
export const PRICE_IMPACT_BLOCK = 0.05
export const SLIPPAGE_DEFAULT_BPS = 50
export const SLIPPAGE_MAX_BPS = 100
/** Transaction deadline, in seconds after the latest block. */
export const SWAP_DEADLINE_SECONDS = 1200n

export interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export const poolId = (key: PoolKey): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))

export const sortTokens = (a: Address, b: Address): [Address, Address] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a])

export const isNativeSentinel = (address: string): boolean => /^0x0{40}$/i.test(address) || /^0xe{40}$/i.test(address)

export const NO_HOOKS = zeroAddress
