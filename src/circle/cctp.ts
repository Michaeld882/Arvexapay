import type { Address } from 'viem'
import type { BridgeResult } from '@circle-fin/app-kit'
import { CIRCLE_CONFIG, type TransferSpeed } from '@/circle/config'
import { describeCircleError } from '@/circle/errors'
import { createRecordStore } from '@/circle/store'
import { chainKey, explorerTxUrl, feeLabel, getAppKit, type EvmChain, type WalletAdapter } from '@/circle/sdk'
import { explorerTxUrl as arcTxUrl } from '@/chain'
import { findArcMintSince, verifyArcMintByHash, waitForArcArrival, type ArrivalResult } from '@/circle/arrival'
import { formatUsdc, parseUsdc } from '@/onchain-money'

/**
 * Circle CCTP (native burn-and-mint) transfers of USDC from another chain into Arc.
 * Steps: approve (allowance), burn (source chain), attestation (Circle signs the burn), mint (Arc).
 * No liquidity pool is involved: USDC is burned on the source chain and minted natively on Arc.
 */

export const STEP_NAMES = ['approve', 'burn', 'fetchAttestation', 'mint'] as const
export type StepName = (typeof STEP_NAMES)[number]
export type StepState = 'idle' | 'active' | 'success' | 'error' | 'skipped'

export interface StepView {
  name: StepName
  state: StepState
  txHash?: string
  explorerUrl?: string
  message?: string
}

export const STEP_LABELS: Record<StepName, string> = {
  approve: 'Approve USDC',
  burn: 'Burn on source chain',
  fetchAttestation: 'Circle attestation',
  mint: 'Mint on Arc',
}

export interface TransferRecord {
  id: string
  createdAt: number
  owner: Address
  sourceChain: string
  sourceName: string
  sourceChainId: number
  sourceExplorer: string
  amount: string
  recipient: Address
  speed: TransferSpeed
  useForwarder: boolean
  /**
   * pending: running. confirming: Circle says done, reading Arc for proof. unconfirmed: Circle says done but Arc
   * does not show the mint yet. success: the mint was found on Arc. error: stopped.
   */
  state: 'pending' | 'confirming' | 'unconfirmed' | 'success' | 'error'
  steps: StepView[]
  error?: string
  /** The SDK result, kept so an interrupted transfer can be resumed without burning twice. */
  result?: BridgeResult<string>
  /** The Arc transaction that minted the USDC, read back from Arc. Only set once verified. */
  mintHash?: string
  /** USDC credited on Arc (6-decimal text), read from the Arc receipt or Transfer log. */
  received?: string
}

export const transferStore = createRecordStore<TransferRecord>('cctp')

export function newTransferRecord(input: {
  owner: Address
  source: EvmChain
  amount: string
  recipient: Address
  speed: TransferSpeed
  useForwarder: boolean
}): TransferRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    owner: input.owner,
    sourceChain: chainKey(input.source),
    sourceName: input.source.name,
    sourceChainId: input.source.chainId,
    sourceExplorer: input.source.explorerUrl,
    amount: input.amount,
    recipient: input.recipient,
    speed: input.speed,
    useForwarder: input.useForwarder,
    state: 'pending',
    steps: STEP_NAMES.map((name, index) => ({ name, state: index === 0 ? 'active' : 'idle' })),
  }
}

export interface FeeLine {
  label: string
  token: string
  amount: string
}

export interface TransferEstimate {
  gas: FeeLine[]
  fees: FeeLine[]
}

function destination(input: { recipient: Address; useForwarder: boolean; adapter: WalletAdapter }) {
  return input.useForwarder
    ? { recipientAddress: input.recipient, chain: CIRCLE_CONFIG.arcIdentifier, useForwarder: true as const }
    : { adapter: input.adapter, chain: CIRCLE_CONFIG.arcIdentifier }
}

/** Asks Circle for the real fee quote for this route. Nothing is signed or sent. */
export async function estimateTransfer(input: {
  adapter: WalletAdapter
  source: EvmChain
  amount: string
  recipient: Address
  speed: TransferSpeed
  useForwarder: boolean
}): Promise<TransferEstimate> {
  const kit = await getAppKit()
  const estimate = await kit.estimateBridge({
    from: { adapter: input.adapter, chain: input.source },
    to: destination(input),
    amount: input.amount,
    config: { transferSpeed: input.speed },
  })
  return {
    gas: estimate.gasFees.flatMap((item) => (item.fees ? [{ label: `Network fee (${item.name.toLowerCase()})`, token: item.token, amount: String(item.fees.fee) }] : [])),
    fees: estimate.fees.flatMap((item) => (item.amount === null ? [] : [{ label: feeLabel(item.type), token: item.token, amount: item.amount }])),
  }
}

type Update = (record: TransferRecord) => void

/** SDK step errors are raw strings; show the same plain wording the rest of the app uses. */
const friendly = (message: string | undefined): string | undefined => (message ? describeCircleError(new Error(message)) : undefined)

