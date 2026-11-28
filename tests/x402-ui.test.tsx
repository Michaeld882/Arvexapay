import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address } from 'viem'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import App from '../src/App'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'
import { config } from '../src/config'
import { readSubmissions, txLock } from '../src/guardian/lock'
import { clearReadCache } from '../src/guardian/retry'
import { Providers } from '../src/providers'
import { installMockWallet, type MockWallet } from './mockWallet'

const TIMEOUT = 30_000
const PAYEE = '0x3333333333333333333333333333333333333333'
const API = 'https://api.example.test/paid'
const client = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL, { timeout: 15_000 }) })

let holder: Address

/** A real funded EOA found read-only. It is only used as the connected account; nothing is ever signed. */
async function findHolder(): Promise<Address> {
  const head = await client.getBlockNumber()
  const logs = await client.getLogs({ address: USDC.address, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: head - 1_000n, toBlock: head })
  const touches = new Map<string, number>()
  for (const log of logs) for (const who of [log.args.from as Address, log.args.to as Address]) touches.set(who, (touches.get(who) ?? 0) + 1)
  const seen = new Set<string>()
  for (const log of logs) {
    const candidate = log.args.to as Address
    if (touches.get(candidate) !== 1 || seen.has(candidate) || seen.size > 60) continue
    seen.add(candidate)
    const [code, held] = await Promise.all([client.getCode({ address: candidate }), client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [candidate] })])
    if ((!code || code === '0x') && held >= 5_000_000n) return getAddress(candidate)
  }
  throw new Error('No funded EOA found in recent blocks')
}


const realFetch = globalThis.fetch
let apiCalls: Array<{ paid: boolean }> = []

/** The API under test answers like a real x402 seller would (protocol data). Everything else goes to the real network. */
function installApi(amount: string): void {
  apiCalls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith('https://api.example.test')) return realFetch(input, init)
    apiCalls.push({ paid: new Headers(init?.headers).has('payment-signature') })
    const required = { x402Version: 2, resource: { url: API, description: 'Market data', mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: `eip155:${ARC_CHAIN_ID}`, asset: USDC.address, amount, payTo: PAYEE, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }] }
    return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required as never) } })
  }) as typeof fetch
}

async function openX402(mode: 'reject' | 'hang'): Promise<MockWallet> {
  window.history.pushState({}, '', `/payments/x402?url=${encodeURIComponent(API)}`)
  const wallet = installMockWallet(holder, ARC_CHAIN_ID)
  wallet.setSendMode(mode)
  await connect(config, { connector: config.connectors[0] })
  render(
    <Providers>
      <App />
    </Providers>,
  )
  await screen.findByRole('button', { name: /Check price/ }, { timeout: TIMEOUT })
  return wallet
}

beforeAll(async () => {
  holder = await findHolder()
}, TIMEOUT)

afterEach(async () => {
  cleanup()
  globalThis.fetch = realFetch
  txLock.reset()
  clearReadCache()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

describe('API payments (x402)', () => {
  test('the address from a scanned link is filled in, but nothing is requested until you check the price', async () => {
    installApi('10000')
    await openX402('reject')
    expect((screen.getByLabelText('API address') as HTMLInputElement).value).toBe(API)
    expect(apiCalls).toHaveLength(0)
  }, TIMEOUT)

  test('checking shows the real price and payee, and declining the signature pays nothing', async () => {
    installApi('10000')
    const wallet = await openX402('reject')
    fireEvent.click(screen.getByRole('button', { name: /Check price/ }))
    expect(await screen.findByText('This API asks for payment', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('0.01 USDC')).toBeTruthy()
    expect(screen.getByText('api.example.test')).toBeTruthy()
    expect(screen.getByText(/x402 API payment/)).toBeTruthy()
    expect(apiCalls).toEqual([{ paid: false }])

    const pay = await screen.findByRole('button', { name: 'Pay 0.01 USDC' }, { timeout: TIMEOUT })
    await waitFor(() => expect(pay.hasAttribute('disabled')).toBe(false), { timeout: TIMEOUT }) // the balance has loaded
    fireEvent.click(pay)
    expect(await screen.findByText('Payment declined', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText(/Nothing was paid/)).toBeTruthy()
    expect(wallet.signCount()).toBe(1)
    expect(wallet.sendCount()).toBe(0) // no transaction is ever sent from the wallet
    expect(apiCalls.filter((call) => call.paid)).toHaveLength(0) // the API never received a payment
    expect(readSubmissions(holder)).toEqual([]) // nothing is left pending
    expect(screen.queryByText(/settled/i)).toBeNull()
    // And it can be tried again straight away: the lock was released.
    expect(screen.getByRole('button', { name: 'Pay 0.01 USDC' }).hasAttribute('disabled')).toBe(false)
  }, TIMEOUT * 2)

  test('double clicking Pay opens exactly one signature request', async () => {
    installApi('10000')
    const wallet = await openX402('hang')
    fireEvent.click(screen.getByRole('button', { name: /Check price/ }))
    const pay = await screen.findByRole('button', { name: 'Pay 0.01 USDC' }, { timeout: TIMEOUT })
    await waitFor(() => expect(pay.hasAttribute('disabled')).toBe(false), { timeout: TIMEOUT }) // the balance has loaded
    fireEvent.click(pay)
    fireEvent.click(pay)
    fireEvent.click(pay)
    expect(await screen.findByText('Confirm in your wallet', {}, { timeout: TIMEOUT })).toBeTruthy()
    await waitFor(() => expect(wallet.signCount()).toBe(1))
    expect(wallet.signCount()).toBe(1)
  }, TIMEOUT * 2)

  test('a price above the limit cannot be paid', async () => {
    installApi('99000000')
    const wallet = await openX402('reject')
    fireEvent.click(screen.getByRole('button', { name: /Check price/ }))
    expect(await screen.findByText('Cannot pay this API here', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText(/more than Arvexa allows/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull()
    expect(wallet.signCount()).toBe(0)
  }, TIMEOUT)

  test('an unreachable API says why instead of failing silently', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.example.test')) throw new TypeError('Failed to fetch')
      return realFetch(input, init)
    }) as typeof fetch
    await openX402('reject')
    fireEvent.click(screen.getByRole('button', { name: /Check price/ }))
    expect(await screen.findByText('Could not check this API', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText(/does not allow requests from a browser/)).toBeTruthy()
  }, TIMEOUT)

  test('an address that is not secure is flagged before anything is sent', async () => {
    installApi('10000')
    window.history.pushState({}, '', '/payments/x402?url=http%3A%2F%2Fapi.example.test%2Fpaid')
    installMockWallet(holder, ARC_CHAIN_ID)
    await connect(config, { connector: config.connectors[0] })
    render(
      <Providers>
        <App />
      </Providers>,
    )
    expect(await screen.findByText('Only secure https:// addresses can be used.', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Check price/ }).hasAttribute('disabled')).toBe(true)
    expect(getAddress(PAYEE)).toBeTruthy()
  }, TIMEOUT)
})
