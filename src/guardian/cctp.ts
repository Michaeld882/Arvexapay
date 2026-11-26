import { createPublicClient, erc20Abi, fallback, http, isAddress, isAddressEqual, parseUnits, zeroAddress, type Address } from 'viem'
import { ARC_CHAIN_ID } from '@/chain'
import { CIRCLE_CONFIG, type TransferSpeed } from '@/circle/config'
import { quoteTransfer, type TransferEstimate, type TransferRecord } from '@/circle/cctp'
import { checkBurnFee } from '@/circle/cctpFee'
import type { EvmChain, WalletAdapter } from '@/circle/sdk'
import { chainKey } from '@/circle/sdk'
import { classifyError, isTransientError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { checkAmount } from '@/lib/validate'
import { Amount, gasTokenDecimalsFor, gasTokenToUsdc, formatUsdc } from '@/onchain-money'
import { USDC_DECIMALS } from '@/onchain-facts'
import { skipped } from '@/guardian/checks'
import { dedupedRead, retryRead } from '@/guardian/retry'
import { finish } from '@/guardian/preflight'
import { dropSubmission, readSubmissions, updateSubmission } from '@/guardian/lock'
import type { CheckResult, GuardianPhase, GuardianReport } from '@/guardian/types'

/**
 * Guardian for the CCTP route (approve, burn, attestation, mint, verification). The Circle kit keeps doing the work
 * and the wallet keeps signing; this only decides, from read-only checks, whether the wallet prompt may open.
 *
 * Limitation: the burn is simulated by the kit's own gas estimate, which runs the burn call. Before the approval is
 * mined the burn cannot succeed (no allowance yet), so in that case the burn is not simulated here. The fee rule that
 * the contract enforces (maxFee must be below the amount) does not depend on the allowance and is always checked.
 */

export interface CctpReads {
  tokenDecimals(chain: EvmChain): Promise<number>
  tokenBalance(chain: EvmChain, owner: Address): Promise<bigint>
  nativeBalance(chain: EvmChain, owner: Address): Promise<bigint>
  allowance(chain: EvmChain, owner: Address, spender: Address): Promise<bigint>
  txCounts(chain: EvmChain, owner: Address): Promise<{ latest: number; pending: number }>
  /** Arc USDC balance of the owner (the same pool that pays Arc gas). Only needed when the mint is not forwarded. */
  arcBalance(owner: Address): Promise<bigint>
  quote(): Promise<TransferEstimate>
}

export interface CctpPreflightInput {
  owner: Address | undefined
  source: EvmChain
  destination: EvmChain
  /** The amount exactly as the user typed it, in USDC. Never changed. */
  amount: string
  recipient: Address
  speed: TransferSpeed
  useForwarder: boolean
}

const clients = new Map<string, ReturnType<typeof createPublicClient>>()
function clientFor(chain: EvmChain) {
  const key = chainKey(chain)
  let client = clients.get(key)
  if (!client) {
    client = createPublicClient({ transport: fallback(chain.rpcEndpoints.map((url) => http(url, { timeout: 10_000 }))) })
    clients.set(key, client)
  }
  return client
}

/** The kit's TokenMessenger for this source chain, read from Circle's own chain registry. */
export function tokenMessengerOf(chain: EvmChain): Address | undefined {
  const v2 = chain.cctp?.contracts?.v2 as { tokenMessenger?: string } | undefined
  return v2?.tokenMessenger && isAddress(v2.tokenMessenger) ? v2.tokenMessenger : undefined
}

export type SourceReads = Pick<CctpReads, 'tokenDecimals' | 'tokenBalance' | 'nativeBalance' | 'allowance' | 'txCounts'>

/** Read-only reads on a source chain's public RPC: deduplicated, cached briefly, retried only when transient. Shared by every cross-chain flow. */
export function sourceChainReads(fresh?: boolean): SourceReads {
  const read = <T>(key: string, ttl: number, fn: () => Promise<T>, force = fresh) => dedupedRead(key, ttl, () => retryRead(fn), { fresh: force })
  const k = (chain: EvmChain) => chainKey(chain)
  return {
    tokenDecimals: (chain) => read(`src:dec:${k(chain)}`, 10 * 60_000, () => clientFor(chain).readContract({ address: chain.usdcAddress as Address, abi: erc20Abi, functionName: 'decimals' }), false),
    tokenBalance: (chain, owner) => read(`src:bal:${k(chain)}:${owner}`, 8_000, () => clientFor(chain).readContract({ address: chain.usdcAddress as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })),
    nativeBalance: (chain, owner) => read(`src:native:${k(chain)}:${owner}`, 8_000, () => clientFor(chain).getBalance({ address: owner })),
    allowance: (chain, owner, spender) => read(`src:allow:${k(chain)}:${owner}:${spender}`, 8_000, () => clientFor(chain).readContract({ address: chain.usdcAddress as Address, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })),
    txCounts: (chain, owner) =>
      read(`src:nonce:${k(chain)}:${owner}`, 5_000, async () => {
        const [latest, pending] = await Promise.all([clientFor(chain).getTransactionCount({ address: owner, blockTag: 'latest' }), clientFor(chain).getTransactionCount({ address: owner, blockTag: 'pending' })])
        return { latest, pending }
      }),
  }
}

/** Default CCTP reads: the shared source-chain reads plus Circle's quote. */
export function cctpChainReads(input: { adapter: WalletAdapter; source: EvmChain; amount: string; recipient: Address; speed: TransferSpeed; useForwarder: boolean; fresh?: boolean; arcBalance: (owner: Address) => Promise<bigint> }): CctpReads {
  const fresh = input.fresh
  return {
    ...sourceChainReads(fresh),
    arcBalance: input.arcBalance,
    // The final check asks for a fresh quote: the fee and gas it returns decide whether the burn is valid right now.
    quote: () => retryRead(() => quoteTransfer({ adapter: input.adapter, source: input.source, amount: input.amount, recipient: input.recipient, speed: input.speed, useForwarder: input.useForwarder }, { fresh })),
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }
async function settle<T>(read: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read }
  } catch (error) {
    return { ok: false, error }
  }
}

