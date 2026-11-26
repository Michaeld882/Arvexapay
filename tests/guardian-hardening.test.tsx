import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem'
import { gatewayDepositInReceipt, verifyArcMintByHash } from '../src/circle/arrival'
import { newTransferRecord, type TransferRecord } from '../src/circle/cctp'
import { chainKey, loadCctpChains } from '../src/circle/sdk'
import { cctpGuardianPhase, cctpSubmissionState, runCctpPreflight, type CctpReads } from '../src/guardian/cctp'
import { runGatewayPreflight, type GatewayReads } from '../src/guardian/gateway'
import { clearReadCache, retryRead } from '../src/guardian/retry'
import { guardianPhase } from '../src/guardian/state'
import { GuardianStatus } from '../src/components/GuardianStatus'
import { render, screen, cleanup } from '@testing-library/react'
import { loadGatewayChains } from '../src/circle/sdk'
import type { TransferEstimate } from '../src/circle/cctp'

const OWNER = '0x2222222222222222222222222222222222222222' as Address
const ONE = 1_000_000n
const MINT_HASH = '0x003573a264975f93cfa0c1fbde09b31683574498232941b0bbb16a5b6896e7e8' as Hex
const MINT_TO = '0x401dF9869C0132bE31912f5Db3D663E1197CEf08' as Address

beforeEach(() => clearReadCache())
afterEach(() => cleanup())

describe('recovered and finished work is VERIFIED only with proof of the result', () => {
  test('CCTP: a successful transfer without the Arc mint hash is only CONFIRMED', async () => {
    const { sources } = await loadCctpChains()
    const base = newTransferRecord({ owner: OWNER, source: sources.find((chain) => chainKey(chain) === 'Arbitrum') ?? sources[0], amount: '10', recipient: OWNER, speed: 'FAST', useForwarder: true })
    const finished: TransferRecord = { ...base, state: 'success', steps: base.steps.map((step) => ({ ...step, state: 'success' })) }
    expect(cctpGuardianPhase(finished)).toBe('CONFIRMED')
    expect(cctpSubmissionState(finished)).toBe('CONFIRMED')
    const proven = { ...finished, mintHash: MINT_HASH }
    expect(cctpGuardianPhase(proven)).toBe('VERIFIED')
    expect(cctpSubmissionState(proven)).toBe('VERIFIED')
  })

  test('CCTP: a mint smaller than this transfer can deliver after fees is not accepted as its arrival (real Arc data)', async () => {
    // The real mint credited exactly 1 USDC.
    const exact = await verifyArcMintByHash({ hash: MINT_HASH, recipient: MINT_TO, maxAmount: ONE, minAmount: ONE })
    expect(exact.state).toBe('verified')
    const tooSmall = await verifyArcMintByHash({ hash: MINT_HASH, recipient: MINT_TO, maxAmount: 5n * ONE, minAmount: 2n * ONE })
    expect(tooSmall.state).toBe('not_found')
  }, 40_000)

  test('Gateway: a deposit is VERIFIED only when the receipt holds the transfer into the Gateway contract for the exact amount', () => {
    const token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831' as Address
    const wallet = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE' as Address
    const log = (from: Address, to: Address, value: bigint) => ({
      address: token,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
      blockNumber: 1n,
      blockHash: `0x${'00'.repeat(32)}`,
      logIndex: 0,
      transactionHash: MINT_HASH,
      transactionIndex: 0,
      removed: false,
    })
    const input = { owner: OWNER, token, wallet, amount: 5n * ONE }
    expect(gatewayDepositInReceipt([log(OWNER, wallet, 5n * ONE)], input)).toBe(true)
    expect(gatewayDepositInReceipt([log(OWNER, wallet, 4n * ONE)], input)).toBe(false)
    expect(gatewayDepositInReceipt([log(OWNER, '0x1111111111111111111111111111111111111111', 5n * ONE)], input)).toBe(false)
    expect(gatewayDepositInReceipt([log('0x1111111111111111111111111111111111111111', wallet, 5n * ONE)], input)).toBe(false)
    expect(gatewayDepositInReceipt([], input)).toBe(false)
    // No known Gateway contract for the chain means nothing can be verified.
    expect(gatewayDepositInReceipt([log(OWNER, wallet, 5n * ONE)], { ...input, wallet: undefined })).toBe(false)
  })
})

