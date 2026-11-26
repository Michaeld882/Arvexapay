import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import type { Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID } from '../src/chain'
import { config } from '../src/config'
import { isPagePreloaded } from '../src/lib/pages'
import { Providers } from '../src/providers'
import { navigate } from '../src/lib/router'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 30_000
const OWNER = '0x2222222222222222222222222222222222222222' as Address

afterEach(async () => {
  cleanup()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

async function open(path: string) {
  window.history.replaceState({}, '', path)
  installMockWallet(OWNER, ARC_CHAIN_ID)
  await connect(config, { connector: config.connectors[0] })
}
const mount = () =>
  render(
    <Providers>
      <App />
    </Providers>,
  )
const go = (path: string) => act(() => navigate(path))
const SECONDARY = ['/send', '/receive', '/scan', '/swap', '/deposit', '/withdraw', '/activity', '/settings', '/payments', '/payments/split', '/payments/links', '/payments/invoices', '/payments/requests', '/payments/merchant', '/payments/receipts', '/payments/customers', '/payments/reminders', '/payments/contacts', '/circle', '/circle/bridge', '/circle/gateway']

describe('every feature page', () => {
  test('opens at once with a visible Back button and a title, and Back returns to the Dashboard it came from', async () => {
    await open('/')
    mount()
    await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    for (const path of SECONDARY) {
      const started = performance.now()
      await go(path)
      const back = await screen.findByRole('button', { name: 'Go back' }, { timeout: 5000 })
      expect(back.textContent, path).toContain('Back')
      expect((await screen.findByRole('heading', { level: 1 }, { timeout: 5000 })).textContent?.length, `${path} has a title`).toBeGreaterThan(0)
      expect(window.location.pathname).toBe(path)
      expect(performance.now() - started, `${path} opened quickly`).toBeLessThan(4000)
      expect((document.body.textContent ?? '').trim().length, `${path} is not blank`).toBeGreaterThan(40)
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
      await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: 5000 })
      await screen.findByTestId('hero-balance', {}, { timeout: 5000 })
    }
  }, TIMEOUT * 3)
})

describe('history', () => {
  test('the device back button steps through the screens you visited and never reloads the app', async () => {
    await open('/')
    mount()
    await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    const header = document.querySelector('header')
    await go('/send')
    await screen.findByRole('heading', { level: 1, name: 'Send' }, { timeout: 5000 })
    await go('/payments/split')
    await screen.findByRole('heading', { level: 1, name: 'Split Payment' }, { timeout: 5000 })
    act(() => window.history.back())
    await waitFor(() => expect(window.location.pathname).toBe('/send'), { timeout: 5000 })
    await screen.findByRole('heading', { level: 1, name: 'Send' }, { timeout: 5000 })
    act(() => window.history.back())
    await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: 5000 })
    await screen.findByTestId('hero-balance', {}, { timeout: 5000 })
    expect(document.querySelector('header')).toBe(header) // the same page the whole time: nothing reloaded
  }, TIMEOUT * 2)

  test('opening the same feature again adds nothing to the history', async () => {
    await open('/')
    mount()
    await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    const realPush = window.history.pushState.bind(window.history)
    let pushes = 0
    window.history.pushState = (...args: Parameters<History['pushState']>) => {
      pushes += 1
      realPush(...args)
    }
    try {
      for (let i = 0; i < 3; i++) await go('/send')
      fireEvent.click(screen.getAllByRole('link', { name: 'Send' })[0])
      expect(pushes).toBe(1)
      await go('/receive')
      expect(pushes).toBe(2)
    } finally {
      window.history.pushState = realPush
    }
  }, TIMEOUT)

  test('a page opened directly has the Dashboard behind it, so the device back button does not leave the app', async () => {
    await open('/payments/split')
    mount()
    await screen.findByRole('heading', { level: 1, name: 'Split Payment' }, { timeout: TIMEOUT })
    await waitFor(() => expect((window.history.state as { arvexaDepth?: number }).arvexaDepth).toBe(1))
    act(() => window.history.back())
    await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: 5000 })
    await screen.findByTestId('hero-balance', {}, { timeout: 5000 })
  }, TIMEOUT)
})

describe('speed and loading', () => {
  test('a screen starts downloading as soon as a finger or pointer reaches its link', async () => {
    await open('/')
    mount()
    await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    const link = document.querySelector('section[aria-label="Quick actions"] a[href="/payments/merchant"]') as HTMLElement
    fireEvent.pointerEnter(link)
    expect(isPagePreloaded('/payments/merchant')).toBe(true)
  }, TIMEOUT)

  test('a page opens immediately with skeletons even when the network never answers, and Back still works', async () => {
    const realFetch = globalThis.fetch
    const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch
    globalThis.fetch = hang
    window.fetch = hang
    try {
      await open('/payments')
      const started = performance.now()
      mount()
      expect(await screen.findByRole('heading', { level: 1, name: 'Payments' }, { timeout: 5000 })).toBeTruthy()
      expect(await screen.findByText('Payment overview', {}, { timeout: 5000 })).toBeTruthy()
      expect(performance.now() - started).toBeLessThan(5000)
      expect(document.querySelector('[aria-busy="true"]') !== null).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
      await waitFor(() => expect(window.location.pathname).toBe('/'), { timeout: 5000 })
    } finally {
      globalThis.fetch = realFetch
      window.fetch = realFetch
    }
  }, TIMEOUT)
})
