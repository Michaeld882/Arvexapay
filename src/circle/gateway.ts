import type { Address } from 'viem'
import { CIRCLE_CONFIG } from '@/circle/config'
import { describeCircleError } from '@/circle/errors'
import { createRecordStore } from '@/circle/store'
import { chainKey, explorerTxUrl, getAppKit, loadGatewayChains, type EvmChain, type WalletAdapter } from '@/circle/sdk'
import { findArcMintSince, verifyArcMintByHash, verifyGatewayDeposit, waitForArcArrival } from '@/circle/arrival'
import { explorerTxUrl as arcTxUrl } from '@/chain'
import { parseUsdc } from '@/onchain-money'
import { sleep, backoffDelay } from '@/lib/backoff'

/**
 * Circle Gateway unified USDC balance. This balance is held in Circle's Gateway contracts, NOT in the wallet and
 * NOT in the Arvexa vault. It is always shown and stored separately from the wallet USDC balance.
 */

export interface GatewayChainBalance {
  chain: string
  confirmed: string
  pending?: string
}

export interface GatewayBalance {
  total: string
  pending?: string
  chains: GatewayChainBalance[]
}

/** Read-only: needs only the address, no signature and no wallet connection. */
export async function getGatewayBalance(address: Address): Promise<GatewayBalance> {
  const kit = await getAppKit()
  const result = await kit.unifiedBalance.getBalances({ sources: { address }, networkType: CIRCLE_CONFIG.networkType })
  const chains = new Map<string, GatewayChainBalance>()
  for (const account of result.breakdown) {
    for (const entry of account.breakdown) {
      const existing = chains.get(entry.chain)
      const confirmed = Number(entry.confirmedBalance) + Number(existing?.confirmed ?? 0)
      const pendingValue = Number((entry as { pendingBalance?: string }).pendingBalance ?? 0) + Number(existing?.pending ?? 0)
      chains.set(entry.chain, { chain: entry.chain, confirmed: String(confirmed), pending: pendingValue > 0 ? String(pendingValue) : undefined })
    }
  }
  return {
    total: result.totalConfirmedBalance,
    pending: result.totalPendingBalance && Number(result.totalPendingBalance) > 0 ? result.totalPendingBalance : undefined,
    chains: [...chains.values()].filter((item) => Number(item.confirmed) > 0 || Number(item.pending ?? 0) > 0),
  }
}

export interface GatewayRecord {
  id: string
  createdAt: number
  owner: Address
  kind: 'deposit' | 'spend'
  /** Deposit: the chain deposited from. Spend: always Arc. */
  chainName: string
  amount: string
  /**
   * pending: waiting for the wallet and Circle. unconfirmed: submitted, but the chain does not show it yet.
   * success: the transaction was read back from its chain. error: stopped, nothing was assumed.
   */
  state: 'pending' | 'unconfirmed' | 'success' | 'error'
  /** Circle identifier of the source chain for a deposit (used to re-check it later). */
  chainKey?: string
  txHash?: string
  explorerUrl?: string
  error?: string
  /**
   * True only when the expected result was read back from the chain: a deposit's USDC transfer into the Gateway
   * contract for exactly this amount, or the Arc mint of a spend. A confirmed receipt alone leaves this unset, and
   * records saved before this field existed are treated the same way.
   */
  verified?: boolean
}

export const gatewayStore = createRecordStore<GatewayRecord>('gateway')

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export interface GatewayFee {
  type: string
  token: string
  amount: string
}

export async function estimateDeposit(adapter: WalletAdapter, chain: EvmChain, amount: string): Promise<GatewayFee[]> {
  const kit = await getAppKit()
  const estimate = await kit.unifiedBalance.estimateDeposit({ from: { adapter, chain }, amount })
  return estimate.fees.map((fee) => ({ type: String(fee.type), token: fee.token, amount: fee.amount }))
}

export async function estimateSpend(adapter: WalletAdapter, recipient: Address, amount: string): Promise<GatewayFee[]> {
  const kit = await getAppKit()
  const estimate = await kit.unifiedBalance.estimateSpend({
    from: { adapter },
    to: { chain: CIRCLE_CONFIG.arcIdentifier, recipientAddress: recipient, useForwarder: true },
    amount,
  })
  return estimate.fees.map((fee) => ({ type: String(fee.type), token: fee.token, amount: fee.amount }))
}

type Update = (record: GatewayRecord) => void

const STALE = 'The chain does not show this transaction yet. Your funds are safe. Check again in a moment.'

