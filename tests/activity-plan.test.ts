import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { USDC } from '../src/chain'
import { buildActivity, mergeLocalTxs, type TransferLogLike, type VaultLogLike } from '../src/lib/activity'
import { buildSendPlan } from '../src/lib/plan'
import type { LocalTx } from '../src/lib/txLog'
import { SWAP_CONFIGURED, SWAP_PROVIDERS } from '../src/swap-config'

const ME = '0x1111111111111111111111111111111111111111' as Address
const YOU = '0x2222222222222222222222222222222222222222' as Address
const VAULT = '0x3333333333333333333333333333333333333333' as Address
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

const transfer = (n: number, from: Address, to: Address, value: bigint, block = 100n): TransferLogLike => ({
  transactionHash: h(n),
  blockNumber: block,
  logIndex: 0,
  from,
  to,
  value,
})

describe('activity classification', () => {
  test('send and receive come from USDC transfers', () => {
    const items = buildActivity(ME, undefined, [transfer(1, ME, YOU, 5_000_000n, 101n), transfer(2, YOU, ME, 7_000_000n, 102n)], [])
    expect(items.map((i) => i.kind)).toEqual(['receive', 'send'])
    expect(items[0]).toMatchObject({ amount: 7_000_000n, counterparty: YOU, status: 'confirmed', token: 'USDC' })
  })

  test('a vault deposit is one Deposit item, not Deposit plus Send', () => {
    const deposit: VaultLogLike = { kind: 'deposit', transactionHash: h(3), blockNumber: 103n, logIndex: 1, account: ME, amount: 2_000_000n }
    const items = buildActivity(ME, VAULT, [{ ...transfer(3, ME, VAULT, 2_000_000n, 103n), logIndex: 0 }], [deposit])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'deposit', amount: 2_000_000n, counterparty: VAULT })
  })

  test('a vault withdrawal to self is one Withdraw item', () => {
    const withdraw: VaultLogLike = { kind: 'withdraw', transactionHash: h(4), blockNumber: 104n, logIndex: 1, account: ME, to: ME, amount: 1_000_000n }
    const items = buildActivity(ME, VAULT, [transfer(4, VAULT, ME, 1_000_000n, 104n)], [withdraw])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('withdraw')
  })

  test('newest block first', () => {
    const items = buildActivity(ME, undefined, [transfer(5, ME, YOU, 1n, 10n), transfer(6, ME, YOU, 1n, 20n)], [])
    expect(items[0].blockNumber).toBe(20n)
  })
})

describe('local transaction merge', () => {
  const base: LocalTx = { hash: h(9), kind: 'send', amount: '1000000', to: YOU, status: 'pending', createdAt: 1_700_000_000 }
  test('pending and failed transactions appear with real hashes and the right status', () => {
    const merged = mergeLocalTxs([], [base, { ...base, hash: h(10), status: 'failed' }])
    expect(merged.map((i) => i.status).sort()).toEqual(['failed', 'pending'])
    expect(merged.every((i) => i.hash.startsWith('0x'))).toBe(true)
  })
  test('an onchain item is not duplicated by its local record', () => {
    const onchain = buildActivity(ME, undefined, [transfer(9, ME, YOU, 1_000_000n)], [])
    expect(mergeLocalTxs(onchain, [{ ...base, status: 'success' }])).toHaveLength(1)
  })
})

function receiptWith(logs: Array<{ address: Address; topics: Hex[]; data: Hex }>): TransactionReceipt {
  return { status: 'success', logs: logs.map((log, logIndex) => ({ ...log, logIndex })) } as unknown as TransactionReceipt
}

function transferLog(from: Address, to: Address, value: bigint, token: Address = USDC.address) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  }
}

describe('send receipt verification', () => {
  const plan = buildSendPlan(ME, YOU, 5_000_000n)
  test('accepts a receipt with the exact USDC Transfer', () => {
    expect(() => plan.verify(receiptWith([transferLog(ME, YOU, 5_000_000n)]))).not.toThrow()
  })
  test('rejects wrong amount, wrong recipient, wrong token and empty logs', () => {
    expect(() => plan.verify(receiptWith([transferLog(ME, YOU, 4_000_000n)]))).toThrow()
    expect(() => plan.verify(receiptWith([transferLog(ME, VAULT, 5_000_000n)]))).toThrow()
    expect(() => plan.verify(receiptWith([transferLog(ME, YOU, 5_000_000n, VAULT)]))).toThrow()
    expect(() => plan.verify(receiptWith([]))).toThrow()
  })
})

describe('swap configuration', () => {
  test('exactly one real provider is registered, with USDC and EURC on the official Arc USDC address', () => {
    expect(SWAP_PROVIDERS).toHaveLength(1)
    expect(SWAP_CONFIGURED).toBe(true)
    const [provider] = SWAP_PROVIDERS
    expect(provider.tokens.map((token) => token.symbol)).toEqual(expect.arrayContaining(['USDC', 'EURC']))
    expect(provider.tokens.find((token) => token.symbol === 'USDC')?.address).toBe(USDC.address)
    expect(typeof provider.quote).toBe('function')
    expect(typeof provider.buildTransaction).toBe('function')
  })

  test('the provider contracts verify against live Arc Mainnet (read only)', async () => {
    await SWAP_PROVIDERS[0].verify()
  }, 30_000)
})
