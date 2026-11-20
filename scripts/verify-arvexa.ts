/**
 * Read-only verification for Arvexa. Sends no transactions and needs no keys.
 *
 *   bun run verify:abi          frontend ABI vs the compiled contract artifact (no network)
 *   bun run verify:deployment   the address in VITE_ARVEXA_CONTRACT_ADDRESS against Arc Mainnet
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, erc20Abi, http, isAddressEqual, parseAbi, toFunctionSelector, type Abi, type AbiItem } from 'viem'
import { ARC_CHAIN_ID, ARC_RPC_URL, ARVEXA, USDC, arcMainnet } from '../src/chain'
import { arvexaAbi } from '../src/lib/abi'

const mode = process.argv[2]

/** Canonical signature including indexed flags and outputs, so any drift is detected. */
function signature(item: AbiItem): string {
  if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') return item.type
  const inputs = item.inputs.map((input) => `${input.type}${'indexed' in input && input.indexed ? ' indexed' : ''}`).join(',')
  const outputs = item.type === 'function' ? ` returns (${item.outputs.map((output) => output.type).join(',')})` : ''
  return `${item.name}(${inputs})${outputs}`
}
let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!pass) failures++
}

function verifyAbi() {
  const artifact = JSON.parse(readFileSync('contracts/out/Arvexa.sol/Arvexa.json', 'utf8')) as { abi: Abi }
  const compiled = new Map<string, AbiItem>()
  for (const item of artifact.abi) {
    if (item.type === 'function' || item.type === 'event' || item.type === 'error') compiled.set(`${item.type}:${signature(item)}`, item)
  }
  for (const item of arvexaAbi) {
    const key = `${item.type}:${signature(item)}`
    const match = compiled.get(key)
    const sameMutability = item.type !== 'function' || (match?.type === 'function' && match.stateMutability === item.stateMutability)
    check(`frontend ${item.type} ${signature(item)} exists in contract`, Boolean(match) && sameMutability)
  }
  const used = ['deposit', 'withdraw', 'balanceOf', 'paused', 'USDC', 'Deposited', 'Withdrawn']
  for (const name of used) check(`app uses ${name}`, arvexaAbi.some((item) => 'name' in item && item.name === name))
}

async function verifyDeployment() {
  const client = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL, { timeout: 15_000, retryCount: 2 }) })
  check('chain id is 5042', (await client.getChainId()) === ARC_CHAIN_ID)
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'symbol' }),
  ])
  check('official USDC has 6 decimals and symbol USDC', decimals === 6 && decimals === USDC.decimals && symbol === 'USDC', `${USDC.address}`)

  if (ARVEXA.status !== 'configured') {
    check('VITE_ARVEXA_CONTRACT_ADDRESS is configured', false, ARVEXA.status === 'invalid' ? 'invalid address' : 'not set')
    return
  }
  const address = ARVEXA.address
  const code = await client.getCode({ address })
  check('contract has code on Arc Mainnet', Boolean(code && code !== '0x'), address)
  if (!code || code === '0x') return

  for (const item of arvexaAbi.filter((entry) => entry.type === 'function')) {
    const selector = toFunctionSelector(item).slice(2)
    check(`bytecode exposes ${item.name}`, code.includes(selector))
  }
  const vault = parseAbi([
    'function USDC() view returns (address)',
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function paused() view returns (bool)',
    'function totalDeposits() view returns (uint256)',
    'function solvency() view returns (bool)',
  ])
  const [token, owner, pendingOwner, paused, total, solvent, vaultUsdc] = await Promise.all([
    client.readContract({ address, abi: vault, functionName: 'USDC' }),
    client.readContract({ address, abi: vault, functionName: 'owner' }),
    client.readContract({ address, abi: vault, functionName: 'pendingOwner' }),
    client.readContract({ address, abi: vault, functionName: 'paused' }),
    client.readContract({ address, abi: vault, functionName: 'totalDeposits' }),
    client.readContract({ address, abi: vault, functionName: 'solvency' }),
    client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ])
  check('vault USDC() is the official Arc USDC', isAddressEqual(token, USDC.address), token)
  check('owner is not the zero address', !isAddressEqual(owner, '0x0000000000000000000000000000000000000000'), owner)
  check('no ownership transfer is pending', isAddressEqual(pendingOwner, '0x0000000000000000000000000000000000000000'), pendingOwner)
  check('vault holds at least totalDeposits of USDC', solvent && vaultUsdc >= total, `${vaultUsdc} >= ${total}`)
  console.log(`INFO  owner=${owner} paused=${paused} totalDeposits=${total}`)
}

if (mode === 'abi') verifyAbi()
else if (mode === 'onchain') await verifyDeployment()
else {
  console.log('usage: bun run scripts/verify-arvexa.ts <abi|onchain>')
  process.exit(2)
}
console.log(failures === 0 ? 'OK' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
