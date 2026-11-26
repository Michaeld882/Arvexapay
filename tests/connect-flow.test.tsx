import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import type { Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID } from '../src/chain'
import { config } from '../src/config'
import { Providers } from '../src/providers'
import { navigate } from '../src/lib/router'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 40_000
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const realFetch = globalThis.fetch

/**
 * Requests that a test deliberately never answers. They are failed when the test ends: viem keeps one shared
 * in-flight promise per read (for example the block number), so a request that never settles would stay joined by
 * every later test in this process and make its chain reads wait forever.
 */
const unanswered: Array<() => void> = []

afterEach(async () => {
  cleanup()
  globalThis.fetch = realFetch
  window.fetch = realFetch
  for (const fail of unanswered.splice(0)) fail()
  if (config.state.status !== 'disconnected') {
    config.setState((state) => ({ ...state, status: 'connected' }))
    await disconnect(config).catch(() => undefined)
  }
  // Leave no trace of the previous test's wallet in the shared wagmi config.
  config.setState((state) => ({ ...state, status: 'disconnected', current: undefined, connections: new Map() }))
  window.localStorage.clear()
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

const mount = () =>
  render(
    <Providers>
      <App />
    </Providers>,
  )
const setFetch = (impl: typeof fetch) => {
  globalThis.fetch = impl
  window.fetch = impl
}

interface RpcCall {
  id: number
  method: string
  params: unknown[]
}
const callsOf = (init?: RequestInit): RpcCall[] => {
  try {
    const body = JSON.parse(String(init?.body ?? 'null')) as RpcCall | RpcCall[]
    return Array.isArray(body) ? body : [body]
  } catch {
    return []
  }
}

describe('connecting the wallet', () => {
  test('the Dashboard is on screen at once, with skeletons, even while every blockchain request is still waiting', async () => {
    setFetch((() => new Promise((_resolve, reject) => unanswered.push(() => reject(new Error('The test ended before this request was answered.'))))) as unknown as typeof fetch)
    window.history.replaceState({}, '', '/')
    installMockWallet(OWNER, ARC_CHAIN_ID)
    mount()
    await screen.findByRole('button', { name: /Connect Wallet/ }, { timeout: TIMEOUT })
    const started = performance.now()
    await act(async () => {
      await connect(config, { connector: config.connectors[0] })
    })
    expect(await screen.findByText('Wallet balance', {}, { timeout: 3000 })).toBeTruthy()
    expect(performance.now() - started).toBeLessThan(1500)
    expect(screen.queryByText(/An internet-native|Fast, low-cost stablecoin/)).toBeNull()
    // Each section shows its own placeholder; nothing is a full-screen loading page.
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(2)
    expect(screen.queryByTestId('hero-balance')).toBeNull()
    // The rest of the Dashboard is already usable: tap Send, then come back.
    const quick = within(document.querySelector('section[aria-label="Quick actions"]') as HTMLElement)
    fireEvent.click(quick.getByRole('link', { name: 'Send' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Send' }, { timeout: 5000 })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: 5000 })
    expect(await screen.findByText('Wallet balance', {}, { timeout: 5000 })).toBeTruthy()
  }, TIMEOUT)

  test('a saved session being restored shows the Dashboard layout with skeletons, not a blank screen, then the real balance', async () => {
    window.history.replaceState({}, '', '/')
    installMockWallet(OWNER, ARC_CHAIN_ID)
    await connect(config, { connector: config.connectors[0] })
    config.setState((state) => ({ ...state, status: 'reconnecting' }))
    mount()
    expect((document.body.textContent ?? '').trim().length).toBeGreaterThan(40) // the app shell, never a blank screen
    expect(await screen.findByText('Wallet balance', {}, { timeout: 5000 })).toBeTruthy()
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(2)
    expect(document.querySelector('section[aria-label="Quick actions"] a[href="/send"]')).not.toBeNull()
    expect(screen.queryByText(/Built on|Connect Wallet/)).toBeNull()
    act(() => config.setState((state) => ({ ...state, status: 'connected' })))
    expect(await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })).toBeTruthy()
  }, TIMEOUT)

  test('sections load on their own: when the history request fails, the balance and everything else still work and only that section offers a retry', async () => {
    setFetch(((input: RequestInfo | URL, init?: RequestInit) => {
      const calls = callsOf(init)
      if (!calls.some((call) => call.method === 'eth_getLogs')) return realFetch(input, init)
      // Answer the history reads with a rate limit error and forward everything else, keeping the original order.
      const passing = calls.filter((call) => call.method !== 'eth_getLogs')
      const forwarded = passing.length === 0 ? Promise.resolve([] as Array<{ id: number }>) : realFetch(input, { ...init, body: JSON.stringify(passing) }).then((response) => response.json() as Promise<Array<{ id: number }>>)
      return forwarded.then((real) => {
        const byId = new Map(real.map((result) => [result.id, result]))
        const ordered = calls.map((call) => byId.get(call.id) ?? { jsonrpc: '2.0', id: call.id, error: { code: -32005, message: 'rate limit exceeded' } })
        const wasBatch = Array.isArray(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(wasBatch ? ordered : ordered[0]), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    }) as typeof fetch)
    window.history.replaceState({}, '', '/')
    installMockWallet(OWNER, ARC_CHAIN_ID)
    mount()
    await screen.findByRole('button', { name: /Connect Wallet/ }, { timeout: TIMEOUT })
    await act(async () => {
      await connect(config, { connector: config.connectors[0] })
    })
    expect(await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })).toBeTruthy()
    const retry = await screen.findByText('Could not load activity', {}, { timeout: TIMEOUT })
    const recent = retry.closest('section, div[class*="rounded"]') as HTMLElement
    expect(within(recent).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByTestId('hero-balance')).toBeTruthy()
    expect(screen.queryByText('Could not load balances')).toBeNull()
    expect(screen.getByLabelText('Totals unavailable')).toBeTruthy() // no made-up zeros while the history is missing
    fireEvent.click(within(document.querySelector('section[aria-label="Quick actions"]') as HTMLElement).getByRole('link', { name: 'Receive' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Receive' }, { timeout: 5000 })).toBeTruthy()
  }, TIMEOUT * 2)

  test('no duplicate requests: one balance read and no repeated history query, even after visiting Send and coming back', async () => {
    const seen: RpcCall[] = []
    setFetch(((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(...callsOf(init))
      return realFetch(input, init)
    }) as typeof fetch)
    window.history.replaceState({}, '', '/')
    installMockWallet(OWNER, ARC_CHAIN_ID)
    await connect(config, { connector: config.connectors[0] })
    mount()
    await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await act(async () => navigate('/send'))
    await screen.findByRole('heading', { level: 1, name: 'Send' }, { timeout: 5000 })
    await act(async () => navigate('/'))
    await screen.findByTestId('hero-balance', {}, { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const balanceReads = seen.filter((call) => call.method === 'eth_call' && JSON.stringify(call.params).includes(`0x70a08231${OWNER.slice(2).toLowerCase().padStart(64, '0')}`))
    expect(balanceReads).toHaveLength(1)
    const logQueries = seen.filter((call) => call.method === 'eth_getLogs').map((call) => JSON.stringify(call.params))
    expect(new Set(logQueries).size).toBe(logQueries.length)
    expect(seen.filter((call) => call.method === 'eth_chainId').length).toBeLessThan(4)
  }, TIMEOUT)
})
