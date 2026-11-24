import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'
import { config } from '../src/config'
import { formatUsdcDisplay } from '../src/lib/format'
import { Providers } from '../src/providers'
import { installMockWallet, type MockWallet } from './mockWallet'

const TIMEOUT = 30_000
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const client = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL, { timeout: 15_000 }) })

let account: Address
let balance: bigint

/** Finds a real EOA that currently holds USDC, read-only. Nothing is ever signed with it. */
async function findHolder(): Promise<{ address: Address; balance: bigint }> {
  const head = await client.getBlockNumber()
  const logs = await client.getLogs({
    address: USDC.address,
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    fromBlock: head - 1_000n,
    toBlock: head,
  })
  // Prefer quiet accounts (one transfer in the window) so the displayed balance does not change mid-test.
  const touches = new Map<string, number>()
  for (const log of logs) {
    for (const who of [log.args.from as Address, log.args.to as Address]) touches.set(who, (touches.get(who) ?? 0) + 1)
  }
  const seen = new Set<string>()
  for (const log of logs) {
    const candidate = log.args.to as Address
    if (touches.get(candidate) !== 1) continue
    if (seen.has(candidate) || seen.size > 60) continue
    seen.add(candidate)
    const [code, held] = await Promise.all([
      client.getCode({ address: candidate }),
      client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [candidate] }),
    ])
    if ((!code || code === '0x') && held >= 5_000_000n) return { address: getAddress(candidate), balance: held }
  }
  throw new Error('No funded EOA found in recent blocks')
}

async function open(path: string, wallet?: { chainId: number; account?: Address }): Promise<MockWallet | undefined> {
  window.history.pushState({}, '', path)
  if (!wallet) return undefined
  const mock = installMockWallet(wallet.account ?? account, wallet.chainId)
  await connect(config, { connector: config.connectors[0] })
  return mock
}

beforeAll(async () => {
  const holder = await findHolder()
  account = holder.address
  balance = holder.balance
}, TIMEOUT)

afterEach(async () => {
  cleanup()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

const mount = () =>
  render(
    <Providers>
      <App />
    </Providers>,
  )

describe('wallet and network', () => {
  test('disconnected users see a connect prompt and no balance', async () => {
    await open('/send')
    mount()
    expect(await screen.findByText('Connect your wallet')).toBeTruthy()
    expect(screen.queryByText(/Wallet balance/)).toBeNull()
  })

  test('wrong network is flagged, transactions are gated, and switching works', async () => {
    const wallet = (await open('/send', { chainId: 1 })) as MockWallet
    mount()
    expect(await screen.findByText('Wrong network', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review send' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Switch network' }))
    await waitFor(() => expect(wallet.calls.some((c) => c.method === 'wallet_switchEthereumChain')).toBe(true), { timeout: TIMEOUT })
    await waitFor(() => expect(screen.queryByText('Wrong network')).toBeNull(), { timeout: TIMEOUT })
    expect(wallet.chainId).toBe(ARC_CHAIN_ID)
  }, TIMEOUT * 2)
})

describe('send flow', () => {
  test('shows the real balance and validates before enabling review', async () => {
    await open('/send', { chainId: ARC_CHAIN_ID })
    mount()
    await screen.findByText(`Wallet balance: ${formatUsdcDisplay(balance)} USDC`, {}, { timeout: TIMEOUT })
    const review = screen.getByRole('button', { name: 'Review send' }) as HTMLButtonElement
    expect(review.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: '0x123' } })
    expect(await screen.findByText(/Not a valid address/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: RECIPIENT } })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0' } })
    expect(await screen.findByText('Amount must be greater than zero.')).toBeTruthy()
    expect(review.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: formatUsdcDisplay(balance + 1_000_000n).replace(/,/g, '') } })
    expect(await screen.findByText('Amount is higher than your USDC balance.')).toBeTruthy()
    expect(review.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.01' } })
    await waitFor(() => expect(review.disabled).toBe(false))
  }, TIMEOUT * 2)

  test('wallet rejection returns to review, shows no hash, and sends nothing', async () => {
    const wallet = (await open('/send', { chainId: ARC_CHAIN_ID })) as MockWallet
    wallet.setSendMode('reject')
    mount()
    await screen.findByText(/Wallet balance:/, {}, { timeout: TIMEOUT })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: RECIPIENT } })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review send' }))
    const confirm = (await screen.findByRole('button', { name: 'Confirm and send' })) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(confirm)
    expect(await screen.findByText(/You rejected the request/, {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByText('Transaction hash')).toBeNull()
    expect(screen.queryByText('Confirmed')).toBeNull()
  }, TIMEOUT * 3)

  test('double clicking confirm submits exactly one transaction request', async () => {
    const wallet = (await open('/send', { chainId: ARC_CHAIN_ID })) as MockWallet
    wallet.setSendMode('hang')
    mount()
    await screen.findByText(/Wallet balance:/, {}, { timeout: TIMEOUT })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: RECIPIENT } })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review send' }))
    const confirm = (await screen.findByRole('button', { name: 'Confirm and send' })) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByText('Confirm in your wallet')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(wallet.sendCount()).toBe(1)
    expect(screen.queryByText('Confirmed')).toBeNull()
  }, TIMEOUT * 3)
})