describe('Gateway checks only what the kit really offers', () => {
  test('a Gateway request is never reported as simulated: it is an estimate, and the screen says so', async () => {
    const { arc, chains } = await loadGatewayChains()
    const ethereum = chains.find((chain) => chainKey(chain) === 'Ethereum')!
    const reads: GatewayReads = {
      tokenDecimals: async () => 6,
      tokenBalance: async () => 100n * ONE,
      nativeBalance: async () => 10n ** 18n,
      allowance: async () => 0n,
      txCounts: async () => ({ latest: 1, pending: 1 }),
      gatewayBalance: async () => 0n,
      quote: async () => [{ type: 'gasFee', token: 'ETH', amount: '0.0002' }],
    }
    const report = await runGatewayPreflight({ kind: 'deposit', owner: OWNER, chain: ethereum, arc, chains, amount: '10', recipient: OWNER }, reads)
    expect(report.verdict).toBe('ready')
    expect(report.simulated).toBe(false)
    expect(report.checks.some((check) => check.id === 'simulation')).toBe(false)
    expect(report.checks.find((check) => check.id === 'estimate')?.status).toBe('pass')
    render(<GuardianStatus view={{ status: 'done', report }} flowPhase="review" hasHash={false} />)
    expect(screen.getByText('Estimated, not simulated')).toBeTruthy()
    expect(screen.queryByText('Simulation passed')).toBeNull()
  })

  test('no limit is invented: a very large and a very small amount are judged only by balance and the quoted fees', async () => {
    const { arc, chains } = await loadGatewayChains()
    const ethereum = chains.find((chain) => chainKey(chain) === 'Ethereum')!
    const reads: GatewayReads = {
      tokenDecimals: async () => 6,
      tokenBalance: async () => 10n ** 15n,
      nativeBalance: async () => 10n ** 18n,
      allowance: async () => 0n,
      txCounts: async () => ({ latest: 1, pending: 1 }),
      gatewayBalance: async () => 0n,
      quote: async () => [{ type: 'gasFee', token: 'ETH', amount: '0.0002' }],
    }
    for (const amount of ['0.000001', '500000000']) {
      const report = await runGatewayPreflight({ kind: 'deposit', owner: OWNER, chain: ethereum, arc, chains, amount, recipient: OWNER }, reads)
      expect(report.verdict).toBe('ready')
      expect(report.checks.some((check) => /limit|minimum|maximum/i.test(check.label))).toBe(false)
    }
  })
})

describe('CCTP: the fee rule is checked before the wallet, and a burn is only called simulated when it really ran', () => {
  const estimate = (extra: Partial<TransferEstimate> = {}): TransferEstimate => ({
    amount: '0.000063',
    gas: [],
    fees: [{ label: 'Circle forwarding fee', token: 'USDC', amount: '0.017379', type: 'forwarder' }],
    maxFee: 17_379n,
    gasErrors: [],
    ...extra,
  })

  async function route() {
    const cctp = await loadCctpChains()
    return { source: cctp.sources.find((chain) => chainKey(chain) === 'Arbitrum')!, destination: cctp.destination }
  }
  const reads = (quote: TransferEstimate): CctpReads => ({
    tokenDecimals: async () => 6,
    tokenBalance: async () => 100n * ONE,
    nativeBalance: async () => 10n ** 18n,
    allowance: async () => 0n,
    txCounts: async () => ({ latest: 1, pending: 1 }),
    arcBalance: async () => ONE,
    quote: async () => quote,
  })

  test('0.000063 USDC with the forwarding fee is blocked from the fee quote alone: no chain switch, approval or burn is involved', async () => {
    const { source, destination } = await route()
    const report = await runCctpPreflight({ owner: OWNER, source, destination, amount: '0.000063', recipient: OWNER, speed: 'FAST', useForwarder: true }, reads(estimate()))
    expect(report.report.verdict).toBe('blocked')
    expect(report.report.reason).toContain('Amount is too small for the current CCTP fee. Please enter a larger amount.')
  })

  test('with no burn estimate from the kit the burn is NOT reported as simulated', async () => {
    const { source, destination } = await route()
    const quote = estimate({ amount: '10', maxFee: 17_400n, fees: [{ label: 'Circle forwarding fee', token: 'USDC', amount: '0.0174', type: 'forwarder' }], gas: [{ label: 'Network fee (approve)', token: 'ETH', amount: '0.00001' }] })
    const noBurn = await runCctpPreflight({ owner: OWNER, source, destination, amount: '10', recipient: OWNER, speed: 'FAST', useForwarder: true }, reads(quote))
    expect(noBurn.report.checks.find((check) => check.id === 'simulation')?.status).toBe('skipped')
    expect(noBurn.report.simulated).toBe(false)
    const withBurn = await runCctpPreflight({ owner: OWNER, source, destination, amount: '10', recipient: OWNER, speed: 'FAST', useForwarder: true }, { ...reads(quote), allowance: async () => 100n * ONE, quote: async () => ({ ...quote, gas: [...quote.gas, { label: 'Network fee (burn)', token: 'ETH', amount: '0.00004' }] }) })
    expect(withBurn.report.checks.find((check) => check.id === 'simulation')?.status).toBe('pass')
  })

  test('the amount is never changed: the report carries no replacement amount', async () => {
    const { source, destination } = await route()
    const result = await runCctpPreflight({ owner: OWNER, source, destination, amount: '0.000063', recipient: OWNER, speed: 'FAST', useForwarder: true }, reads(estimate()))
    expect(JSON.stringify(result.report)).not.toMatch(/suggested|adjusted|newAmount/i)
    expect(result.estimate?.amount).toBe('0.000063')
  })
})

