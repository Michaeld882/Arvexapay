/**
 * A real x402 payment on Arc Testnet, end to end, using the same buyer code the app uses (src/lib/x402.ts).
 *
 *   bun run scripts/x402-test.ts init   creates throwaway test keys (kept outside the repo) and prints the buyer address
 *   (fund the buyer with Arc Testnet USDC from https://faucet.circle.com)
 *   bun run scripts/x402-test.ts run    starts a real paid API, pays it, and verifies the settlement on chain
 *
 * The keys are for Arc Testnet only and never leave this machine. Nothing here touches mainnet.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, formatUnits, http, erc20Abi, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createFacilitatorMiddleware } from '@circle-fin/x402-batching/server'
import express from 'express'
import { discover, payOffer, verifySettlement, type X402Target } from '../src/lib/x402'
import { getUsdc, requireChain } from '../src/onchain-facts'

const KEYS = '/tmp/arvexa-x402-test-keys.json'
const CHAIN_ID = 5042002
const chain = requireChain(CHAIN_ID)
const usdc = getUsdc(CHAIN_ID)
if (!usdc) throw new Error('No USDC on Arc Testnet')

const TARGET: X402Target = { chainId: CHAIN_ID, network: `eip155:${CHAIN_ID}`, asset: usdc.address as Address, label: 'Arc Testnet', explorerTx: (hash) => `${chain.explorerBase}/tx/${hash}` }
const client = createPublicClient({ transport: http(chain.rpcUrls[0]) })

function keys(): { buyer: Hex; seller: Hex } {
  if (existsSync(KEYS)) return JSON.parse(readFileSync(KEYS, 'utf8')) as { buyer: Hex; seller: Hex }
  const fresh = { buyer: generatePrivateKey(), seller: generatePrivateKey() }
  writeFileSync(KEYS, JSON.stringify(fresh), { mode: 0o600 })
  return fresh
}

const balanceOf = (address: Address) => client.readContract({ address: TARGET.asset, abi: erc20Abi, functionName: 'balanceOf', args: [address] })

async function main() {
  const { buyer: buyerKey, seller: sellerKey } = keys()
  const buyer = privateKeyToAccount(buyerKey)
  const seller = privateKeyToAccount(sellerKey)
  if (process.argv[2] === 'init') {
    console.log(JSON.stringify({ buyer: buyer.address, seller: seller.address, network: TARGET.network }))
    return
  }

  const before = await balanceOf(buyer.address)
  console.log(`buyer ${buyer.address} balance ${formatUnits(before, 6)} USDC`)
  if (before < 20_000n) throw new Error('Fund the buyer with Arc Testnet USDC first')

  // A real x402 seller: Circle's Facilitator settles each payment onchain.
  const facilitator = createFacilitatorMiddleware({ sellerSigner: seller, networks: [TARGET.network] })
  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE')
    next()
  })
  app.get('/premium', facilitator.require('$0.01'), (_req, res) => res.json({ content: 'Paid content from a real x402 seller' }))
  const server = app.listen(0)
  const port = (server.address() as { port: number }).port
  const url = `http://localhost:${port}/premium`

  try {
    // 1. Unpaid request: a real 402.
    const raw = await fetch(url)
    console.log('unpaid status', raw.status)
    if (raw.status !== 402) throw new Error('expected 402')

    // 2. The same discovery the app runs. A wrong network is refused, nothing is signed.
    const wrong = await discover(url, { ...TARGET, chainId: 5042, network: 'eip155:5042' })
    console.log('wrong-network discovery:', wrong.kind)
    if (wrong.kind !== 'unsupported') throw new Error('a payment on another network must be refused')

    const found = await discover(url, TARGET)
    if (found.kind !== 'payable') throw new Error(`not payable: ${JSON.stringify(found)}`)
    console.log(`offer: ${formatUnits(found.offer.amount, 6)} USDC to ${found.offer.payTo} (seller is ${seller.address})`)
    if (found.offer.payTo.toLowerCase() !== seller.address.toLowerCase()) throw new Error('unexpected payee')

    // 3. Pay: the buyer signs an EIP-3009 authorization; the facilitator settles it.
    const paid = await payOffer(found.offer, { address: buyer.address, signTypedData: (message) => buyer.signTypedData(message) }, TARGET)
    console.log('paid result', paid.kind, paid.kind === 'paid' ? paid.settlement : '')
    if (paid.kind !== 'paid') throw new Error(`payment was not confirmed: ${JSON.stringify(paid)}`)

    // 4. Verify on chain: the transaction moved exactly the price from the buyer to the seller.
    let verified = false
    for (let attempt = 0; attempt < 15 && !verified; attempt += 1) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: paid.settlement.transaction })
        verified = verifySettlement(receipt, { asset: TARGET.asset, payer: buyer.address, payTo: seller.address, amount: found.offer.amount })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    const after = await balanceOf(buyer.address)
    console.log(`settlement ${TARGET.explorerTx(paid.settlement.transaction)} verified=${verified}`)
    console.log(`buyer balance ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} USDC; seller received ${formatUnits(await balanceOf(seller.address), 6)} USDC`)
    if (!verified) throw new Error('settlement could not be verified on chain')
    console.log('X402 TEST PASSED')
  } finally {
    server.close()
  }
}

main().catch((err) => {
  console.error('X402 TEST FAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