async function confirmDeposit(record: GatewayRecord, chain: EvmChain, attempts = 5): Promise<GatewayRecord> {
  if (!record.txHash) return { ...record, state: 'unconfirmed', error: STALE }
  const wallet = (chain as { gateway?: { contracts?: { v1?: { wallet?: string } } } }).gateway?.contracts?.v1?.wallet
  let outcome: Awaited<ReturnType<typeof verifyGatewayDeposit>> = { state: 'unavailable' }
  for (let attempt = 0; attempt < attempts; attempt++) {
    outcome = await verifyGatewayDeposit({ rpcEndpoints: chain.rpcEndpoints, hash: record.txHash as `0x${string}`, owner: record.owner, token: chain.usdcAddress as Address, wallet: wallet as Address | undefined, amount: parseUsdc(record.amount) })
    if (outcome.state !== 'unavailable') break
    await sleep(backoffDelay(attempt + 1))
  }
  // Confirmed by the chain. `verified` says whether the expected transfer into Gateway was also found in the receipt.
  if (outcome.state === 'success') return { ...record, state: 'success', error: undefined, verified: outcome.verified }
  if (outcome.state === 'reverted') return { ...record, state: 'error', error: `The deposit transaction reverted on ${chain.name}, so no USDC moved into Gateway.`, verified: false }
  return { ...record, state: 'unconfirmed', error: `${chain.name} could not be read to confirm the deposit. ${STALE}` }
}

async function confirmSpend(record: GatewayRecord): Promise<GatewayRecord> {
  const maxAmount = parseUsdc(record.amount)
  const hash = record.txHash as `0x${string}` | undefined
  // Prefer the transaction Circle reported. If that is not the Arc mint, look for the mint itself.
  const proof = await waitForArcArrival(async () => {
    if (hash) {
      const byHash = await verifyArcMintByHash({ hash, recipient: record.owner, maxAmount })
      if (byHash.state !== 'not_found') return byHash
    }
    return findArcMintSince({ recipient: record.owner, maxAmount, sinceMs: record.createdAt })
  }, 4)
  if (proof.state === 'verified') return { ...record, state: 'success', error: undefined, txHash: proof.hash, explorerUrl: arcTxUrl(proof.hash), verified: true }
  return { ...record, state: 'unconfirmed', error: proof.state === 'unavailable' ? `Arc Mainnet could not be read to confirm the mint. ${STALE}` : `${proof.reason} ${STALE}` }
}

/** Read-only: look at the chain again for an unconfirmed record. Never sends a transaction. */
export async function recheckGatewayRecord(record: GatewayRecord, onUpdate: Update): Promise<GatewayRecord> {
  onUpdate({ ...record, state: 'pending', error: undefined })
  let next: GatewayRecord
  if (record.kind === 'spend') next = await confirmSpend(record)
  else {
    const { chains } = await loadGatewayChains()
    const chain = chains.find((item) => chainKey(item) === record.chainKey)
    next = chain ? await confirmDeposit(record, chain, 2) : { ...record, state: 'unconfirmed', error: STALE }
  }
  onUpdate(next)
  return next
}

/** Deposits wallet USDC into the Gateway unified balance. Call only from an explicit user action. */
export async function runDeposit(input: { owner: Address; adapter: WalletAdapter; chain: EvmChain; amount: string; onUpdate: Update }): Promise<GatewayRecord> {
  const base: GatewayRecord = { id: newId(), createdAt: Date.now(), owner: input.owner, kind: 'deposit', chainName: input.chain.name, chainKey: chainKey(input.chain), amount: input.amount, state: 'pending' }
  input.onUpdate(base)
  try {
    const kit = await getAppKit()
    const result = await kit.unifiedBalance.deposit({ from: { adapter: input.adapter, chain: input.chain }, amount: input.amount })
    const submitted: GatewayRecord = { ...base, txHash: result.txHash, explorerUrl: result.explorerUrl ?? explorerTxUrl(input.chain, result.txHash) }
    input.onUpdate(submitted)
    const done = await confirmDeposit(submitted, input.chain)
    input.onUpdate(done)
    return done
  } catch (err) {
    const failed: GatewayRecord = { ...base, state: 'error', error: describeCircleError(err) }
    input.onUpdate(failed)
    return failed
  }
}

/** Spends from the unified balance and mints to the wallet on Arc through Circle's forwarding service. */
export async function runSpend(input: { owner: Address; adapter: WalletAdapter; recipient: Address; amount: string; onUpdate: Update }): Promise<GatewayRecord> {
  const base: GatewayRecord = { id: newId(), createdAt: Date.now(), owner: input.owner, kind: 'spend', chainName: 'Arc', amount: input.amount, state: 'pending' }
  input.onUpdate(base)
  try {
    const kit = await getAppKit()
    const result = await kit.unifiedBalance.spend({
      from: { adapter: input.adapter },
      to: { chain: CIRCLE_CONFIG.arcIdentifier, recipientAddress: input.recipient, useForwarder: true },
      amount: input.amount,
    })
    const submitted: GatewayRecord = { ...base, txHash: result.txHash, explorerUrl: result.explorerUrl ?? arcTxUrl(result.txHash) }
    input.onUpdate(submitted)
    const done = await confirmSpend(submitted)
    input.onUpdate(done)
    return done
  } catch (err) {
    const failed: GatewayRecord = { ...base, state: 'error', error: describeCircleError(err) }
    input.onUpdate(failed)
    return failed
  }
}