describe('configuration states', () => {
  test('swap, deposit vault and withdraw never pretend to be configured', async () => {
    await open('/swap', { chainId: ARC_CHAIN_ID })
    const first = mount()
    expect(await screen.findByText('Swap liquidity is not configured', { selector: 'p' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Swap unavailable' }) as HTMLButtonElement).disabled).toBe(true)
    first.unmount()

    window.history.pushState({}, '', '/withdraw')
    const second = mount()
    expect((await screen.findAllByText('Contract not configured')).length).toBeGreaterThan(0)
    expect((screen.getByRole('button', { name: 'Review withdrawal' }) as HTMLButtonElement).disabled).toBe(true)
    second.unmount()

    window.history.pushState({}, '', '/deposit')
    mount()
    expect((await screen.findAllByText('Contract not configured')).length).toBeGreaterThan(0)
    expect((screen.getByRole('button', { name: 'Review deposit' }) as HTMLButtonElement).disabled).toBe(true)
  }, TIMEOUT * 2)
})

describe('receive and theme', () => {
  test('receive shows the address, a QR code, and copying reports success', async () => {
    const written: string[] = []
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (text: string) => (written.push(text), Promise.resolve()) }, configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    await open('/receive', { chainId: ARC_CHAIN_ID })
    mount()
    expect((await screen.findAllByText(account, {}, { timeout: TIMEOUT })).length).toBeGreaterThan(0)
    expect(document.querySelector('svg title')?.textContent).toContain(account)
    fireEvent.click(screen.getByRole('button', { name: /Copy address/ }))
    await waitFor(() => expect(written).toEqual([account]))
    expect(await screen.findByText('Copied')).toBeTruthy()
  }, TIMEOUT * 2)

  test('theme switches immediately and persists across a remount', async () => {
    await open('/settings')
    window.localStorage.setItem('arvexa:theme', 'light')
    const view = mount()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Switch to dark theme' }))[0])
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(window.localStorage.getItem('arvexa:theme')).toBe('dark')
    view.unmount()
    mount()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect((await screen.findAllByRole('button', { name: 'Switch to light theme' })).length).toBeGreaterThan(0)
  })
})

describe('RPC failures', () => {
  test('a dead RPC shows a clear error with retry, never a fake balance, and stays bounded', async () => {
    const realFetch = globalThis.fetch
    let attempts = 0
    const dead = (() => {
      attempts++
      return Promise.reject(new TypeError('Failed to fetch'))
    }) as unknown as typeof fetch
    globalThis.fetch = dead
    window.fetch = dead
    try {
      await open('/', { chainId: ARC_CHAIN_ID })
      mount()
      expect(await screen.findByText('Could not load balances', {}, { timeout: TIMEOUT })).toBeTruthy()
      expect(screen.getByText(/RPC is not responding/)).toBeTruthy()
      expect(screen.queryByText('0.00')).toBeNull()
      // Other queries (activity) are still finishing their bounded retries. Wait until traffic stops.
      let settled = -1
      for (let i = 0; i < 20 && settled !== attempts; i++) {
        settled = attempts
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
      expect(attempts).toBe(settled) // no request loop once retries are exhausted
      expect(settled).toBeLessThan(80)
    } finally {
      globalThis.fetch = realFetch
      window.fetch = realFetch
    }
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0])
    expect((await screen.findAllByText(formatUsdcDisplay(balance), { selector: 'span' }, { timeout: TIMEOUT })).length).toBeGreaterThan(0)
  }, TIMEOUT * 3)
})

describe('live activity and request budget', () => {
  test('the dashboard loads real data within a small, bounded number of HTTP requests', async () => {
    const realFetch = globalThis.fetch
    let requests = 0
    const counting = ((...args: Parameters<typeof fetch>) => {
      requests++
      return realFetch(...args)
    }) as typeof fetch
    globalThis.fetch = counting
    window.fetch = counting
    try {
      await open('/', { chainId: ARC_CHAIN_ID })
      mount()
      expect((await screen.findAllByText(formatUsdcDisplay(balance), { selector: 'span' }, { timeout: TIMEOUT })).length).toBeGreaterThan(0)
      await waitFor(() => expect(screen.queryByText('Recent transactions')).toBeTruthy())
      await waitFor(() => expect(document.querySelector('[aria-busy]')).toBeNull(), { timeout: TIMEOUT })
      // Wait until traffic has been quiet for 4 seconds (the activity scan walks block windows one by one).
      let settled = -1
      for (let i = 0; i < 10 && settled !== requests; i++) {
        settled = requests
        await new Promise((resolve) => setTimeout(resolve, 4_000))
      }
      console.log(`BUDGET dashboard HTTP requests after load: ${settled}`)
      expect(requests).toBe(settled)
      expect(settled).toBeLessThan(30)
      expect(screen.queryByText('Could not load activity')).toBeNull()
    } finally {
      globalThis.fetch = realFetch
      window.fetch = realFetch
    }
  }, TIMEOUT * 2)

  test('the activity page lists confirmed transfers with explorer links, or an honest empty state', async () => {
    await open('/activity', { chainId: ARC_CHAIN_ID })
    mount()
    await screen.findByText(/Scanned blocks/, {}, { timeout: TIMEOUT })
    const links = document.querySelectorAll('a[href^="https://explorer.arc.io/tx/"]')
    if (links.length === 0) expect(screen.getAllByText(/No activity found yet/).length).toBeGreaterThan(0)
    else expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Could not load activity/)).toBeNull()
  }, TIMEOUT * 2)
})

