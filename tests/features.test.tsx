import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address, type Hex } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC } from '../src/chain'
import { Stepper, stepFor } from '../src/components/TxStepper'
import { config } from '../src/config'
import { Providers } from '../src/providers'
import type { ActivityItem } from '../src/lib/activity'
import { addContact, checkContact, contactFor, readContacts, removeContact, updateContact } from '../src/lib/contacts'
import { computeInsights } from '../src/lib/insights'
import { parsePaymentQr, sendLink } from '../src/lib/paymentQr'
import { buildSendPlan, withMeta } from '../src/lib/plan'
import { readTxMeta, setTxMeta } from '../src/lib/txMeta'
import { installMockWallet } from './mockWallet'

const TIMEOUT = 30_000
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const FRIEND = '0x3333333333333333333333333333333333333333' as Address
const OTHER = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex

/** A real, funded wallet on Arc Mainnet (found from recent transfers) so the Send review can be opened. It never signs. */
let funded: Address
beforeAll(async () => {
  const client = createPublicClient({ transport: http(ARC_RPC_URL) })
  const head = await client.getBlockNumber()
  const logs = await client.getLogs({ address: USDC.address, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: head - 400n, toBlock: head })
  for (const log of logs.slice(0, 60)) {
    const candidate = log.args.to as Address
    const [code, held] = await Promise.all([client.getCode({ address: candidate }), client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [candidate] })])
    if ((!code || code === '0x') && held >= 5_000_000n) {
      funded = getAddress(candidate)
      return
    }
  }
  throw new Error('No funded EOA found in recent blocks')
}, TIMEOUT)

