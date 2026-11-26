import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC, arcMainnet } from '../src/chain'
import { config } from '../src/config'
import { fingerprintOf } from '../src/guardian/checks'
import { beginSubmission, readSubmissions, txLock, updateSubmission } from '../src/guardian/lock'
import { clearReadCache } from '../src/guardian/retry'
import { buildSendPlan } from '../src/lib/plan'
import { parseUsdc } from '../src/onchain-money'
import { Providers } from '../src/providers'
import { installMockWallet, type MockWallet } from './mockWallet'

const TIMEOUT = 30_000
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address
const client = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL, { timeout: 15_000 }) })

let account: Address

/** A real funded EOA, found read-only. Nothing is ever signed with it. */
async function findHolder(): Promise<Address> {
  const head = await client.getBlockNumber()
  const logs = await client.getLogs({
    address: USDC.address,
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    fromBlock: head - 1_000n,
    toBlock: head,
  })
  // Prefer quiet accounts (one transfer in the window) so the balance does not change mid-test.
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

async function openSend(): Promise<MockWallet> {
  window.history.pushState({}, '', '/send')
  const wallet = installMockWallet(account, ARC_CHAIN_ID)
  wallet.setSendMode('hang')
  await connect(config, { connector: config.connectors[0] })
  render(
    <Providers>
      <App />
    </Providers>,
  )
  await screen.findByText(/Wallet balance:/, {}, { timeout: TIMEOUT })
  fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: RECIPIENT } })
  fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.01' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review send' }))
  return wallet
}

beforeAll(async () => {
  account = await findHolder()
}, TIMEOUT)

afterEach(async () => {
  cleanup()
  txLock.reset()
  clearReadCache()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

describe('guardian on the transaction screen', () => {
  test('a good send shows Ready to sign and Simulation passed before the wallet is asked, and signing is recorded', async () => {
    const wallet = await openSend()
    expect(await screen.findByText('Ready to sign', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('Simulation passed')).toBeTruthy()
    // Checking alone never reaches the wallet.
    expect(wallet.sendCount()).toBe(0)
    const confirm = (await screen.findByRole('button', { name: 'Confirm and send' })) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(confirm)
    expect(await screen.findByText('Confirm in your wallet', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(wallet.sendCount()).toBe(1)
    // The wallet request is open but unanswered: the registry holds it with no hash, never an invented one.
    const records = readSubmissions(account)
    expect(records).toHaveLength(1)
    expect(records[0].state).toBe('SIGNING')
    expect(records[0].hash).toBeUndefined()
  }, TIMEOUT * 3)

  test('an identical transaction already waiting for the wallet is blocked, and the wallet is never opened', async () => {
    const plan = buildSendPlan(account, RECIPIENT, parseUsdc('0.01'))
    beginSubmission(account, { fingerprint: fingerprintOf(account, plan), kind: 'send', title: plan.title })
    const wallet = await openSend()
    expect(await screen.findByText('Transaction blocked', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getAllByText(/waiting for your wallet/).length).toBeGreaterThan(0)
    const confirm = (await screen.findByRole('button', { name: 'Confirm and send' })) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(wallet.sendCount()).toBe(0)
  }, TIMEOUT * 3)

  test('a wallet rejection is not a block: it returns to review, forgets the attempt and allows another', async () => {
    window.history.pushState({}, '', '/send')
    const wallet = installMockWallet(account, ARC_CHAIN_ID)
    wallet.setSendMode('reject')
    await connect(config, { connector: config.connectors[0] })
    render(
      <Providers>
        <App />
      </Providers>,
    )
    await screen.findByText(/Wallet balance:/, {}, { timeout: TIMEOUT })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: RECIPIENT } })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review send' }))
    const confirm = (await screen.findByRole('button', { name: 'Confirm and send' })) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(confirm)
    expect(await screen.findByText(/You rejected the request/, {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(readSubmissions(account)).toHaveLength(0)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Confirm and send' }) as HTMLButtonElement).disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }))
    await waitFor(() => expect(wallet.sendCount()).toBe(2), { timeout: TIMEOUT })
  }, TIMEOUT * 4)
})

describe('guardian after a reload', () => {
  const UNMINED = `0x${'ab'.repeat(32)}` as const

  test('a submission that was still pending before the reload is shown, and the same send cannot be started again', async () => {
    const plan = buildSendPlan(account, RECIPIENT, parseUsdc('0.01'))
    const earlier = beginSubmission(account, { fingerprint: fingerprintOf(account, plan), kind: 'send', title: plan.title })
    updateSubmission(account, earlier.id, { state: 'PENDING', hash: UNMINED })
    const wallet = await openSend()
    // The notice restores what the app knows: a submitted transaction that has not confirmed.
    expect(await screen.findByText('A transaction is still in progress', {}, { timeout: TIMEOUT })).toBeTruthy()
    // Starting the identical send again is blocked after its status was read: it is still unmined.
    expect(await screen.findByText('Transaction blocked', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getAllByText(/already submitted and has not finished/).length).toBeGreaterThan(0)
    const confirm = (await screen.findByRole('button', { name: 'Confirm and send' })) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(wallet.sendCount()).toBe(0)
    // Nothing was invented: the registry still holds the one real submission.
    expect(readSubmissions(account)).toHaveLength(1)
  }, TIMEOUT * 3)

  test('a finished transaction is settled from its receipt after the reload and stops showing as in progress', async () => {
    const earlier = beginSubmission(account, { fingerprint: 'unrelated-send', kind: 'send', title: 'Send USDC' })
    // A real Arc transaction that succeeded long ago.
    updateSubmission(account, earlier.id, { state: 'PENDING', hash: '0x003573a264975f93cfa0c1fbde09b31683574498232941b0bbb16a5b6896e7e8' })
    await openSend()
    await waitFor(() => expect(readSubmissions(account).find((item) => item.id === earlier.id)?.state).toBe('CONFIRMED'), { timeout: TIMEOUT })
    expect(screen.queryByText('A transaction is still in progress')).toBeNull()
  }, TIMEOUT * 3)
})
