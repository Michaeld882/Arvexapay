import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import type { Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID } from '../src/chain'
import { config } from '../src/config'
import { Providers } from '../src/providers'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 20_000
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address

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

describe('the one intro screen', () => {
  test('a first visit opens on the intro with Arc, the four features and the Connect Wallet button, and no wallet data', async () => {
    window.history.pushState({}, '', '/')
    mount()
    expect(await screen.findByText('Built on', { exact: false }, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('Fast, low-cost stablecoin payments powered by Arc.')).toBeTruthy()
    for (const title of ['Send & Receive', 'Scan & Pay', 'Split Payment', 'Request Pay']) expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Connect Wallet/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
    expect(screen.queryByText(/Coming soon/i)).toBeNull()
    expect(screen.queryByTestId('hero-balance')).toBeNull()
    expect(screen.queryByText('Recent transactions')).toBeNull()
  }, TIMEOUT)

  test('cards expand and collapse on the same screen with the described text, one at a time', async () => {
    mount()
    const request = await screen.findByRole('button', { name: /Request Pay/ }, { timeout: TIMEOUT })
    expect(screen.getByRole('button', { name: /Send & Receive/ }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(request)
    await waitFor(() => expect(request.getAttribute('aria-expanded')).toBe('true'))
    await waitFor(() => expect(screen.getByRole('button', { name: /Send & Receive/ }).getAttribute('aria-expanded')).toBe('false'))
    expect(await screen.findByText('Create a payment link with an amount and reference, then track the payment status.')).toBeTruthy()
    expect(window.location.pathname).toBe('/')
  }, TIMEOUT)

  test('Connect Wallet opens the existing wallet modal on this screen, with no extra page in between', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Connect Wallet/ }, { timeout: TIMEOUT }))
    expect(await screen.findByRole('dialog', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByText('Connect your wallet')).toBeNull()
    expect(screen.getByText('Fast, low-cost stablecoin payments powered by Arc.')).toBeTruthy()
  }, TIMEOUT)

  test('once the wallet connects, the existing app shows right away and the intro is gone', async () => {
    window.history.pushState({}, '', '/')
    installMockWallet(ACCOUNT, ARC_CHAIN_ID)
    mount()
    await screen.findByRole('button', { name: /Connect Wallet/ }, { timeout: TIMEOUT })
    await connect(config, { connector: config.connectors[0] })
    expect(await screen.findByText('Recent transactions', {}, { timeout: TIMEOUT })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Fast, low-cost stablecoin payments powered by Arc.')).toBeNull(), { timeout: TIMEOUT })
    expect(screen.queryByText('Connect your wallet')).toBeNull()
  }, TIMEOUT)

  test('the intro stays while the wallet is disconnected: no timer, no auto-advance, no connect page, and it returns after a reload', async () => {
    mount()
    await screen.findByRole('button', { name: /Connect Wallet/ }, { timeout: TIMEOUT })
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(screen.getByText('Fast, low-cost stablecoin payments powered by Arc.')).toBeTruthy()
    expect(screen.queryByText('Connect your wallet')).toBeNull()
    expect(window.localStorage.getItem('arvexa:onboarding:v1')).toBeNull()
    cleanup()
    mount()
    expect(await screen.findByRole('button', { name: /Connect Wallet/ }, { timeout: TIMEOUT })).toBeTruthy()
  }, TIMEOUT)

  test('a wallet that is already connected opens straight into the app', async () => {
    window.history.pushState({}, '', '/')
    installMockWallet(ACCOUNT, ARC_CHAIN_ID)
    await connect(config, { connector: config.connectors[0] })
    mount()
    expect(await screen.findByText('Recent transactions', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByText('Fast, low-cost stablecoin payments powered by Arc.')).toBeNull()
  }, TIMEOUT)
})