describe('transaction safety', () => {
  test('retryRead retries a transient read, but never a wallet rejection or a revert', async () => {
    let transient = 0
    const value = await retryRead(async () => (++transient < 3 ? Promise.reject(new Error('The request timed out.')) : 'ok'), { attempts: 3, wait: async () => undefined })
    expect(value).toBe('ok')
    expect(transient).toBe(3)
    for (const message of ['User rejected the request.', 'execution reverted: ERC20: transfer amount exceeds balance']) {
      let calls = 0
      await retryRead(async () => (calls++, Promise.reject(new Error(message))), { attempts: 3, wait: async () => undefined }).catch(() => undefined)
      expect(calls).toBe(1)
    }
  })

  test('a wallet rejection is its own state everywhere, never a blockchain failure', () => {
    expect(guardianPhase({ flow: 'review', errorKind: 'user_rejected', hasHash: false, view: { status: 'idle' } })).toBe('USER_REJECTED')
    // A rejection after a hash cannot happen; a failure with a hash is REVERTED, which is a different state.
    expect(guardianPhase({ flow: 'failed', errorKind: 'reverted', hasHash: true, view: { status: 'idle' } })).toBe('REVERTED')
  })

  test('the source holds no hard-coded transaction hash, so none can be shown as a result', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name) && /0x[0-9a-fA-F]{64}\b/.test(readFileSync(path, 'utf8'))) offenders.push(path)
      }
    }
    walk(join(import.meta.dir, '..', 'src'))
    expect(offenders).toEqual([])
  })

  test('the retry helpers are never used around a call that signs or submits', () => {
    const dir = join(import.meta.dir, '..', 'src')
    // The text inside each retryRead(...) / dedupedRead(...) call, found by matching parentheses.
    const wrapped = (text: string): string[] => {
      const out: string[] = []
      for (const match of text.matchAll(/\b(retryRead|dedupedRead)\(/g)) {
        let depth = 1
        let index = (match.index ?? 0) + match[0].length
        const start = index
        while (index < text.length && depth > 0) {
          const char = text[index++]
          if (char === '(') depth += 1
          else if (char === ')') depth -= 1
        }
        out.push(text.slice(start, index))
      }
      return out
    }
    let wrappers = 0
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const full = join(path, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name) && !full.endsWith('guardian/retry.ts')) {
          for (const body of wrapped(readFileSync(full, 'utf8'))) {
            wrappers += 1
            // Reads only: nothing that signs or submits may sit inside a retry or cache wrapper.
            expect(/(writeContractAsync|sendTransactionAsync|\.bridge\(|\.retryBridge\(|unifiedBalance\.(deposit|spend)\(|runTransfer|runDeposit|runSpend|signTypedData)/.test(body)).toBe(false)
          }
        }
      }
    }
    walk(dir)
    expect(wrappers).toBeGreaterThan(10)
  })

  test('signing and submitting calls live in exactly the flows that own them', () => {
    const dir = join(import.meta.dir, '..', 'src')
    const owners = new Set<string>()
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const full = join(path, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name) && /(writeContractAsync\(|sendTransactionAsync\(|\.bridge\(\{|\.retryBridge\(|unifiedBalance\.(deposit|spend)\()/.test(readFileSync(full, 'utf8'))) owners.add(full.replace(`${dir}/`, ''))
      }
    }
    walk(dir)
    expect([...owners].sort()).toEqual(['circle/cctp.ts', 'circle/gateway.ts', 'hooks/useTxFlow.ts'])
  })
})
