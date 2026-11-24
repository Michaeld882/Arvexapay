/**
 * Read-only verification of the Arc Mainnet swap setup. It sends no transactions.
 *
 *   bun run verify:swap
 *
 * Checks, against the live Arc Mainnet RPC: chain ID, bytecode at every router/quoter/factory/token
 * address, the role links between those contracts, token symbols and decimals, which pools have
 * liquidity, and a live quote for each live pool. It exits non-zero if any check fails, so a swap
 * provider is only enabled when this passes.
 */
import { createPublicClient, erc20Abi, getAddress, http, parseAbi, zeroAddress, type Address } from 'viem'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'
import { SWAP_ADDRESSES, SWAP_TOKENS, V3_FEE_TIERS, V4_POOL_KEYS, poolId } from '../src/lib/uniswap'

const client = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL, { timeout: 15_000, retryCount: 2 }) })
let failures = 0
const pass = (name: string, extra = '') => console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`)
const fail = (name: string, extra = '') => {
  failures++
  console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`)
}
const check = (ok: boolean, name: string, extra = '') => (ok ? pass(name, extra) : fail(name, extra))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const abi = parseAbi([
  'function poolManager() view returns (address)',
  'function factory() view returns (address)',
  'function getPool(address,address,uint24) view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
])
const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
])

const chainId = await client.getChainId()
check(chainId === ARC_CHAIN_ID, 'RPC reports Arc Mainnet chain ID', `${chainId}`)

// 1. Bytecode at every address the swap code can call.
for (const [name, address] of Object.entries(SWAP_ADDRESSES)) {
  const code = await client.getCode({ address })
  check(!!code && code !== '0x', `contract code at ${name}`, address)
}
for (const token of SWAP_TOKENS) {
  const code = await client.getCode({ address: token.address })
  check(!!code && code !== '0x', `contract code at token ${token.symbol}`, token.address)
}

// 2. Role links between contracts.
const poolManager = SWAP_ADDRESSES.v4PoolManager
for (const name of ['v4Quoter', 'v4StateView', 'v4PositionManager'] as const) {
  const pm = await client.readContract({ address: SWAP_ADDRESSES[name], abi, functionName: 'poolManager' }).catch(() => zeroAddress)
  check(getAddress(pm) === getAddress(poolManager), `${name}.poolManager() is the v4 PoolManager`)
}
for (const name of ['v3QuoterV2', 'v3SwapRouter02'] as const) {
  const factory = await client.readContract({ address: SWAP_ADDRESSES[name], abi, functionName: 'factory' }).catch(() => zeroAddress)
  check(getAddress(factory) === getAddress(SWAP_ADDRESSES.v3Factory), `${name}.factory() is the v3 factory`)
}

// 3. Token metadata read from the contracts themselves.
for (const token of SWAP_TOKENS) {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token.address, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' }),
  ])
  check(symbol === token.symbol && decimals === token.decimals, `token ${token.symbol} symbol and decimals match the contract`, `${symbol}, ${decimals} decimals`)
}
check(getAddress(SWAP_TOKENS[0].address) === getAddress(USDC.address), 'first swap token is the official USDC')

// 4. Live pools and quotes for every token pair.
let livePools = 0
for (let i = 0; i < SWAP_TOKENS.length; i++) {
  for (let j = i + 1; j < SWAP_TOKENS.length; j++) {
    const a = SWAP_TOKENS[i]
    const b = SWAP_TOKENS[j]
    const [c0, c1]: [Address, Address] = BigInt(a.address) < BigInt(b.address) ? [a.address, b.address] : [b.address, a.address]
    const amountIn = 10n ** BigInt(a.decimals)
    for (const fee of V3_FEE_TIERS) {
      const pool = await client.readContract({ address: SWAP_ADDRESSES.v3Factory, abi, functionName: 'getPool', args: [a.address, b.address, fee] })
      if (pool === zeroAddress) continue
      const liquidity = await client.readContract({ address: pool, abi, functionName: 'liquidity' })
      if (liquidity === 0n) {
        console.log(`info  v3 ${a.symbol}/${b.symbol} ${fee / 10000}% pool exists but has zero liquidity (skipped)`)
        continue
      }
      livePools++
      const { result } = await client.simulateContract({
        address: SWAP_ADDRESSES.v3QuoterV2,
        abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: a.address, tokenOut: b.address, amountIn, fee, sqrtPriceLimitX96: 0n }],
      }).catch(() => ({ result: [0n] as const }))
      check(result[0] > 0n, `v3 ${a.symbol}/${b.symbol} ${fee / 10000}% live quote for 1 ${a.symbol}`, `${result[0]} base units of ${b.symbol}`)
      await sleep(250)
    }
    for (const [fee, tickSpacing] of V4_POOL_KEYS) {
      const key = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress } as const
      const id = poolId(key)
      const liquidity = await client.readContract({ address: SWAP_ADDRESSES.v4StateView, abi, functionName: 'getLiquidity', args: [id] })
      if (liquidity === 0n) continue
      livePools++
      const { result } = await client.simulateContract({
        address: SWAP_ADDRESSES.v4Quoter,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: key, zeroForOne: a.address === c0, exactAmount: amountIn, hookData: '0x' }],
      }).catch(() => ({ result: [0n, 0n] as const }))
      check(result[0] > 0n, `v4 ${a.symbol}/${b.symbol} ${fee / 10000}% live quote for 1 ${a.symbol}`, `${result[0]} base units of ${b.symbol}`)
      await sleep(250)
    }
  }
}
console.log(`info  live pools with liquidity: ${livePools}`)
check(livePools > 0, 'at least one live pool exists (otherwise swaps must stay disabled)')

console.log(failures === 0 ? '\nSWAP VERIFICATION PASSED' : `\nSWAP VERIFICATION FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