const pass = (id: string, label: string, message?: string): CheckResult => ({ id, label, status: 'pass', message })
const warn = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'warn', message, detail })
const fail = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'fail', message, detail })

/** Route, domains, token, recipient, amount: everything that can be judged without reading the chain. */
export function checkCctpRoute(input: CctpPreflightInput): CheckResult[] {
  const { source, destination } = input
  const checks: CheckResult[] = []
  checks.push(input.owner ? pass('wallet', 'Wallet connected') : fail('wallet', 'Wallet connected', 'Connect your wallet to continue.'))

  const sourceDomain = source.cctp?.domain
  const destinationDomain = destination.cctp?.domain
  if (destination.chainId !== ARC_CHAIN_ID || chainKey(destination) !== CIRCLE_CONFIG.arcIdentifier) {
    checks.push(fail('route', 'Route', 'The destination is not Arc Mainnet, so this transfer was blocked.', `destination chain ${destination.chainId}`))
  } else if (source.chainId === destination.chainId) {
    checks.push(fail('route', 'Route', 'The source and destination are the same network.'))
  } else if (typeof sourceDomain !== 'number' || typeof destinationDomain !== 'number') {
    checks.push(fail('route', 'Route', 'Circle does not list a CCTP route for this source chain right now.', `domains ${String(sourceDomain)} -> ${String(destinationDomain)}`))
  } else if (sourceDomain === destinationDomain) {
    checks.push(fail('route', 'Route', 'The source and destination use the same CCTP domain.'))
  } else if (!tokenMessengerOf(source)) {
    checks.push(fail('route', 'Route', 'Circle does not list a CCTP v2 contract for this source chain.'))
  } else if (input.useForwarder && !destination.cctp?.forwarderSupported.destination) {
    checks.push(fail('route', 'Route', 'Circle forwarding is not available for Arc right now. Turn it off to mint with your own wallet.'))
  } else {
    checks.push(pass('route', 'Route', `${source.name} (domain ${sourceDomain}) to Arc (domain ${destinationDomain})`))
  }

  if (!source.usdcAddress || !isAddress(source.usdcAddress)) checks.push(fail('token', 'Token', 'Circle lists no USDC address for this source chain.'))
  else checks.push(pass('token', 'Token', `USDC on ${source.name}`))

  if (!isAddress(input.recipient) || isAddressEqual(input.recipient, zeroAddress)) {
    checks.push(fail('recipient', 'Recipient', 'The recipient on Arc is not a valid address.'))
  } else if (source.usdcAddress && isAddressEqual(input.recipient, source.usdcAddress as Address)) {
    checks.push(fail('recipient', 'Recipient', 'The recipient is a USDC token contract, not a wallet.'))
  } else if (input.owner && !isAddressEqual(input.recipient, input.owner)) {
    checks.push(warn('recipient', 'Recipient', 'The USDC will be minted to a different address than your connected wallet.'))
  } else {
    checks.push(pass('recipient', 'Recipient', 'Your wallet on Arc'))
  }

  const amount = checkAmount(input.amount)
  checks.push(amount.ok ? pass('amount', 'Amount', `${input.amount} USDC`) : fail('amount', 'Amount', amount.message))
  return checks
}

