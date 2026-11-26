import { isAddress, isAddressEqual, parseUnits, zeroAddress, type Address } from 'viem'
import { ARC_CHAIN_ID } from '@/chain'
import { CIRCLE_CONFIG } from '@/circle/config'
import { estimateDeposit, estimateSpend, getGatewayBalance, type GatewayFee, type GatewayRecord } from '@/circle/gateway'
import { chainKey, type EvmChain } from '@/circle/sdk'
import { classifyError, isTransientError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { checkAmount } from '@/lib/validate'
import { parseUsdc } from '@/onchain-money'
import { USDC_DECIMALS } from '@/onchain-facts'
import { skipped } from '@/guardian/checks'
import { finish } from '@/guardian/preflight'
import { beginSubmission, dropSubmission, readSubmissions, updateSubmission } from '@/guardian/lock'
import { sourceChainReads, type SourceReads } from '@/guardian/cctp'
import { dedupedRead, retryRead } from '@/guardian/retry'
import type { WalletAdapter } from '@/circle/sdk'
import type { CheckResult, GuardianPhase, GuardianReport } from '@/guardian/types'

/**
 * Guardian for Circle Gateway: Top Up (a deposit from a source chain) and Spend to Arc (a burn intent that Circle
 * turns into a mint on Arc). The Circle kit keeps doing the work and the wallet keeps signing.
 *
 * Limitations, stated plainly:
 * - The kit exposes fee estimates but no simulate-only call. A top up is checked by its fee estimate (which the kit
 *   prices by running the transaction), the balance, the gas and the route. A spend is a signed message, not a
 *   transaction, so there is nothing to simulate; it is checked against the Gateway balance, the route and the fees.
 * - The kit does not publish minimum or maximum amounts. The only limit checked is the one that always applies:
 *   the fees charged in USDC must be lower than the amount.
 */

export interface GatewayReads extends Pick<SourceReads, 'tokenDecimals' | 'tokenBalance' | 'nativeBalance' | 'allowance'> {
  /** Confirmed Gateway balance, in 6-decimal base units. */
  gatewayBalance(owner: Address): Promise<bigint>
  quote(): Promise<GatewayFee[]>
}

export interface GatewayPreflightInput {
  kind: 'deposit' | 'spend'
  owner: Address | undefined
  /** The chain the top up comes from. Ignored for a spend. */
  chain: EvmChain | undefined
  /** Circle's Arc entry in the Gateway chain list. */
  arc: EvmChain
  /** The Gateway chains Circle currently lists. */
  chains: readonly EvmChain[]
  /** Exactly as the user typed it, in USDC. Never changed. */
  amount: string
  recipient: Address
}

const pass = (id: string, label: string, message?: string): CheckResult => ({ id, label, status: 'pass', message })
const warn = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'warn', message, detail })
const fail = (id: string, label: string, message: string, detail?: string): CheckResult => ({ id, label, status: 'fail', message, detail })

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }
async function settle<T>(read: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read }
  } catch (error) {
    return { ok: false, error }
  }
}

export const GATEWAY_FEE_MESSAGE = 'Amount is too small for the current Gateway fee. Please enter a larger amount.'

