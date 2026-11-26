import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import type { Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID } from '../src/chain'
import { config } from '../src/config'
import { readSubmissions } from '../src/guardian/lock'
import { clearReadCache } from '../src/guardian/retry'
import { FEE_TOO_SMALL_MESSAGE } from '../src/circle/cctpFee'
import { Providers } from '../src/providers'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 40_000
// An address that holds USDC on Ethereum. The mock wallet never signs or returns a hash.
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address

afterEach(async () => {
  cleanup()
  clearReadCache()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

describe('cctp guardian on the bridge screen', () => {
  test('a very small amount is stopped by the fee check before the wallet is asked to do anything', async () => {
    window.history.pushState({}, '', '/circle/bridge')
    const wallet = installMockWallet(ACCOUNT, ARC_CHAIN_ID)
    await connect(config, { connector: config.connectors[0] })
    render(
      <Providers>
        <App />
      </Providers>,
    )
    expect(await screen.findByText(/Ethereum balance: /, {}, { timeout: TIMEOUT })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.000063' } })
    expect((await screen.findAllByText(new RegExp(FEE_TOO_SMALL_MESSAGE.replace(/[.]/g, '\\.')), {}, { timeout: TIMEOUT })).length).toBeGreaterThan(0)
    expect(screen.getByText('Transaction blocked')).toBeTruthy()
    const button = screen.getByRole('button', { name: /^Bridge 0\.000063 USDC to Arc$/ }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(true))
    fireEvent.click(button)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // No chain switch, no approval, no signature: the wallet was never involved, and nothing was recorded.
    expect(wallet.calls.some((call) => call.method === 'wallet_switchEthereumChain' || call.method === 'eth_sendTransaction')).toBe(false)
    expect(readSubmissions(ACCOUNT)).toHaveLength(0)
    expect(screen.queryByText('Complete')).toBeNull()
  }, TIMEOUT * 2)
})