function applyEvent(record: TransferRecord, payload: unknown): TransferRecord | undefined {
  const event = payload as { method?: string; values?: { state?: string; txHash?: string; transactionHash?: string; errorMessage?: string } }
  const name = event.method as StepName | undefined
  if (!name || !STEP_NAMES.includes(name) || !event.values) return undefined
  const hash = event.values.txHash ?? event.values.transactionHash
  const failed = event.values.state === 'error'
  const done = event.values.state === 'success'
  const steps = record.steps.map((step, index): StepView => {
    if (step.name === name) {
      return {
        ...step,
        state: failed ? 'error' : done ? 'success' : 'active',
        txHash: hash ?? step.txHash,
        explorerUrl: hash ? (name === 'mint' ? arcTxUrl(hash) : explorerTxUrl({ explorerUrl: record.sourceExplorer }, hash)) : step.explorerUrl,
        message: failed ? friendly(event.values?.errorMessage) : step.message,
      }
    }
    // the step after a finished one is now the active one
    const previous = record.steps[index - 1]
    if (done && previous?.name === name && step.state === 'idle') return { ...step, state: 'active' }
    return step
  })
  return { ...record, steps }
}

function fromResult(record: TransferRecord, result: BridgeResult<string>): TransferRecord {
  const steps = STEP_NAMES.map((name, index): StepView => {
    const found = result.steps.find((step) => step.name === name)
    const previous = record.steps[index]
    if (!found) return previous
    const state: StepState = found.state === 'success' ? 'success' : found.state === 'error' ? 'error' : found.state === 'noop' ? 'skipped' : 'active'
    return {
      name,
      state,
      txHash: found.txHash ?? previous.txHash,
      explorerUrl: found.explorerUrl ?? previous.explorerUrl,
      message: friendly(found.errorMessage),
    }
  })
  const failedStep = result.steps.find((step) => step.state === 'error')
  return {
    ...record,
    result,
    steps,
    // Circle reporting success is a claim. It becomes `success` only after Arc shows the mint.
    state: result.state === 'success' ? 'confirming' : result.state,
    error: result.state === 'error' ? friendly(failedStep?.errorMessage) ?? 'The transfer stopped before it finished.' : undefined,
  }
}

function checkFor(record: TransferRecord): () => Promise<ArrivalResult> {
  const maxAmount = parseUsdc(record.amount)
  const hash = record.steps.find((step) => step.name === 'mint')?.txHash
  return () =>
    hash
      ? verifyArcMintByHash({ hash: hash as `0x${string}`, recipient: record.recipient, maxAmount })
      : findArcMintSince({ recipient: record.recipient, maxAmount, sinceMs: record.createdAt })
}

/** Reads Arc for the mint. Only a verified mint makes the transfer `success`; anything else stays `unconfirmed`. */
async function confirmOnArc(record: TransferRecord, attempts?: number): Promise<TransferRecord> {
  const proof = await waitForArcArrival(checkFor(record), attempts)
  if (proof.state === 'verified') {
    const steps = record.steps.map((step): StepView =>
      step.name === 'mint' ? { ...step, state: 'success', txHash: proof.hash, explorerUrl: arcTxUrl(proof.hash) } : step.state === 'success' ? step : { ...step, state: 'success' },
    )
    return { ...record, steps, state: 'success', error: undefined, mintHash: proof.hash, received: formatUsdc(proof.received) }
  }
  const error =
    proof.state === 'unavailable'
      ? 'Arc Mainnet could not be read to confirm the mint. Your USDC is safe. Check again in a moment.'
      : `${proof.reason} Circle reported the transfer complete, so it may still be arriving. Check again in a moment.`
  return { ...record, state: 'unconfirmed', error }
}

/** Read-only: look for the mint on Arc again. Never sends a transaction. */
export async function recheckTransfer(input: { record: TransferRecord; onUpdate: Update }): Promise<TransferRecord> {
  input.onUpdate({ ...input.record, state: 'confirming', error: undefined })
  const next = await confirmOnArc(input.record, 2)
  input.onUpdate(next)
  return next
}

async function track(record: TransferRecord, onUpdate: Update, run: () => Promise<BridgeResult<string>>): Promise<TransferRecord> {
  const kit = await getAppKit()
  let current = record
  const emit = (next: TransferRecord) => {
    current = next
    onUpdate(next)
  }
  const handler = (payload: unknown) => {
    const next = applyEvent(current, payload)
    if (next) emit(next)
  }
  kit.on('*', handler)
  try {
    emit(fromResult(current, await run()))
  } catch (err) {
    // A hard error: nothing the SDK could resume. Keep every step that already finished.
    emit({ ...current, state: 'error', error: describeCircleError(err), steps: current.steps.map((step) => (step.state === 'active' ? { ...step, state: 'error' } : step)) })
  } finally {
    kit.off('*', handler)
  }
  if (current.state === 'confirming') emit(await confirmOnArc(current))
  return current
}

