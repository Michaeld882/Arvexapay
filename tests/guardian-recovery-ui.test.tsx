import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import type { Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID } from '../src/chain'
import { config } from '../src/config'
import { newTransferRecord, transferStore } from '../src/circle/cctp'
import { gatewayStore, type GatewayRecord } from '../src/circle/gateway'
import { chainKey, loadCctpChains } from '../src/circle/sdk'
import { readSubmissions } from '../src/guardian/lock'
import { INTERRUPTED_BEFORE_HASH } from '../src/guardian/recovery'
import { Providers } from '../src/providers'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 60_000
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address

afterEach(async () => {
  cleanup()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

// Every wallet method that can sign, send or change something. Recovery may only ever read.
const WALLET_WRITES = ['eth_sendTransaction', 'eth_signTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']

describe('recovery after a reload never creates a second transaction', () => {
  test('a CCTP transfer that was running and a Gateway request with no hash are restored from the chain, and the wallet is never asked to do anything', async () => {
    const { sources } = await loadCctpChains()
    const source = sources.find((chain) => chainKey(chain) === 'Arbitrum') ?? sources[0]
    // A transfer that had burned (approve and burn finished) when the page was closed, with Circle forwarding the mint.
    const base = newTransferRecord({ owner: ACCOUNT, source, amount: '10', recipient: ACCOUNT, speed: 'FAST', useForwarder: true })
    const running = { ...base, state: 'pending' as const, steps: base.steps.map((step) => ({ ...step, state: step.name === 'approve' || step.name === 'burn' ? ('success' as const) : step.name === 'fetchAttestation' ? ('active' as const) : ('idle' as const) })) }
    transferStore.upsert(ACCOUNT, running)
    const gateway: GatewayRecord = { id: 'g-recovery', createdAt: Date.now(), owner: ACCOUNT, kind: 'deposit', chainName: 'Ethereum', chainKey: 'Ethereum', amount: '5', state: 'pending' }
    gatewayStore.upsert(ACCOUNT, gateway)

    window.history.pushState({}, '', '/circle/bridge')
    const wallet = installMockWallet(ACCOUNT, ARC_CHAIN_ID)
    await connect(config, { connector: config.connectors[0] })
    render(
      <Providers>
        <App />
      </Providers>,
    )

    // The Gateway request that never got a hash is closed honestly, not retried and not called a success.
    await waitFor(() => expect(gatewayStore.read(ACCOUNT).find((item) => item.id === 'g-recovery')?.state).toBe('error'), { timeout: TIMEOUT })
    expect(gatewayStore.read(ACCOUNT).find((item) => item.id === 'g-recovery')?.error).toBe(INTERRUPTED_BEFORE_HASH)
    // The CCTP transfer is read back from Arc. No mint exists for this account, so it is NOT marked complete.
    await waitFor(() => expect(transferStore.read(ACCOUNT).find((item) => item.id === running.id)?.state).toBe('unconfirmed'), { timeout: TIMEOUT })
    const after = transferStore.read(ACCOUNT)
    expect(after).toHaveLength(1)
    expect(after[0].steps.find((step) => step.name === 'burn')?.state).toBe('success')
    expect(after[0].mintHash).toBeUndefined()
    expect(screen.queryByText('USDC minted on Arc')).toBeNull()
    expect(screen.queryByText('Complete')).toBeNull()
    // Nothing was created: the same single transfer, no new registry entries, and not one wallet write.
    expect(readSubmissions(ACCOUNT).filter((item) => item.state === 'SIGNING')).toEqual([])
    expect(wallet.calls.filter((call) => WALLET_WRITES.includes(call.method))).toEqual([])
    expect(wallet.sendCount()).toBe(0)
  }, TIMEOUT * 2)
})