/** What can be judged without reading a chain: wallet, route, token, recipient and amount. */
export function checkGatewayRoute(input: GatewayPreflightInput): CheckResult[] {
  const checks: CheckResult[] = []
  checks.push(input.owner ? pass('wallet', 'Wallet connected') : fail('wallet', 'Wallet connected', 'Connect your wallet to continue.'))

  if (input.arc.chainId !== ARC_CHAIN_ID || chainKey(input.arc) !== CIRCLE_CONFIG.arcIdentifier) {
    checks.push(fail('route', 'Route', 'Circle does not list Arc Mainnet as a Gateway chain right now.', `arc entry ${input.arc.chainId}`))
  } else if (input.kind === 'deposit') {
    const listed = input.chain && input.chains.some((item) => chainKey(item) === chainKey(input.chain as EvmChain) && item.chainId === (input.chain as EvmChain).chainId)
    if (!input.chain || !listed) checks.push(fail('route', 'Route', 'This chain is not a Gateway chain right now.'))
    else if (!input.chain.gateway?.contracts?.v1?.wallet || !isAddress(input.chain.gateway.contracts.v1.wallet)) checks.push(fail('route', 'Route', `Circle lists no Gateway wallet contract on ${input.chain.name}.`))
    else if (input.chain.chainId === ARC_CHAIN_ID) checks.push(warn('route', 'Route', 'You are topping up from Arc itself.'))
    else checks.push(pass('route', 'Route', `${input.chain.name} to your Gateway balance`))
  } else if (!input.arc.gateway?.forwarderSupported?.destination) {
    checks.push(fail('route', 'Route', 'Circle forwarding is not available for Arc right now, so the spend cannot be completed.'))
  } else {
    checks.push(pass('route', 'Route', 'Gateway balance to Arc through Circle forwarding'))
  }

  if (input.kind === 'deposit') {
    if (!input.chain?.usdcAddress || !isAddress(input.chain.usdcAddress)) checks.push(fail('token', 'Token', 'Circle lists no USDC address for this chain.'))
    else checks.push(pass('token', 'Token', `USDC on ${input.chain.name}`))
  }

  if (!isAddress(input.recipient) || isAddressEqual(input.recipient, zeroAddress)) checks.push(fail('recipient', 'Recipient', 'The recipient is not a valid address.'))
  else if (input.owner && !isAddressEqual(input.recipient, input.owner)) checks.push(warn('recipient', 'Recipient', 'The USDC goes to a different address than your connected wallet.'))
  else checks.push(pass('recipient', 'Recipient', 'Your wallet'))

  const amount = checkAmount(input.amount)
  checks.push(amount.ok ? pass('amount', 'Amount', `${input.amount} USDC`) : fail('amount', 'Amount', amount.message))
  return checks
}