describe('back navigation and logo', () => {
  test('every secondary page has Back, and a directly opened page falls back to the dashboard', async () => {
    for (const path of ['/send', '/receive', '/swap', '/deposit', '/withdraw', '/activity', '/settings']) {
      window.history.replaceState({}, '', path)
      const view = mount()
      const back = await screen.findByRole('button', { name: 'Go back' })
      fireEvent.click(back)
      await waitFor(() => expect(window.location.pathname).toBe('/'))
      view.unmount()
    }
  }, TIMEOUT)

  test('the dashboard has no Back button and the header shows the Arvexa logo', async () => {
    window.history.replaceState({}, '', '/')
    mount()
    expect((await screen.findAllByRole('img', { name: 'Arvexa' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull()
  })

  test('Back returns to the previous in-app page when one exists', async () => {
    window.history.replaceState({}, '', '/')
    mount()
    fireEvent.click((await screen.findAllByRole('link', { name: 'Receive' }))[0])
    await screen.findByRole('button', { name: 'Go back' })
    expect((window.history.state as { arvexaDepth?: number }).arvexaDepth).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  }, TIMEOUT)
})

describe('routing, titles and transaction status', () => {
  test('unknown routes show a not-found page with a way home, and titles follow the page', async () => {
    window.history.replaceState({}, '', '/nope')
    const view = mount()
    expect(await screen.findByText('Page not found')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    view.unmount()
    window.history.replaceState({}, '', '/receive')
    mount()
    await waitFor(() => expect(document.title).toBe('Receive | Arvexa'))
  })

  test('a stale local "pending" record is settled from the chain; an unmined hash stays pending', async () => {
    const head = await client.getBlockNumber()
    const logs = await client.getLogs({
      address: USDC.address,
      event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
      fromBlock: head - 200n,
      toBlock: head,
    })
    const minedHash = logs[0].transactionHash as `0x${string}`
    const unmined = `0x${'ab'.repeat(32)}`
    const now = Math.floor(Date.now() / 1000)
    window.localStorage.setItem(
      `arvexa:txs:v1:${account.toLowerCase()}`,
      JSON.stringify([
        { hash: minedHash, kind: 'send', amount: '1000000', status: 'pending', createdAt: now },
        { hash: unmined, kind: 'send', amount: '2000000', status: 'pending', createdAt: now - 5 },
      ]),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: `arvexa:txs:v1:${account.toLowerCase()}` })) // as another tab would
    await open('/activity', { chainId: ARC_CHAIN_ID })
    mount()
    await screen.findByText(/Scanned blocks/, {}, { timeout: TIMEOUT })
    await waitFor(() => expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0), { timeout: TIMEOUT })
    expect(screen.getAllByText('Pending')).toHaveLength(1)
  }, TIMEOUT * 2)
})

describe('animated amount', () => {
  test('counts up to the exact value and finishes there, also under React StrictMode (development)', async () => {
    const { StrictMode } = await import('react')
    const { AnimatedAmount } = await import('@/components/AnimatedAmount')
    const view = render(
      <StrictMode>
        <AnimatedAmount raw={1_234_560_000n} resetKey="a" />
      </StrictMode>,
    )
    await waitFor(() => expect(view.container.textContent).toBe('1,234.56'), { timeout: 5000 })
    view.rerender(
      <StrictMode>
        <AnimatedAmount raw={2_000_000_000n} resetKey="a" />
      </StrictMode>,
    )
    await waitFor(() => expect(view.container.textContent).toBe('2,000.00'), { timeout: 5000 })
  })
})

describe('wallet balance display', () => {
  const read = (who: Address) => client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
  const SMALL = '0x1111111111111111111111111111111111111111' as Address
  const EMPTY = '0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6' as Address // holds no USDC

  const hero = async () => {
    const node = await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    await waitFor(() => expect(node.textContent).not.toBe('—'))
    return node
  }

  test('the hero shows the exact onchain USDC balance, never a rounded 0.00', async () => {
    await open('/', { chainId: ARC_CHAIN_ID, account: SMALL })
    mount()
    const node = await hero()
    const onchain = await read(SMALL)
    expect(onchain).toBeGreaterThan(0n)
    // The amount counts up from zero, so wait for the final exact frame.
    await waitFor(() => expect(node.textContent).toBe(formatUsdcDisplay(onchain)), { timeout: TIMEOUT })
    expect(node.textContent).not.toBe('0.00')
  }, TIMEOUT)

  test('a wallet with no USDC shows 0.00 and explains that only Arc Mainnet is counted', async () => {
    await open('/', { chainId: ARC_CHAIN_ID, account: EMPTY })
    mount()
    expect((await hero()).textContent).toBe('0.00')
    expect(await screen.findByText(/holds no USDC on Arc Mainnet/)).toBeTruthy()
  }, TIMEOUT)

  test('switching accounts in the wallet updates the displayed balance', async () => {
    const mock = await open('/', { chainId: ARC_CHAIN_ID, account: EMPTY })
    mount()
    expect((await hero()).textContent).toBe('0.00')
    mock?.setAccount(SMALL)
    const expected = formatUsdcDisplay(await read(SMALL))
    await waitFor(() => expect(document.querySelector('[data-testid="hero-balance"]')?.textContent).toBe(expected), { timeout: TIMEOUT })
    expect(screen.queryByText(/holds no USDC on Arc Mainnet/)).toBeNull()
  }, TIMEOUT * 2)

  test('the refresh button re-reads the balance with one more request', async () => {
    await open('/', { chainId: ARC_CHAIN_ID, account: SMALL })
    mount()
    await hero()
    await new Promise((resolve) => setTimeout(resolve, 3_500)) // let the activity scan settle
    const realFetch = globalThis.fetch
    let reads = 0
    const counting = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof init?.body === 'string' && init.body.includes('eth_call')) reads++
      return realFetch(input, init)
    }) as typeof fetch
    globalThis.fetch = counting
    window.fetch = counting
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh balance' }))
      await waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: TIMEOUT })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(reads).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      window.fetch = realFetch
    }
  }, TIMEOUT * 2)
})

describe('no platform attribution', () => {
  test('no "Built with" badge, watermark or studio link renders on any page', async () => {
    for (const path of ['/', '/send', '/receive', '/swap', '/deposit', '/withdraw', '/activity', '/settings']) {
      window.history.replaceState({}, '', path)
      const view = mount()
      await screen.findAllByRole('img', { name: 'Arvexa' })
      expect(document.body.textContent).not.toMatch(/built with|arc studio/i)
      expect(document.querySelector('a[href*="studio.arc.io"]')).toBeNull()
      view.unmount()
    }
  })
})