/** Reads the source chain and Circle's quote, then decides. Reads only: nothing is signed or sent. */
export async function runCctpPreflight(input: CctpPreflightInput, reads: CctpReads): Promise<{ report: GuardianReport; estimate?: TransferEstimate }> {
  const checks = checkCctpRoute(input)
  const failures: Array<{ what: string; error: unknown }> = []
  const amount = checkAmount(input.amount)
  if (checks.some((check) => check.status === 'fail') || !amount.ok || !input.owner) return { report: finish(checks, false, failures, undefined, Date.now()) }
  const { owner, source } = input
  const messenger = tokenMessengerOf(source) as Address

  const [decimals, balance, native, allowance, counts, quote] = await Promise.all([
    settle(reads.tokenDecimals(source)),
    settle(reads.tokenBalance(source, owner)),
    settle(reads.nativeBalance(source, owner)),
    settle(reads.allowance(source, owner, messenger)),
    settle(reads.txCounts(source, owner)),
    settle(reads.quote()),
  ])

  // Token decimals: the kit and the app both assume 6. Anything else would make every amount wrong.
  if (decimals.ok) checks.push(decimals.value === USDC_DECIMALS ? pass('decimals', 'Token decimals', `USDC, ${decimals.value} decimals`) : fail('decimals', 'Token decimals', `USDC on ${source.name} reports ${decimals.value} decimals but 6 are expected. The amount would be wrong, so it was blocked.`))
  else checks.push(warn('decimals', 'Token decimals', 'The token decimals could not be read from the chain. The standard 6 is used.'))

  // Balance on the source chain.
  if (balance.ok) {
    checks.push(balance.value >= amount.raw ? pass('balance', 'Balance', `${formatUsdcDisplay(balance.value)} USDC on ${source.name}`) : fail('balance', 'Balance', `Your USDC balance on ${source.name} (${formatUsdcDisplay(balance.value)} USDC) is lower than this amount.`))
  } else {
    failures.push({ what: 'source balance', error: balance.error })
    checks.push(skipped('balance', 'Balance', 'Could not be read.'))
  }

  // Approval already in place on the source chain.
  const approved = allowance.ok ? allowance.value : undefined
  if (approved === undefined) checks.push(skipped('allowance', 'Approval', 'The current approval could not be read.'))
  else checks.push(pass('allowance', 'Approval', approved >= amount.raw ? 'Enough USDC is already approved for Circle. The approve step adds only this transfer\'s amount.' : 'USDC will be approved for Circle in the first step. Nothing moves until you sign.'))

  // The quote: fee against amount, gas on the source chain, and the burn simulation.
  let estimate: TransferEstimate | undefined
  if (!quote.ok) {
    failures.push({ what: 'fee quote', error: quote.error })
    checks.push(skipped('fee', 'Protocol fee', 'Circle could not quote the fee.'))
    if (!isTransientError(quote.error)) checks.push(fail('quote', 'Fee quote', classifyError(quote.error).message, classifyError(quote.error).detail))
  } else {
    estimate = quote.value
    if (estimate.amount !== input.amount) checks.push(fail('fee', 'Protocol fee', 'The fee quote was made for a different amount, so it was not used. Try again.'))
    else if (estimate.maxFee === undefined) {
      failures.push({ what: 'fee quote', error: new Error('Circle returned no fee for this route') })
      checks.push(skipped('fee', 'Protocol fee', 'Circle returned no fee for this route.'))
    } else {
      const fee = checkBurnFee(amount.raw, estimate.maxFee)
      checks.push(fee.ok ? pass('fee', 'Protocol fee', `Fee ${formatUsdc(fee.maxFee)} USDC is below the amount`) : fail('fee', 'Protocol fee', fee.message, `maxFee ${fee.maxFee} >= amount ${amount.raw} (6-decimal base units)`))
    }
    checks.push(gasOnSource(source, native, estimate, failures))
    if (!input.useForwarder) checks.push(await mintGas(owner, estimate, reads))
    checks.push(burnSimulation(estimate, approved, amount.raw))
  }

  if (counts.ok) {
    const waiting = counts.value.pending - counts.value.latest
    checks.push(waiting > 0 ? warn('nonce', 'Pending transactions', `${waiting} earlier transaction${waiting === 1 ? '' : 's'} from this wallet on ${source.name} ${waiting === 1 ? 'is' : 'are'} still pending.`) : pass('nonce', 'Pending transactions', 'None'))
  } else checks.push(skipped('nonce', 'Pending transactions'))

  const simulated = checks.some((check) => check.id === 'simulation' && check.status === 'pass')
  const failedSim = checks.find((check) => check.id === 'simulation' && check.status === 'fail')
  return { report: finish(checks, simulated, failures, undefined, Date.now(), failedSim?.detail), estimate }
}