/** Runs the transfer. Call only from an explicit user action. */
export async function runTransfer(input: { record: TransferRecord; source: EvmChain; adapter: WalletAdapter; onUpdate: Update }): Promise<TransferRecord> {
  const { record, source, adapter, onUpdate } = input
  const kit = await getAppKit()
  return track(record, onUpdate, () =>
    kit.bridge({
      from: { adapter, chain: source },
      to: destination({ recipient: record.recipient, useForwarder: record.useForwarder, adapter }),
      amount: record.amount,
      config: { transferSpeed: record.speed },
    }),
  )
}

/** Resumes from the failed step. Completed steps (including the burn) are never repeated. */
export async function retryTransfer(input: { record: TransferRecord; adapter: WalletAdapter; onUpdate: Update }): Promise<TransferRecord> {
  const { record, adapter, onUpdate } = input
  if (!record.result) throw new Error('This transfer has nothing to resume.')
  const result = record.result
  const kit = await getAppKit()
  const restarted: TransferRecord = { ...record, state: 'pending', error: undefined, steps: record.steps.map((step) => (step.state === 'error' ? { ...step, state: 'active', message: undefined } : step)) }
  onUpdate(restarted)
  return track(restarted, onUpdate, () => kit.retryBridge(result, { from: adapter, to: adapter }))
}

const burned = (record: TransferRecord): boolean => record.steps.some((step) => step.name === 'burn' && step.state === 'success')

/** The burn is confirmed and the SDK still holds the state to finish: funds are in transit, not lost. */
export const isResumable = (record: TransferRecord): boolean => record.state === 'error' && Boolean(record.result) && burned(record)

/** A read-only look at Arc can settle this transfer: Circle said done, or the burn happened and the mint is forwarded. */
export const canCheckArrival = (record: TransferRecord): boolean =>
  record.state === 'unconfirmed' || ((record.state === 'error' || record.state === 'pending') && burned(record) && record.useForwarder)

export interface RecoveryAdvice {
  tone: 'info' | 'warn' | 'danger'
  title: string
  body: string
}

/**
 * Plain-language state and next step for a transfer that did not finish cleanly. `interrupted` means the record says
 * it was running but this page is not running it (the page was closed or reloaded).
 */
export function recoveryAdvice(record: TransferRecord, interrupted: boolean): RecoveryAdvice | undefined {
  if (record.state === 'success') return undefined
  // Running right now and driven by this page: nothing has gone wrong, so there is nothing to advise.
  if (record.state === 'pending' && !interrupted) return undefined
  if (record.state === 'confirming') return { tone: 'info', title: 'Confirming on Arc', body: 'Circle reports the transfer complete. Waiting to read the mint from Arc Mainnet before calling it done.' }
  if (record.state === 'unconfirmed') {
    return { tone: 'warn', title: 'Mint not confirmed on Arc yet', body: record.error ?? 'Check again in a moment. Your USDC was burned and is not lost.' }
  }
  const failed = record.steps.find((step) => step.state === 'error' || (interrupted && step.state === 'active'))
  if (burned(record)) {
    if (interrupted && !record.result && !record.useForwarder) {
      return {
        tone: 'danger',
        title: 'Interrupted after the burn',
        body: `This page was closed while the transfer ran. Your USDC was burned on ${record.sourceName}, so it is in transit, not lost. The mint was not set to be forwarded, so it must be finished with Circle's CCTP tools using the burn transaction hash shown above. Keep that hash.`,
      }
    }
    return {
      tone: 'warn',
      title: interrupted ? 'Interrupted after the burn' : 'Stopped after the burn',
      body: `${record.error ? `${record.error} ` : ''}Your USDC was burned on ${record.sourceName}, so it is in transit and not lost. ${
        isResumable(record)
          ? 'Resume finishes only the remaining steps. It never burns again.'
          : record.useForwarder
            ? "Circle's forwarding service completes the mint by itself. Use Check Arc to look for it."
            : 'Keep the burn transaction hash shown above.'
      }`,
    }
  }
  if (failed?.name === 'burn' && failed.txHash) {
    return { tone: 'warn', title: 'Burn not confirmed', body: `The burn transaction was submitted but not confirmed. Open it on the ${record.sourceName} explorer before starting again, so you do not burn twice.` }
  }
  return {
    tone: 'danger',
    title: interrupted ? 'Transfer interrupted before the burn' : 'Transfer stopped before the burn',
    body: `${record.error ? `${record.error} ` : ''}No USDC was burned. At most an approval was signed, which does not move funds. You can start a new transfer.`,
  }
}

/**
 * The same transfer must never burn twice. If an earlier transfer of this amount from this chain already burned and has
 * not finished, starting another one is blocked until the first is resumed, checked or settled.
 */
export function findUnsettledDuplicate(records: readonly TransferRecord[], input: { sourceChain: string; amount: string }): TransferRecord | undefined {
  const DAY = 24 * 60 * 60 * 1000
  return records.find(
    (record) => record.sourceChain === input.sourceChain && record.amount === input.amount && record.state !== 'success' && burned(record) && Date.now() - record.createdAt < DAY,
  )
}
