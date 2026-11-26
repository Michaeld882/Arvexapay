import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { connect, disconnect } from 'wagmi/actions'
import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem, type Address } from 'viem'
import App from '../src/App'
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC } from '../src/chain'
import { config } from '../src/config'
import { localDate, readReminders } from '../src/lib/payments/reminders'
import { readRequests } from '../src/lib/payments/requests'
import { Providers } from '../src/providers'
import { installMockWallet, type MockWallet } from './mockWallet'

const TIMEOUT = 30_000
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const FRIEND = '0x3333333333333333333333333333333333333333' as Address

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
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  delete (window as unknown as { ethereum?: unknown }).ethereum
})

async function open(path: string, account: Address | null = OWNER): Promise<MockWallet | undefined> {
  window.history.pushState({}, '', path)
  if (account === null) return undefined
  const wallet = installMockWallet(account, ARC_CHAIN_ID)
  await connect(config, { connector: config.connectors[0] })
  return wallet
}
const mount = () =>
  render(
    <Providers>
      <App />
    </Providers>,
  )
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('payments hub and dashboard', () => {
  test('the hub opens every payment tool and shows real totals or honest zeros, never sample data', async () => {
    await open('/payments')
    mount()
    expect(await screen.findByText('Payment overview', {}, { timeout: TIMEOUT })).toBeTruthy()
    const hrefs = ['/payments/split', '/payments/links', '/payments/invoices', '/payments/requests', '/payments/merchant', '/payments/receipts', '/payments/customers', '/payments/reminders', '/payments/contacts']
    for (const href of hrefs) expect(document.querySelector(`a[href="${href}"]`) !== null, href).toBe(true)
    await screen.findByText('Total received', {}, { timeout: TIMEOUT })
    expect(screen.getByText('Total sent')).toBeTruthy()
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0)
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sample|demo|fake/i)
  }, TIMEOUT * 2)

  test('the dashboard is ordered balance, quick actions, overview, pending, recent activity, insights, and every action opens a real page', async () => {
    await open('/')
    mount()
    await screen.findByTestId('hero-balance', {}, { timeout: TIMEOUT })
    const actions: Array<[string, string]> = [['Send', '/send'], ['Receive', '/receive'], ['Scan and pay', '/scan'], ['Split payment', '/payments/split'], ['Payment link', '/payments/links'], ['Invoice', '/payments/invoices'], ['Request payment', '/payments/requests'], ['Merchant mode', '/payments/merchant']]
    const quick = within(document.querySelector('section[aria-label="Quick actions"]') as HTMLElement)
    for (const [name, href] of actions) expect(quick.getByRole('link', { name }).getAttribute('href'), name).toBe(href)
    for (const href of ['/deposit', '/withdraw', '/swap', '/activity', '/payments']) expect(document.querySelector(`nav[aria-label="More"] a[href="${href}"]`) !== null, href).toBe(true)
    await screen.findByText('Payment insights', {}, { timeout: TIMEOUT })
    const text = document.body.textContent ?? ''
    const order = ['Wallet balance', 'Payment overview', 'Pending requests and invoices', 'Recent transactions', 'Payment insights'].map((heading) => text.indexOf(heading))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text.indexOf('Send')).toBeLessThan(text.indexOf('Payment overview'))
  }, TIMEOUT * 2)
})

describe('requests, links and invoices', () => {
  test('creating a request shows it Pending with a pay link, and cancelling it works', async () => {
    await open('/payments/requests')
    mount()
    await screen.findByText('No payment requests yet', {}, { timeout: TIMEOUT })
    type('Amount (USDC)', '2.5')
    type(/What is it for/, 'Lunch')
    fireEvent.click(screen.getByRole('button', { name: 'Create request' }))
    const row = await screen.findByRole('button', { name: /Lunch/ }, { timeout: TIMEOUT })
    expect(within(row).getByText('Pending')).toBeTruthy()
    expect(within(row).getByText(/2\.50 USDC/)).toBeTruthy()
    const saved = readRequests(OWNER)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ kind: 'request', amount: '2500000', description: 'Lunch' })
    expect(saved[0].createdBlock).toMatch(/^\d+$/)
    expect(saved[0].paid).toBeUndefined()
    await screen.findByText(new RegExp(`/pay\\?to=${OWNER}&amount=2.5`), {}, { timeout: TIMEOUT })
    expect(screen.getByText(/Watching for new payments|Checking Arc for payments/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
    await waitFor(() => expect(within(screen.getByRole('button', { name: /Lunch/ })).getByText('Cancelled')).toBeTruthy())
  }, TIMEOUT * 2)

  test('an invoice needs a description and a customer before it is created', async () => {
    await open('/payments/invoices')
    mount()
    await screen.findByText('No invoices yet', {}, { timeout: TIMEOUT })
    type('Amount (USDC)', '40')
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Describe what this invoice is for/)
    type('Description', 'Website work')
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Add the customer name/))
    type('Customer name', 'Acme Studio')
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }))
    const row = await screen.findByRole('button', { name: /INV-0001/ }, { timeout: TIMEOUT })
    expect(within(row).getByText('Pending')).toBeTruthy()
    expect(readRequests(OWNER)[0]).toMatchObject({ kind: 'invoice', customer: 'Acme Studio', invoiceNo: 'INV-0001', amount: '40000000' })
  }, TIMEOUT * 2)
})