/** Gas for the source-chain steps (approve, burn) against the wallet's native balance on that chain. */
function gasOnSource(source: EvmChain, native: Settled<bigint>, estimate: TransferEstimate, failures: Array<{ what: string; error: unknown }>): CheckResult {
  const label = `Gas on ${source.name}`
  if (!native.ok) {
    failures.push({ what: 'source gas balance', error: native.error })
    return skipped('gas', label, 'The wallet balance could not be read.')
  }
  const decimals = source.nativeCurrency.decimals
  const needed = estimate.gas.filter((line) => !/\(mint\)/.test(line.label)).reduce((sum, line) => sum + parseUnits(line.amount, decimals), 0n)
  if (needed === 0n) return skipped('gas', label, 'The network fee could not be estimated.')
  return native.value >= needed
    ? pass('gas', label, `About ${trim(needed, decimals)} ${source.nativeCurrency.symbol} needed`)
    : fail('gas', label, `Not enough ${source.nativeCurrency.symbol} on ${source.name} to pay the network fee. You need about ${trim(needed, decimals)} ${source.nativeCurrency.symbol}.`, `have ${native.value} need ${needed} (${decimals} decimals)`)
}

const trim = (value: bigint, decimals: number): string => (Number(value) / 10 ** decimals).toPrecision(3)

/** Without forwarding, the mint is a transaction on Arc that the same wallet pays for with Arc USDC. */
async function mintGas(owner: Address, estimate: TransferEstimate, reads: CctpReads): Promise<CheckResult> {
  const line = estimate.gas.find((item) => /\(mint\)/.test(item.label))
  if (!line) return skipped('mint-gas', 'Gas on Arc', 'The mint fee could not be estimated.')
  const balance = await settle(reads.arcBalance(owner))
  if (!balance.ok) return skipped('mint-gas', 'Gas on Arc', 'Your Arc balance could not be read.')
  const native = Amount.fromRaw(parseUnits(line.amount, gasTokenDecimalsFor(ARC_CHAIN_ID)), gasTokenDecimalsFor(ARC_CHAIN_ID))
  const needed = gasTokenToUsdc(ARC_CHAIN_ID, native, 'trunc').raw + 1n
  return balance.value >= needed
    ? pass('mint-gas', 'Gas on Arc', 'Enough USDC on Arc for the mint')
    : warn('mint-gas', 'Gas on Arc', `You need about ${formatUsdc(needed)} USDC on Arc to pay gas for the mint. Without it the mint cannot be sent from your wallet. Turn on Circle forwarding to avoid this.`)
}

/**
 * The kit prices the burn by running it. If that run fails while the approval already covers the amount, the burn
 * would fail for real: block it. If the approval is missing, a failure is expected and is not a verdict.
 */
