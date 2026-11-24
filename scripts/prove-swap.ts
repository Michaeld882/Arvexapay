/**
 * Read-only proof that the swap calldata the app builds executes against the real Arc Mainnet contracts.
 * It sends no transaction: each route is run with `eth_call` from a throwaway address, with state overrides
 * that give that address USDC and the two allowances (USDC to Permit2, Permit2 to the Universal Router).
 *
 *   bun run prove:swap
 *
 * Overrides only work for a USDC input (its balance is the native balance and its allowance mapping is at
 * storage slot 10). The app builds the same calldata with `buildExecuteCalldata` for every real swap.
 */
import { createPublicClient, encodeAbiParameters, encodePacked, http, keccak256, pad, parseAbiParameters, toHex, type Address, type Hex } from 'viem'
import { ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'
import { SWAP_ADDRESSES, SWAP_TOKENS } from '../src/lib/uniswap'
import { buildExecuteCalldata, describeRouterRevert, findRoutes, quoteBest, routeLabel } from '../src/lib/uniswapRouting'

const client = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL, { timeout: 20_000, retryCount: 2 }) })
const user: Address = '0x00000000000000000000000000000000000a11ce'
const eurc = SWAP_TOKENS.find((token) => token.symbol === 'EURC')
if (!eurc) throw new Error('EURC is not configured')

const amountIn = 2_000_000n // 2 USDC
const usdcAllowanceSlot = keccak256(encodePacked(['bytes32', 'bytes32'], [pad(SWAP_ADDRESSES.permit2), keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [user, 10n]))]))
// Permit2: allowance[owner][token][spender] at mapping slot 1, packed as amount | expiration << 160 | nonce << 208.
const permit2Slot = keccak256(
  encodeAbiParameters(parseAbiParameters('address,bytes32'), [
    SWAP_ADDRESSES.universalRouter,
    keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'), [USDC.address, keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [user, 1n]))])),
  ]),
)
const expiration = BigInt(Math.floor(Date.now() / 1000) + 3600)
const permit2Value: Hex = toHex(amountIn | (expiration << 160n), { size: 32 })

const stateOverride = [
  { address: user, balance: 10n ** 24n },
  { address: USDC.address, stateDiff: [{ slot: usdcAllowanceSlot, value: toHex(2n ** 255n, { size: 32 }) }] },
  { address: SWAP_ADDRESSES.permit2, stateDiff: [{ slot: permit2Slot, value: permit2Value }] },
]

let failures = 0
const routes = await findRoutes(client, USDC.address, eurc.address)
console.log(`live routes found for USDC -> EURC: ${routes.length}`)
for (const route of routes) {
  const label = routeLabel(route)
  try {
    const quote = await quoteBest(client, [route], USDC.address, eurc.address, amountIn)
    const block = await client.getBlock()
    const data = buildExecuteCalldata(quote, USDC.address, eurc.address, user, 50, block.timestamp + 1200n)
    await client.call({ account: user, to: SWAP_ADDRESSES.universalRouter, data, stateOverride })
    console.log(`PASS  ${label}: execute() simulates without reverting (quote ${quote.amountOut} EURC base units for 2 USDC, impact ${(quote.priceImpact * 100).toFixed(2)}%)`)
  } catch (error) {
    failures++
    console.log(`FAIL  ${label}: ${describeRouterRevert(error)}`)
  }
}
if (routes.length === 0) {
  failures++
  console.log('FAIL  no live routes to prove')
}
console.log(failures === 0 ? '\nSWAP CALLDATA PROOF PASSED' : `\nSWAP CALLDATA PROOF FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