describe('the public pay page', () => {
  test('opened with no wallet it shows the payment details and its own Connect button, not the intro or a second connect page', async () => {
    await open(`/pay?to=${FRIEND}&amount=3&desc=Logo%20design&name=Studio&ref=PO-7`, null)
    mount()
    expect(await screen.findByText('Studio', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByText('3.00')).toBeTruthy()
    expect(screen.getByText('Logo design')).toBeTruthy()
    expect(screen.getByText('PO-7')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Connect wallet to pay/ }, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByText('Connect your wallet')).toBeNull()
    expect(screen.queryByText(/Built on/)).toBeNull()
  }, TIMEOUT)

  test('broken and expired links say so and cannot be paid', async () => {
    await open('/pay?to=bad', null)
    mount()
    expect(await screen.findByText('This payment link cannot be used', {}, { timeout: TIMEOUT })).toBeTruthy()
    cleanup()
    await open(`/pay?to=${FRIEND}&amount=3&exp=1000`, null)
    mount()
    expect(await screen.findByText('This payment link has expired', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Connect wallet to pay/ })).toBeNull()
  }, TIMEOUT * 2)

  test('a connected payer reviews first: the four-step tracker starts at Preparing and nothing is sent without confirming', async () => {
    const wallet = (await open(`/pay?to=${FRIEND}&amount=0.01&desc=Coffee`, funded)) as MockWallet
    mount()
    const pay = await screen.findByRole('button', { name: /Review and pay 0\.01 USDC/ }, { timeout: TIMEOUT })
    await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(pay)
    expect(await screen.findByRole('button', { name: 'Confirm and send' }, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getByLabelText('Transaction progress').querySelector('[aria-current="step"]')?.textContent).toContain('Preparing')
    expect(screen.getByText('Coffee', { selector: 'span' })).toBeTruthy()
    expect(wallet.sendCount()).toBe(0)
  }, TIMEOUT * 3)

  test('you cannot pay your own link', async () => {
    await open(`/pay?to=${funded}&amount=1`, funded)
    mount()
    expect(await screen.findByText('This is your own payment link', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Review and pay/ })).toBeNull()
  }, TIMEOUT)
})