function burnSimulation(estimate: TransferEstimate, approved: bigint | undefined, amount: bigint): CheckResult {
  const burn = estimate.gasErrors.find((item) => item.name === 'Burn')
  if (!burn) {
    // A pass needs the kit's own burn estimate to exist. No estimate means the burn was not run, so nothing is claimed.
    if (!estimate.gas.some((line) => line.label.includes('(burn)'))) return skipped('simulation', 'Burn simulation', 'The kit returned no burn estimate, so the burn was not simulated.')
    return { id: 'simulation', label: 'Burn simulation', status: 'pass', message: 'The burn ran without reverting against the current chain state. This is not a guarantee it will succeed.' }
  }
  if (approved !== undefined && approved >= amount) {
    const app = classifyError(burn.error)
    const message = app.kind === 'unknown' ? 'The burn was rejected when it was simulated, so nothing was sent.' : app.message
    return fail('simulation', 'Burn simulation', message, app.detail)
  }
  return skipped('simulation', 'Burn simulation', 'The burn can only be simulated after the approval is confirmed. The fee rule was checked above.')
}

/**
 * The Guardian state of a CCTP transfer record, from real facts only: which step is running, whether it has a
 * transaction hash, and whether Arc has shown the mint.
 */
export function cctpGuardianPhase(record: TransferRecord): GuardianPhase {
  // Success is only ever set after Arc showed the mint, but VERIFIED also requires the mint hash that proves it.
  if (record.state === 'success') return record.mintHash ? 'VERIFIED' : 'CONFIRMED'
  if (record.state === 'confirming' || record.state === 'unconfirmed') return 'PENDING'
  const failed = record.steps.find((step) => step.state === 'error')
  if (record.state === 'error') {
    const text = `${record.error ?? ''} ${failed?.message ?? ''}`
    if (/rejected the request/i.test(text)) return 'USER_REJECTED'
    if (/too small for the current CCTP fee/i.test(text)) return 'SIMULATION_FAILED'
    if (failed?.name === 'mint' || failed?.name === 'fetchAttestation') return 'TIMEOUT'
    return failed?.txHash ? 'REVERTED' : 'SIMULATION_FAILED'
  }
  const active = record.steps.find((step) => step.state === 'active')
  if (!active) return 'VALIDATING'
  if ((active.name === 'approve' || active.name === 'burn') && !active.txHash) return 'SIGNING'
  return active.name === 'approve' || active.name === 'burn' ? 'SUBMITTED' : 'PENDING'
}

/** The identity of "this exact transfer", for duplicate protection across reloads. */
export const cctpFingerprint = (record: Pick<TransferRecord, 'owner' | 'sourceChain' | 'amount' | 'recipient' | 'speed' | 'useForwarder'>): string =>
  `cctp:${record.owner.toLowerCase()}:${record.sourceChain}:${record.amount}:${record.recipient.toLowerCase()}:${record.speed}:${record.useForwarder}`

/**
 * What the submission registry should hold for a transfer record. 'DROP' means nothing was burned and nothing is in
 * flight (at most an approval, which moves no funds), so a new transfer may start.
 */
export function cctpSubmissionState(record: TransferRecord): 'SIGNING' | 'SUBMITTED' | 'PENDING' | 'CONFIRMED' | 'VERIFIED' | 'DROP' {
  const burn = record.steps.find((step) => step.name === 'burn')
  if (record.state === 'success') return record.mintHash ? 'VERIFIED' : 'CONFIRMED'
  if (record.state === 'confirming' || record.state === 'unconfirmed') return 'PENDING'
  if (burn?.state === 'success') return 'PENDING'
  if (record.state === 'error') return burn?.txHash ? 'PENDING' : 'DROP'
  return burn?.txHash ? 'SUBMITTED' : 'SIGNING'
}

/**
 * Keeps the registry in step with a transfer record when the submission id is not at hand (after a reload). The
 * newest registry entry with this transfer's fingerprint is the one that follows it.
 */
export function syncCctpSubmission(owner: string, record: TransferRecord): void {
  const match = readSubmissions(owner).find((item) => item.kind === 'cctp' && item.fingerprint === cctpFingerprint(record))
  if (!match) return
  const state = cctpSubmissionState(record)
  if (state === 'DROP') return dropSubmission(owner, match.id)
  const hash = record.steps.find((step) => step.name === 'burn')?.txHash as `0x${string}` | undefined
  updateSubmission(owner, match.id, { state, ...(hash ? { hash } : {}) })
}