/** Reads the chain and Circle's quote, then decides. Reads only: nothing is signed or sent. */
export async function runGatewayPreflight(input: GatewayPreflightInput, reads: GatewayReads): Promise<GuardianReport> {
  const checks = checkGatewayRoute(input)
  const failures: Array<{ what: string; error: unknown }> = []
  const amount = checkAmount(input.amount)
  if (checks.some((check) => check.status === 'fail') || !amount.ok || !input.owner) return finish(checks, false, failures, undefined, Date.now())
  const { owner, chain } = input
  const deposit = input.kind === 'deposit' && chain

  const none = Promise.resolve<Settled<undefined>>({ ok: true, value: undefined })
  const [decimals, balance, native, allowance, gateway, quote] = await Promise.all([
    deposit ? settle(reads.tokenDecimals(chain)) : none,
    deposit ? settle(reads.tokenBalance(chain, owner)) : none,
    deposit ? settle(reads.nativeBalance(chain, owner)) : none,
    deposit ? settle(reads.allowance(chain, owner, chain.gateway?.contracts?.v1?.wallet as Address)) : none,
    input.kind === 'spend' ? settle(reads.gatewayBalance(owner)) : none,
    settle(reads.quote()),
  ])

  if (deposit) {
    if (decimals.ok && decimals.value !== undefined) checks.push(decimals.value === USDC_DECIMALS ? pass('decimals', 'Token decimals', `USDC, ${decimals.value} decimals`) : fail('decimals', 'Token decimals', `USDC on ${chain.name} reports ${decimals.value} decimals but 6 are expected. The amount would be wrong, so it was blocked.`))
    else checks.push(warn('decimals', 'Token decimals', 'The token decimals could not be read from the chain. The standard 6 is used.'))
    if (balance.ok && balance.value !== undefined) checks.push(balance.value >= amount.raw ? pass('balance', 'Balance', `${formatUsdcDisplay(balance.value)} USDC on ${chain.name}`) : fail('balance', 'Balance', `Your USDC balance on ${chain.name} (${formatUsdcDisplay(balance.value)} USDC) is lower than this amount.`))
    else {
      if (!balance.ok) failures.push({ what: 'source balance', error: balance.error })
      checks.push(skipped('balance', 'Balance', 'Could not be read.'))
    }
    const approved = allowance.ok ? allowance.value : undefined
    checks.push(approved === undefined ? skipped('allowance', 'Approval', 'The current approval could not be read.') : pass('allowance', 'Approval', approved >= amount.raw ? 'Enough USDC is already approved for Gateway.' : 'USDC is approved for Gateway as part of the top up. Nothing moves until you sign.'))
  } else if (gateway.ok && gateway.value !== undefined) {
    checks.push(gateway.value >= amount.raw ? pass('balance', 'Gateway balance', `${formatUsdcDisplay(gateway.value)} USDC`) : fail('balance', 'Gateway balance', `Your Gateway balance (${formatUsdcDisplay(gateway.value)} USDC) is lower than this amount.`))
  } else {
    if (!gateway.ok) failures.push({ what: 'source balance', error: gateway.error })
    checks.push(skipped('balance', 'Gateway balance', 'Could not be read.'))
  }

  if (!quote.ok) {
    failures.push({ what: 'fee quote', error: quote.error })
    checks.push(skipped('fee', 'Fees', 'Circle could not quote the fees.'))
    // A quote that Circle rejects (not a network problem) is the strongest signal the request would fail.
    if (!isTransientError(quote.error)) {
      const app = classifyError(quote.error)
      checks.push(fail('estimate', 'Fee estimate', app.kind === 'unknown' ? 'Circle rejected this request when it was estimated, so nothing was sent.' : app.message, app.detail))
    }
  } else {
    const usdcFees = quote.value.filter((fee) => fee.token === 'USDC').reduce((sum, fee) => sum + parseUsdc(fee.amount), 0n)
    checks.push(
      usdcFees < amount.raw
        ? pass('fee', 'Fees', usdcFees === 0n ? 'No fee is taken from the amount' : `Fees of ${formatUsdcDisplay(usdcFees)} USDC are below the amount`)
        : fail('fee', 'Fees', `${GATEWAY_FEE_MESSAGE} The fees are ${formatUsdcDisplay(usdcFees)} USDC, so the amount must be more than that.`, `fees ${usdcFees} >= amount ${amount.raw} (6-decimal base units)`),
    )
    if (deposit) checks.push(gasCheck(chain, native, quote.value, failures))
    // The kit offers an estimate, not a simulate-only call, so this is reported as an estimate and never as a simulation.
    checks.push({ id: 'estimate', label: 'Fee estimate', status: 'pass', message: 'Circle priced this request against the current chain state. The kit has no simulate-only call, so the request was not simulated, and an estimate is not a guarantee it will succeed.' })
  }

  const failedEstimate = checks.find((check) => check.id === 'estimate' && check.status === 'fail')
  return finish(checks, false, failures, undefined, Date.now(), failedEstimate?.detail)
}

function gasCheck(chain: EvmChain, native: Settled<bigint | undefined>, fees: GatewayFee[], failures: Array<{ what: string; error: unknown }>): CheckResult {
  const label = `Gas on ${chain.name}`
  if (!native.ok) {
    failures.push({ what: 'source gas balance', error: native.error })
    return skipped('gas', label, 'The wallet balance could not be read.')
  }
  if (native.value === undefined) return skipped('gas', label)
  const symbol = chain.nativeCurrency.symbol
  const decimals = chain.nativeCurrency.decimals
  const nativeFees = fees.filter((fee) => fee.token === symbol && fee.token !== 'USDC')
  const needed = nativeFees.reduce((sum, fee) => sum + parseUnits(fee.amount, decimals), 0n)
  if (needed === 0n) return skipped('gas', label, 'The network fee could not be estimated.')
  return native.value >= needed
    ? pass('gas', label, `About ${(Number(needed) / 10 ** decimals).toPrecision(3)} ${symbol} needed`)
    : fail('gas', label, `Not enough ${symbol} on ${chain.name} to pay the network fee. You need about ${(Number(needed) / 10 ** decimals).toPrecision(3)} ${symbol}.`, `have ${native.value} need ${needed} (${decimals} decimals)`)
}

