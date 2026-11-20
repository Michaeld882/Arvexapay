/**
 * Read-only smoke test against the real Arc Mainnet RPC. Sends no transactions.
 * Run with: bun run tests/rpc-live.ts
 */
import { createPublicClient, erc20Abi, http, parseAbiItem } from 'viem'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'

const client = createPublicClient({
  chain: arcMainnet,
  transport: http(ARC_RPC_URL, { timeout: 10_000, retryCount: 2, retryDelay: 500, batch: { wait: 25, batchSize: 50 } }),
})

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const chainId = await client.getChainId()
check('chain id is 5042', chainId === ARC_CHAIN_ID, String(chainId))

const head = await client.getBlockNumber()
check('head block readable', head > 0n, head.toString())

const [decimals, symbol, code] = await Promise.all([
  client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'decimals' }),
  client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'symbol' }),
  client.getCode({ address: USDC.address }),
])
check('USDC decimals is 6', decimals === 6, String(decimals))
check('USDC symbol is USDC', symbol === 'USDC', symbol)
check('USDC contract has code', Boolean(code && code !== '0x'))

// Batched duplicate reads in one tick must succeed together (HTTP JSON-RPC batching).
const holder = '0x0000000000000000000000000000000000000001'
const started = performance.now()
const balances = await Promise.all(
  Array.from({ length: 10 }, () => client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })),
)
check('10 same-tick reads agree', new Set(balances.map(String)).size === 1, `${Math.round(performance.now() - started)}ms`)

// Measure which getLogs window sizes this RPC accepts right now (we do not assume a limit).
for (const size of [1_000n, 10_000n, 100_000n]) {
  try {
    const logs = await client.getLogs({ address: USDC.address, event: transferEvent, fromBlock: head - size, toBlock: head })
    console.log(`INFO  getLogs window ${size} blocks accepted (${logs.length} logs)`)
  } catch (err) {
    console.log(`INFO  getLogs window ${size} blocks rejected: ${(err as Error).message.split('\n')[0].slice(0, 120)}`)
  }
}

console.log(failures === 0 ? 'RPC smoke test passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