afterEach(async () => {
  cleanup()
  if (config.state.status === 'connected') await disconnect(config)
  window.localStorage.clear()
  window.dispatchEvent(new StorageEvent('storage', { key: null })) // drop the in-memory copies, as another tab clearing storage would
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

const mount = () =>
  render(
    <Providers>
      <App />
    </Providers>,
  )

async function open(path: string, account: Address = OWNER) {
  window.history.pushState({}, '', path)
  const wallet = installMockWallet(account, ARC_CHAIN_ID)
  await connect(config, { connector: config.connectors[0] })
  return wallet
}

describe('saved addresses', () => {
  test('add, name, edit, delete and look up, with validation before anything is saved', () => {
    expect(checkContact(OWNER, { name: '', address: FRIEND }).ok).toBe(false)
    expect(checkContact(OWNER, { name: 'Brother', address: 'not-an-address' }).ok).toBe(false)
    expect(checkContact(OWNER, { name: 'Token', address: USDC.address }).ok).toBe(false)
    expect(checkContact(OWNER, { name: 'Me', address: OWNER })).toMatchObject({ ok: false, field: 'address' })
    expect(addContact(OWNER, { name: 'x'.repeat(40), address: FRIEND }).ok).toBe(false)
    expect(readContacts(OWNER)).toHaveLength(0)

    const added = addContact(OWNER, { name: '  Brother ', address: FRIEND.toLowerCase() })
    expect(added.ok).toBe(true)
    const [saved] = readContacts(OWNER)
    expect(saved.name).toBe('Brother')
    expect(saved.address).toBe(getAddress(FRIEND))
    expect(contactFor(readContacts(OWNER), FRIEND)?.name).toBe('Brother')

    expect(addContact(OWNER, { name: 'Dup address', address: FRIEND })).toMatchObject({ ok: false, field: 'address' })
    expect(addContact(OWNER, { name: 'brother', address: OTHER })).toMatchObject({ ok: false, field: 'name' })

    expect(updateContact(OWNER, saved.id, { name: 'Client', address: OTHER }).ok).toBe(true)
    expect(readContacts(OWNER)[0]).toMatchObject({ name: 'Client', address: getAddress(OTHER) })
    removeContact(OWNER, saved.id)
    expect(readContacts(OWNER)).toHaveLength(0)
  })

  test('contacts are kept per wallet and survive a reload from localStorage', () => {
    addContact(OWNER, { name: 'Work', address: FRIEND })
    expect(readContacts(OTHER)).toHaveLength(0)
    const raw = window.localStorage.getItem(`arvexa:contacts:v1:${OWNER.toLowerCase()}`) ?? ''
    expect(raw).toContain('Work')
    expect(raw).not.toMatch(/private|seed|mnemonic/i)
  })

  test('the Contacts page lets you add a saved address, then the Send screen offers it in one tap', async () => {
    await open('/payments/contacts')
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Add address/ }, { timeout: TIMEOUT }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Friend' } })
    fireEvent.change(screen.getByLabelText('Wallet address'), { target: { value: 'nope' } })
    expect((screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toMatch(/Not a valid address/)
    fireEvent.change(screen.getByLabelText('Wallet address'), { target: { value: FRIEND } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save address' }).closest('form') as HTMLFormElement)
    await waitFor(() => expect(readContacts(OWNER)).toHaveLength(1), { timeout: TIMEOUT })
    expect(await screen.findByText('Friend', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(readContacts(OWNER)).toHaveLength(1)

    cleanup()
    window.history.pushState({}, '', '/send')
    mount()
    await screen.findByLabelText('Recipient address', {}, { timeout: TIMEOUT })
    const chip = await screen.findByRole('button', { name: 'Friend' }, { timeout: TIMEOUT })
    fireEvent.click(chip)
    await waitFor(() => expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe(getAddress(FRIEND)))
    expect(screen.getByText(/Saved as/)).toBeTruthy()
  }, TIMEOUT * 2)
})

describe('payment notes and categories', () => {
  test('a note and category are saved against the real hash, never into the transaction call', () => {
    const plan = buildSendPlan(OWNER, FRIEND, 1_000_000n)
    const withNote = withMeta(plan, { note: 'Lunch payment', category: 'Food' })
    expect(withNote.call).toEqual(plan.call)
    expect(withNote.rows.some((row) => row.value === 'Lunch payment')).toBe(true)
    expect(withMeta(plan, {})).toBe(plan)

    setTxMeta(OWNER, HASH, withNote.meta ?? {})
    expect(readTxMeta(OWNER, HASH)).toMatchObject({ note: 'Lunch payment', category: 'Food' })
    setTxMeta(OWNER, HASH, { note: '   ', category: undefined })
    expect(readTxMeta(OWNER, HASH)).toBeUndefined()
  })

  test('the send review shows the note, the four-step tracker starts at Preparing, and nothing is sent', async () => {
    const wallet = await open('/send', funded)
    mount()
    await screen.findByText(/Wallet balance:/, {}, { timeout: TIMEOUT })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: FRIEND } })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0.01' } })
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Internet bill' } })
    fireEvent.click(screen.getByRole('button', { name: 'Bills' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review send' }))
    expect(await screen.findByText('Internet bill', {}, { timeout: TIMEOUT })).toBeTruthy()
    const steps = screen.getByRole('list', { name: 'Transaction progress' })
    expect(steps.textContent).toMatch(/Preparing.*Confirming.*Submitted.*Confirmed/)
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('Preparing')
    expect(wallet.sendCount()).toBe(0)
  }, TIMEOUT * 2)

  test('the prefilled link /send?to= fills only a valid recipient', async () => {
    await open(sendLink(FRIEND, '1.5'))
    mount()
    await waitFor(() => expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe(getAddress(FRIEND)), { timeout: TIMEOUT })
    expect((screen.getByLabelText('Amount in USDC') as HTMLInputElement).value).toBe('1.5')
    cleanup()
    window.history.pushState({}, '', `/send?to=${USDC.address}`)
    mount()
    await screen.findByLabelText('Recipient address', {}, { timeout: TIMEOUT })
    expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe('')
  }, TIMEOUT * 2)
})

describe('transaction status tracker', () => {
  test('maps the real flow phases to Preparing, Confirming, Submitted, Confirmed', () => {
    expect(stepFor('review', false)).toMatchObject({ active: 0, failed: false, done: false })
    expect(stepFor('signing', false)).toMatchObject({ active: 1, done: false })
    expect(stepFor('confirming', true)).toMatchObject({ active: 2, done: false })
    expect(stepFor('stalled', true)).toMatchObject({ active: 2, done: false })
    expect(stepFor('success', true)).toMatchObject({ done: true })
    expect(stepFor('failed', true)).toMatchObject({ active: 2, failed: true })
    expect(stepFor('failed', false)).toMatchObject({ active: 1, failed: true })
  })

  test('only the last step is complete once confirmed; a submitted transaction is never shown as confirmed', () => {
    const submitted = render(<Stepper active={2} />)
    const items = submitted.container.querySelectorAll('li')
    expect(items[2].getAttribute('aria-current')).toBe('step')
    expect(items[3].getAttribute('aria-current')).toBeNull()
    expect(items[3].querySelector('svg')).toBeNull() // no check mark on Confirmed yet
    cleanup()
    const done = render(<Stepper active={3} done />)
    expect(done.container.querySelectorAll('li svg')).toHaveLength(4)
  })
})

const item = (over: Partial<ActivityItem> & Pick<ActivityItem, 'kind' | 'amount'>): ActivityItem => ({
  id: Math.random().toString(),
  hash: HASH,
  token: 'USDC',
  status: 'confirmed',
  ...over,
})

describe('payment insights', () => {
  test('totals count only confirmed sends and receives; vault moves, pending and failed are excluded', () => {
    const now = 100_000
    const result = computeInsights(
      [
        item({ kind: 'send', amount: 2_000_000n, timestamp: now - 3000 }),
        item({ kind: 'send', amount: 500_000n, timestamp: now - 1000 }),
        item({ kind: 'receive', amount: 7_000_000n, timestamp: now - 2000 }),
        item({ kind: 'deposit', amount: 9_000_000n, timestamp: now - 500 }),
        item({ kind: 'send', amount: 4_000_000n, status: 'pending', timestamp: now - 10 }),
        item({ kind: 'send', amount: 5_000_000n, status: 'failed', timestamp: now - 20 }),
      ],
      now,
    )
    expect(result.sent).toBe(2_500_000n)
    expect(result.received).toBe(7_000_000n)
    expect(result.sentCount).toBe(2)
    expect(result.receivedCount).toBe(1)
    expect(result.count).toBe(4)
    expect(result.lastTimestamp).toBe(now - 500)
    expect(result.trend).toHaveLength(7)
    expect(result.trend.reduce((total, bucket) => total + bucket.sent, 0n)).toBe(2_500_000n)
    expect(result.trend.reduce((total, bucket) => total + bucket.received, 0n)).toBe(7_000_000n)
  })

  test('with nothing real it returns zeros and no trend, never sample numbers', () => {
    const empty = computeInsights([], 1000)
    expect(empty).toMatchObject({ sent: 0n, received: 0n, count: 0, trend: [] })
    expect(computeInsights([item({ kind: 'send', amount: 1n, timestamp: 5 })], 1000).trend).toEqual([])
  })

  test('the dashboard shows real insights or an honest empty state, after quick actions, overview and recent activity', async () => {
    await open('/')
    mount()
    const hero = await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    const actions = screen.getByRole('region', { name: 'Quick actions' })
    expect([...actions.querySelectorAll('nav:first-of-type a')].map((link) => link.textContent)).toEqual(['Send', 'Receive', 'ScanFlow', 'Split', 'Pay Link', 'Invoice', 'Request', 'PayHub'])
    const insights = await screen.findByText('Payment insights')
    const recent = screen.getByText('Recent transactions')
    const after = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(after(hero, actions) && after(actions, recent) && after(recent, insights)).toBe(true)
    expect(screen.queryByText('Saved addresses')).toBeNull()
    await waitFor(() => expect(screen.queryByText(/Sent$/) !== null || screen.queryByText(/No confirmed transactions were found|Could not load insights/) !== null).toBe(true), { timeout: TIMEOUT })
    expect(document.body.textContent).not.toMatch(/Coming soon/i)
  }, TIMEOUT * 2)
})

describe('scan and payment links', () => {
  test('reads plain addresses, EIP-681 USDC requests and app links; rejects everything else', () => {
    expect(parsePaymentQr(FRIEND)).toMatchObject({ ok: true, address: getAddress(FRIEND) })
    expect(parsePaymentQr(`ethereum:${FRIEND}@${ARC_CHAIN_ID}`)).toMatchObject({ ok: true, address: getAddress(FRIEND) })
    expect(parsePaymentQr(`ethereum:${USDC.address}@${ARC_CHAIN_ID}/transfer?address=${FRIEND}&uint256=2500000`)).toMatchObject({ ok: true, address: getAddress(FRIEND), amount: '2.5' })
    expect(parsePaymentQr(`https://example.app/send?to=${FRIEND}&amount=3`)).toMatchObject({ ok: true, amount: '3' })
    expect(parsePaymentQr(`ethereum:${FRIEND}@1`).ok).toBe(false)
    expect(parsePaymentQr(`ethereum:${OTHER}@${ARC_CHAIN_ID}/transfer?address=${FRIEND}&uint256=1`).ok).toBe(false)
    expect(parsePaymentQr(USDC.address).ok).toBe(false)
    expect(parsePaymentQr('hello world').ok).toBe(false)
    expect(parsePaymentQr('').ok).toBe(false)
  })

  test('the scan page opens with a camera start button and an image fallback, and starts nothing by itself', async () => {
    await open('/scan')
    mount()
    expect(await screen.findByRole('button', { name: /Start camera/ }, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('Choose a photo')).toBeTruthy()
    expect(screen.getByText(/Nothing is paid until you review and confirm/)).toBeTruthy()
  }, TIMEOUT)
})

describe('receive profile', () => {
  test('shows the address, QR, USDC on Arc indicator, copy and a share action that works without native share', async () => {
    await open('/receive')
    mount()
    expect(await screen.findByText('Your payment profile', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('USDC on Arc')).toBeTruthy()
    expect(screen.getAllByText(OWNER, { exact: false }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Copy address/ })).toBeTruthy()
    expect(document.querySelector('svg title')?.textContent).toContain(OWNER)
    expect(screen.getByRole('button', { name: /Share payment details/ })).toBeTruthy()
  }, TIMEOUT)
})
