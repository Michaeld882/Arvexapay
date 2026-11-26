import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import type { Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID } from '../src/chain'
import { config } from '../src/config'
import { findArcMintSince, verifyArcMintByHash } from '../src/circle/arrival'
import { canCheckArrival, findUnsettledDuplicate, isResumable, newTransferRecord, recheckTransfer, recoveryAdvice, type TransferRecord } from '../src/circle/cctp'
import { loadCctpChains, loadGatewayChains } from '../src/circle/sdk'
import { createExclusive } from '../src/circle/store'
import { runCircleChecks } from '../src/circle/verify'
import { cpnRail, toPaymentRecord } from '../src/circle/payments/rails'
import { Providers } from '../src/providers'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 40_000
// An address with no funds on any chain. The mock wallet never signs or returns a hash.
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address

async function open(path: string) {
  window.history.pushState({}, '', path)
  const wallet = installMockWallet(ACCOUNT, ARC_CHAIN_ID)
  await connect(config, { connector: config.connectors[0] })
  return wallet
}

const mount = () => {
  return render(
    <Providers>
      <App />
    </Providers>,
  )
}

afterEach(async () => {
  cleanup()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

describe('circle registry (live)', () => {
  test('Arc is a CCTP destination and a Gateway chain, with real source chains', async () => {
    const cctp = await loadCctpChains()
    expect(cctp.destination.chainId).toBe(ARC_CHAIN_ID)
    expect(cctp.destination.cctp?.domain).toBe(26)
    expect(cctp.sources.length).toBeGreaterThan(5)
    expect(cctp.sources.every((chain) => chain.chainId !== ARC_CHAIN_ID && Boolean(chain.usdcAddress))).toBe(true)
    const gateway = await loadGatewayChains()
    expect(gateway.arc.chainId).toBe(ARC_CHAIN_ID)
    expect(gateway.chains.every((chain) => !chain.isTestnet)).toBe(true)
  }, TIMEOUT)
})

// A real USDC mint on Arc Mainnet (Transfer from the zero address), used to test verification against the real chain.
const MINT_HASH = '0x003573a264975f93cfa0c1fbde09b31683574498232941b0bbb16a5b6896e7e8' as const
const MINT_TO = '0x401dF9869C0132bE31912f5Db3D663E1197CEf08' as Address
const MINT_VALUE = 1_000_000n

describe('live configuration checks', () => {
  test('every Circle check passes against Arc Mainnet and the Circle registry', async () => {
    const checks = await runCircleChecks()
    expect(checks.filter((check) => !check.ok)).toEqual([])
    expect(checks.length).toBeGreaterThanOrEqual(13)
  }, TIMEOUT)
})

describe('arrival verification (real Arc data, read only)', () => {
  test('a real mint is verified, and the wrong recipient or a too-small ceiling is rejected', async () => {
    const ok = await verifyArcMintByHash({ hash: MINT_HASH, recipient: MINT_TO, maxAmount: MINT_VALUE })
    expect(ok.state).toBe('verified')
    if (ok.state === 'verified') expect(ok.received).toBe(MINT_VALUE)
    expect((await verifyArcMintByHash({ hash: MINT_HASH, recipient: ACCOUNT, maxAmount: MINT_VALUE })).state).toBe('not_found')
    expect((await verifyArcMintByHash({ hash: MINT_HASH, recipient: MINT_TO, maxAmount: MINT_VALUE - 1n })).state).toBe('not_found')
  }, TIMEOUT)

  test('no mint is invented for an address that never received one', async () => {
    const result = await findArcMintSince({ recipient: ACCOUNT, maxAmount: 10_000_000n, sinceMs: Date.now() - 60_000 })
    expect(result.state).toBe('not_found')
  }, TIMEOUT)
})

describe('cctp transfer recovery', () => {
  async function record(steps: Array<[string, string, string?]>, extra: Partial<TransferRecord> = {}): Promise<TransferRecord> {
    const { sources } = await loadCctpChains()
    const base = newTransferRecord({ owner: ACCOUNT, source: sources[0], amount: '1', recipient: ACCOUNT, speed: 'FAST', useForwarder: true })
    return {
      ...base,
      steps: base.steps.map((step) => {
        const found = steps.find(([name]) => name === step.name)
        return found ? { ...step, state: found[1] as never, txHash: found[2] } : { ...step, state: 'idle' }
      }),
      ...extra,
    }
  }

  test('Circle saying done is not success until Arc shows the mint', async () => {
    const claimed = await record([['approve', 'success'], ['burn', 'success'], ['fetchAttestation', 'success'], ['mint', 'success']], { state: 'confirming' })
    const updates: TransferRecord[] = []
    const next = await recheckTransfer({ record: claimed, onUpdate: (item) => updates.push(item) })
    expect(next.state).toBe('unconfirmed')
    expect(next.mintHash).toBeUndefined()
    expect(updates.some((item) => item.state === 'success')).toBe(false)
  }, TIMEOUT)

  test('a real mint on Arc settles the transfer with the amount it credited', async () => {
    const claimed = await record([['burn', 'success'], ['mint', 'success', MINT_HASH]], { state: 'unconfirmed', recipient: MINT_TO, amount: '1' })
    const next = await recheckTransfer({ record: claimed, onUpdate: () => undefined })
    expect(next.state).toBe('success')
    expect(next.mintHash).toBe(MINT_HASH)
    expect(next.received).toBe('1')
  }, TIMEOUT)

  test('recovery advice tells apart: nothing burned, burned and resumable, burned and interrupted', async () => {
    const before = await record([['approve', 'success'], ['burn', 'error']], { state: 'error', error: 'You rejected the request in your wallet.' })
    expect(recoveryAdvice(before, false)?.body).toContain('No USDC was burned')
    expect(isResumable(before)).toBe(false)

    const burned = await record([['approve', 'success'], ['burn', 'success', `0x${'11'.repeat(32)}`], ['fetchAttestation', 'error']], { state: 'error', error: 'Attestation timed out.' })
    expect(recoveryAdvice(burned, false)?.body).toContain('in transit and not lost')
    expect(isResumable(burned)).toBe(false) // no saved SDK result, so a resume would be impossible
    expect(isResumable({ ...burned, result: {} as never })).toBe(true)
    expect(canCheckArrival(burned)).toBe(true)

    const closed = await record([['approve', 'success'], ['burn', 'success', `0x${'11'.repeat(32)}`]], { state: 'pending', useForwarder: false })
    expect(recoveryAdvice(closed, true)?.title).toBe('Interrupted after the burn')
    expect(canCheckArrival(closed)).toBe(false)
  })
})

describe('one operation at a time', () => {
  test('a second operation cannot start until the first is released, and only its owner can release it', () => {
    const lock = createExclusive()
    expect(lock.tryAcquire('a')).toBe(true)
    expect(lock.tryAcquire('b')).toBe(false)
    lock.release('b')
    expect(lock.current()).toBe('a')
    lock.release('a')
    expect(lock.tryAcquire('b')).toBe(true)
  })

  test('the same transfer cannot burn twice: an unfinished burn of that amount blocks a new one', async () => {
    const { sources } = await loadCctpChains()
    const base = newTransferRecord({ owner: ACCOUNT, source: sources[0], amount: '3', recipient: ACCOUNT, speed: 'FAST', useForwarder: true })
    const burned: TransferRecord = { ...base, state: 'unconfirmed', steps: base.steps.map((step) => (step.name === 'approve' || step.name === 'burn' ? { ...step, state: 'success' as const } : step)) }
    const key = { sourceChain: base.sourceChain, amount: '3' }
    expect(findUnsettledDuplicate([burned], key)?.id).toBe(burned.id)
    expect(findUnsettledDuplicate([burned], { ...key, amount: '4' })).toBeUndefined()
    expect(findUnsettledDuplicate([{ ...burned, state: 'success' }], key)).toBeUndefined()
    expect(findUnsettledDuplicate([{ ...base, state: 'error', steps: base.steps.map((step) => ({ ...step, state: 'idle' as const })) }], key)).toBeUndefined()
  })
})

describe('payment rails', () => {
  test('Circle Payments Network never reports active without access and cannot submit', () => {
    const readiness = cpnRail.readiness()
    expect(readiness.status).not.toBe('active')
    expect(cpnRail.submit).toBeUndefined()
  })

  test('a local transaction maps to a payment with its real hash and an honest settlement state', () => {
    const hash = `0x${'ab'.repeat(32)}` as const
    const base = { hash, kind: 'send' as const, amount: '2500000', to: ACCOUNT, createdAt: 1 }
    expect(toPaymentRecord({ ...base, status: 'pending' }).settlement.state).toBe('pending')
    expect(toPaymentRecord({ ...base, status: 'success' }).settlement.state).toBe('settled')
    expect(toPaymentRecord({ ...base, status: 'failed' }).status).toBe('failed')
    expect(toPaymentRecord({ ...base, status: 'success' }).settlement.reference).toBe(hash)
  })
})

describe('disabled buttons explain themselves', () => {
  test('Send says what is missing before the review button can be used', async () => {
    await open('/send')
    mount()
    expect(((await screen.findByRole('button', { name: 'Review send' }, { timeout: TIMEOUT })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('disabled-reason').textContent).toBe('Enter a recipient address to continue.')
    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: '0x3333333333333333333333333333333333333333' } })
    await waitFor(() => expect(screen.getByTestId('disabled-reason').textContent).toBe('Enter an amount to continue.'))
  }, TIMEOUT * 2)

  test('Withdraw explains what is missing, and the vault options stay hidden while no vault is configured', async () => {
    await open('/withdraw')
    mount()
    expect(await screen.findByRole('button', { name: 'Review cash out' }, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByTestId('disabled-reason').textContent).toBe('Enter a recipient address to continue.')
    expect(screen.queryByText('Contract not configured')).toBeNull()
  }, TIMEOUT * 2)
})

describe('circle pages', () => {
  test('overview shows USDC on Arc verified onchain and Circle Payments Network as needing access', async () => {
    await open('/circle')
    mount()
    expect(await screen.findByText('Integration status')).toBeTruthy()
    expect((await screen.findAllByText('Verified on Arc Mainnet', {}, { timeout: TIMEOUT })).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(4), { timeout: TIMEOUT })
    expect(screen.getAllByText('Needs Circle access').length).toBeGreaterThan(0)
    expect(screen.getByText(/Live now, no Circle credentials needed/)).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('check-summary').textContent).toMatch(/^(\d+) of \1 checks passed$/), { timeout: TIMEOUT })
  }, TIMEOUT * 2)

  test('bridge page loads Circle routes and blocks an amount larger than the source wallet balance', async () => {
    await open('/circle/bridge')
    mount()
    const select = (await screen.findByLabelText('From', {}, { timeout: TIMEOUT })) as HTMLSelectElement
    expect(select.options.length).toBeGreaterThan(5)
    const button = screen.getByRole('button', { name: /Enter an amount/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '999999999999' } })
    expect(await screen.findByText(/higher than your USDC balance/, {}, { timeout: TIMEOUT })).toBeTruthy()
    expect((screen.getByRole('button', { name: /Bridge|Enter an amount/ }) as HTMLButtonElement).disabled).toBe(true)
  }, TIMEOUT * 2)

  test('starting a bridge asks the wallet, and a rejected request leaves an honest "nothing burned" state', async () => {
    const wallet = await open('/circle/bridge')
    mount()
    expect(await screen.findByText(/Ethereum balance: /, {}, { timeout: TIMEOUT })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '1' } })
    const button = (await screen.findByRole('button', { name: /^Bridge 1(\.0+)? USDC to Arc$/ })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    // The mock wallet rejects every signature request and never returns a hash, so nothing can succeed.
    expect(await screen.findByText('Transfer stopped before the burn', {}, { timeout: TIMEOUT * 2 })).toBeTruthy()
    expect(screen.getByText(/No USDC was burned/)).toBeTruthy()
    expect(screen.getAllByText(/You rejected the request in your wallet/).length).toBeGreaterThan(0)
    expect(wallet.calls.some((call) => call.method === 'wallet_switchEthereumChain')).toBe(true)
    expect(screen.queryByText('USDC minted on Arc')).toBeNull()
    expect(screen.queryByText('Complete')).toBeNull()
  }, TIMEOUT * 4)

  test('a Gateway deposit that the wallet cannot sign ends as a failure, never as a success', async () => {
    await open('/circle/gateway')
    mount()
    expect(await screen.findByText(/Ethereum wallet balance: /, {}, { timeout: TIMEOUT })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '1' } })
    const button = (await screen.findByRole('button', { name: 'Top Up Gateway' })) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect(await screen.findByText('Top up stopped', {}, { timeout: TIMEOUT * 2 })).toBeTruthy()
    expect(screen.getAllByText(/No success was assumed/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Top up confirmed')).toBeNull()
  }, TIMEOUT * 4)

  test('gateway page shows its own balance, separate from the wallet balance', async () => {
    await open('/circle/gateway')
    mount()
    expect(await screen.findByText('Gateway balance')).toBeTruthy()
    expect(await screen.findByTestId('gateway-balance', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText(/Not in Gateway/)).toBeTruthy()
  }, TIMEOUT * 2)
})
