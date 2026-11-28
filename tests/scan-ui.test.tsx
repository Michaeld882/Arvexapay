import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'
import { config } from '../src/config'
import { txLock } from '../src/guardian/lock'
import { clearReadCache } from '../src/guardian/retry'
import { Providers } from '../src/providers'
import { installMockWallet, type MockWallet } from './mockWallet'

const TIMEOUT = 30_000
const FRIEND = '0x1111111111111111111111111111111111111111'
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

// A stand-in for the camera DEVICE only. It never produces a QR code or a scan result.
interface FakeTrack {
  stopped: number
  stop: () => void
}
let tracks: FakeTrack[] = []
function installCamera(behaviour: 'works' | 'denied' | 'missing'): void {
  const getUserMedia = async () => {
    if (behaviour === 'denied') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    if (behaviour === 'missing') throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' })
    const track: FakeTrack = { stopped: 0, stop: () => { track.stopped += 1 } }
    tracks.push(track)
    const stream = new MediaStream()
    stream.getTracks = () => [track as unknown as MediaStreamTrack]
    return stream
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  HTMLMediaElement.prototype.play = async () => undefined
}

async function openScan(): Promise<MockWallet> {
  window.history.pushState({}, '', '/scan')
  const wallet = installMockWallet(holder, ARC_CHAIN_ID)
  wallet.setSendMode('hang')
  await connect(config, { connector: config.connectors[0] })
  render(
    <Providers>
      <App />
    </Providers>,
  )
  await screen.findByRole('button', { name: /Start camera/ }, { timeout: TIMEOUT })
  return wallet
}

const submitManual = (value: string) => {
  fireEvent.change(screen.getByLabelText('Or enter it manually'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }))
}

beforeAll(async () => {
  holder = await findHolder()
}, TIMEOUT)

beforeEach(() => {
  tracks = []
})

afterEach(async () => {
  cleanup()
  txLock.reset()
  clearReadCache()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
})

describe('scan screen', () => {
  test('camera permission denied shows how to fix it and offers the other ways to pay', async () => {
    installCamera('denied')
    await openScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    expect(await screen.findByText(/Camera permission was denied/, {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('Choose a photo')).toBeTruthy()
    expect(screen.getByLabelText('Or enter it manually')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Start camera/ }).hasAttribute('disabled')).toBe(false) // can try again
  }, TIMEOUT)

  test('no camera on the device is explained', async () => {
    installCamera('missing')
    await openScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    expect(await screen.findByText(/No camera was found on this device/, {}, { timeout: TIMEOUT })).toBeTruthy()
  }, TIMEOUT)

  test('stopping the camera releases it and says the scan was cancelled', async () => {
    installCamera('works')
    await openScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Stop camera/ }, { timeout: TIMEOUT }))
    expect(await screen.findByText(/Scan cancelled/)).toBeTruthy()
    expect(tracks).toHaveLength(1)
    expect(tracks[0].stopped).toBe(1) // the camera is really turned off
  }, TIMEOUT)

  test('manual entry: nothing, text that is not a payment, and other networks each get a clear message', async () => {
    installCamera('works')
    await openScan()
    submitManual('   ')
    expect(await screen.findByText(/Paste a wallet address/)).toBeTruthy()
    submitManual('hello world')
    expect(await screen.findByText('Not a valid payment code')).toBeTruthy()
    submitManual('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    expect(await screen.findByText('Unsupported payment code')).toBeTruthy()
    expect(window.location.pathname).toBe('/scan')
  }, TIMEOUT)

  test('manual entry: a web link is offered as an API payment and nothing is requested from it', async () => {
    installCamera('works')
    await openScan()
    const fetched: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input))
      return realFetch(input, init)
    }) as typeof fetch
    try {
      submitManual('https://api.example.com/data')
      expect(await screen.findByText('This is a web link, not a wallet address')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Open API payments' }))
      await waitFor(() => expect(window.location.pathname).toBe('/payments/x402'))
      expect(new URLSearchParams(window.location.search).get('url')).toBe('https://api.example.com/data')
      expect(fetched.some((url) => url.includes('api.example.com'))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  }, TIMEOUT)

  test('Scan to Payment Details to Confirmation: a payment request lands on the review screen, and the wallet is not asked to sign', async () => {
    installCamera('works')
    const wallet = await openScan()
    submitManual(`ethereum:${USDC.address}@${ARC_CHAIN_ID}/transfer?address=${FRIEND}&uint256=10000`)
    await waitFor(() => expect(window.location.pathname).toBe('/send'))
    expect(window.location.search).toBe(`?to=${getAddress(FRIEND)}&amount=0.01&review=1`)
    // The Send screen opened with the recipient and amount filled in, and the confirmation screen is already up.
    expect(await screen.findByText(/Ready to sign/, {}, { timeout: TIMEOUT })).toBeTruthy()
    expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe(getAddress(FRIEND))
    expect((screen.getByLabelText('Amount in USDC') as HTMLInputElement).value).toBe('0.01')
    expect(wallet.sendCount()).toBe(0)
    expect(wallet.signCount()).toBe(0)
  }, TIMEOUT * 2)

  test('a scanned address with no amount fills the recipient and waits for you to type the amount', async () => {
    installCamera('works')
    const wallet = await openScan()
    submitManual(FRIEND)
    await waitFor(() => expect(window.location.pathname).toBe('/send'))
    await screen.findByText(/Wallet balance:/, {}, { timeout: TIMEOUT })
    expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe(getAddress(FRIEND))
    expect(screen.queryByText(/Ready to sign/)).toBeNull()
    expect(wallet.sendCount()).toBe(0)
  }, TIMEOUT * 2)

  test('a scanned Arvexa payment link opens the Pay screen with its details', async () => {
    installCamera('works')
    await openScan()
    submitManual(`https://arvexa.example/pay?to=${FRIEND}&amount=2&desc=Coffee`)
    await waitFor(() => expect(window.location.pathname).toBe('/pay'))
    expect(new URLSearchParams(window.location.search).get('desc')).toBe('Coffee')
    expect(await screen.findByText('Coffee', {}, { timeout: TIMEOUT })).toBeTruthy()
  }, TIMEOUT * 2)
})