/** The identity of "this exact Gateway request", for duplicate protection across reloads. */
export const gatewayFingerprint = (input: { owner: string; kind: 'deposit' | 'spend'; chainKey?: string; amount: string }): string =>
  `gateway:${input.owner.toLowerCase()}:${input.kind}:${input.chainKey ?? 'arc'}:${input.amount}`

/** What the submission registry should hold for a Gateway record. 'DROP' means nothing was submitted. */
export function gatewaySubmissionState(record: GatewayRecord): 'SIGNING' | 'SUBMITTED' | 'PENDING' | 'CONFIRMED' | 'VERIFIED' | 'DROP' {
  // Success means the chain confirmed it. It is VERIFIED only when the expected result was read back too.
  if (record.state === 'success') return record.verified ? 'VERIFIED' : 'CONFIRMED'
  if (record.state === 'unconfirmed') return 'PENDING'
  if (record.state === 'error') return record.txHash ? 'PENDING' : 'DROP'
  return record.txHash ? 'SUBMITTED' : 'SIGNING'
}

/** The Guardian state of a Gateway record, from real facts: the hash, the chain read-back, and the error text. */
export function gatewayGuardianPhase(record: GatewayRecord): GuardianPhase {
  if (record.state === 'success') return record.verified ? 'VERIFIED' : 'CONFIRMED'
  if (record.state === 'unconfirmed') return 'PENDING'
  if (record.state === 'error') {
    const text = record.error ?? ''
    if (/rejected the request/i.test(text)) return 'USER_REJECTED'
    if (/reverted/i.test(text) && record.txHash) return 'REVERTED'
    if (/could not be read|timed out|rate limit/i.test(text)) return record.txHash ? 'TIMEOUT' : 'RPC_ERROR'
    return record.txHash ? 'VERIFICATION_FAILED' : 'VALIDATION_FAILED'
  }
  return record.txHash ? 'PENDING' : 'SIGNING'
}

const toBase = (value: string): bigint => {
  // The kit reports the balance as decimal text. Anything beyond 6 decimals is cut, never rounded up.
  const [whole, fraction = ''] = value.split('.')
  return parseUsdc(`${whole || '0'}.${fraction.slice(0, 6) || '0'}`)
}

/** Default reads: the shared source-chain reads, the Gateway balance, and Circle's fee estimate for this request. */
export function gatewayChainReads(input: { kind: 'deposit' | 'spend'; adapter: WalletAdapter; chain?: EvmChain; amount: string; recipient: Address; owner: Address; fresh?: boolean }): GatewayReads {
  const fresh = input.fresh
  return {
    ...sourceChainReads(fresh),
    gatewayBalance: (owner) => dedupedRead(`gateway:balance:${owner}`, 8_000, () => retryRead(async () => toBase((await getGatewayBalance(owner)).total)), { fresh }),
    quote: () =>
      dedupedRead(
        `gateway:quote:${input.kind}:${input.chain ? chainKey(input.chain) : 'arc'}:${input.owner}:${input.amount}`,
        20_000,
        () => retryRead(() => (input.kind === 'deposit' ? estimateDeposit(input.adapter, input.chain as EvmChain, input.amount) : estimateSpend(input.adapter, input.recipient, input.amount))),
        { fresh },
      ),
  }
}

/** Keeps the Guardian registry in step with a Gateway record: real hash only, and a request that never submitted is forgotten. */
export function syncGatewaySubmission(owner: string, record: GatewayRecord): void {
  const state = gatewaySubmissionState(record)
  const known = readSubmissions(owner).some((item) => item.id === record.id)
  if (state === 'DROP') {
    if (known) dropSubmission(owner, record.id)
    return
  }
  const patch = { state, ...(record.txHash ? { hash: record.txHash as `0x${string}` } : {}) }
  if (known) updateSubmission(owner, record.id, patch)
  else beginSubmission(owner, { id: record.id, fingerprint: gatewayFingerprint({ owner, kind: record.kind, chainKey: record.chainKey, amount: record.amount }), kind: `gateway-${record.kind}`, title: `${record.kind === 'deposit' ? 'Top up Gateway' : 'Spend to Arc'} ${record.amount} USDC` })
}