describe('split payment, merchant mode and reminders', () => {
  test('a bill is split equally into one Pending share per person and is not Completed', async () => {
    await open('/payments/split')
    mount()
    await screen.findByText('No bills yet', {}, { timeout: TIMEOUT })
    type('Bill name', 'Dinner')
    type('Total amount (USDC)', '30')
    type('Person 1 name', 'Ann')
    type('Person 2 name', 'Bo')
    fireEvent.click(screen.getByRole('button', { name: 'Split equally' }))
    expect((screen.getByLabelText('Person 1 amount') as HTMLInputElement).value).toBe('10')
    expect((screen.getByLabelText('My share (USDC)') as HTMLInputElement).value).toBe('10')
    expect(within(screen.getByLabelText('Bill summary')).getByText('Left to assign').nextElementSibling?.textContent).toBe('0.00')
    fireEvent.click(screen.getByRole('button', { name: /Create bill and requests/ }))
    expect(await screen.findByText('0 of 2 paid', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('Completed')).toBeNull()
    expect(screen.getByText(/Remaining 20\.00/)).toBeTruthy()
    const shares = readRequests(OWNER)
    expect(shares).toHaveLength(2)
    expect(shares.every((share) => share.kind === 'split' && share.amount === '10000000' && !share.paid)).toBe(true)
  }, TIMEOUT * 2)

  test('a bill whose shares do not add up is refused with the exact reason', async () => {
    await open('/payments/split')
    mount()
    await screen.findByText('No bills yet', {}, { timeout: TIMEOUT })
    type('Bill name', 'Trip')
    type('Total amount (USDC)', '30')
    fireEvent.click(screen.getByRole('checkbox'))
    type('Person 1 name', 'Ann')
    type('Person 1 amount', '10')
    type('Person 2 name', 'Bo')
    type('Person 2 amount', '10')
    fireEvent.click(screen.getByRole('button', { name: /Create bill and requests/ }))
    expect((await screen.findAllByText(/short of the total/))[0]).toBeTruthy()
    expect(readRequests(OWNER)).toHaveLength(0)
  }, TIMEOUT)

  test('Accept USDC opens the customer screen and waits for a real payment instead of claiming one', async () => {
    await open('/payments/merchant')
    mount()
    await screen.findByText('Accept USDC', { selector: 'h2' }, { timeout: TIMEOUT })
    await screen.findByTitle('Merchant payment QR code', {}, { timeout: TIMEOUT })
    type('Amount (USDC)', '4')
    const accept = screen.getByRole('button', { name: 'Accept USDC' })
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false), { timeout: TIMEOUT })
    fireEvent.click(accept)
    const display = await screen.findByRole('dialog', { name: 'Customer payment screen' }, { timeout: TIMEOUT })
    expect(within(display).getByText(/4\.00/)).toBeTruthy()
    expect(within(display).getByText('Waiting for the payment on Arc…')).toBeTruthy()
    expect(screen.queryByText('Payment received')).toBeNull()
    expect(readRequests(OWNER)[0]).toMatchObject({ amount: '4000000', kind: 'request' })
    expect(readRequests(OWNER)[0].paid).toBeUndefined()
  }, TIMEOUT * 2)

  test('a reminder due today shows on the dashboard, and Pay now only opens the Send review prefilled', async () => {
    const wallet = (await open('/payments/reminders')) as MockWallet
    mount()
    await screen.findByText('No reminders yet', {}, { timeout: TIMEOUT })
    type('Name', 'Rent')
    type(/Amount \(USDC\)/, '10')
    type(/Pay to/, FRIEND)
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder' }))
    expect(await screen.findByText('Due today', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(readReminders(OWNER)[0]).toMatchObject({ name: 'Rent', amount: '10000000', nextDue: localDate(), to: FRIEND })
    cleanup()
    window.history.pushState({}, '', '/')
    mount()
    expect(await screen.findByText('Upcoming payments', {}, { timeout: TIMEOUT })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }))
    await waitFor(() => expect(window.location.pathname).toBe('/send'))
    expect((await screen.findByLabelText('Recipient address', {}, { timeout: TIMEOUT })) as HTMLInputElement).toBeTruthy()
    await waitFor(() => expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe(FRIEND))
    expect((screen.getByLabelText('Amount in USDC') as HTMLInputElement).value).toBe('10')
    expect((screen.getByLabelText(/Note/) as HTMLInputElement).value).toBe('Rent')
    expect(wallet.sendCount()).toBe(0)
  }, TIMEOUT * 3)
})

describe('contacts, receipts and customers', () => {
  test('contacts keep an optional label, and receipts and customers show a loading, empty or real state without errors', async () => {
    await open('/payments/contacts')
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Add address/ }, { timeout: TIMEOUT }))
    type('Name', 'Maya')
    type('Wallet address', FRIEND)
    type(/Label/, 'Landlord')
    fireEvent.submit(screen.getByRole('button', { name: 'Save address' }).closest('form') as HTMLFormElement)
    expect(await screen.findByText('Landlord', {}, { timeout: TIMEOUT })).toBeTruthy()
    cleanup()
    window.history.pushState({}, '', '/payments/receipts')
    mount()
    expect(await screen.findByText('Your receipts', {}, { timeout: TIMEOUT })).toBeTruthy()
    expect(screen.queryByText('Could not load payments')).toBeNull()
    cleanup()
    window.history.pushState({}, '', '/payments/customers')
    mount()
    expect(await screen.findByText('Payers and payees', {}, { timeout: TIMEOUT })).toBeTruthy()
  }, TIMEOUT * 3)
})
