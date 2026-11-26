import type { Hex } from 'viem'

/**
 * Transaction Guardian: a safety layer around every transaction the app asks a wallet to sign.
 * It only READS the chain and decides whether to let the wallet prompt open. It never signs, never holds a key,
 * never changes the amount or recipient, and never sends anything itself.
 */

/** Where a guarded transaction is. Failure states are terminal until the user starts something new. */
export type GuardianPhase =
  | 'VALIDATING'
  | 'SIMULATING'
  | 'READY'
  | 'SIGNING'
  | 'SUBMITTED'
  | 'PENDING'
  | 'CONFIRMED'
  | 'VERIFIED'
  | 'USER_REJECTED'
  | 'VALIDATION_FAILED'
  | 'SIMULATION_FAILED'
  | 'RPC_ERROR'
  | 'REVERTED'
  | 'TIMEOUT'
  | 'VERIFICATION_FAILED'

export const FAILURE_PHASES: ReadonlySet<GuardianPhase> = new Set<GuardianPhase>([
  'USER_REJECTED',
  'VALIDATION_FAILED',
  'SIMULATION_FAILED',
  'RPC_ERROR',
  'REVERTED',
  'TIMEOUT',
  'VERIFICATION_FAILED',
])

/** pass: fine. warn: the user should look before signing. fail: blocks signing. skipped: not applicable or not reachable. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped'

export interface CheckResult {
  id: string
  label: string
  status: CheckStatus
  /** Plain words for the user. */
  message?: string
  /** Raw detail for the expandable technical section. */
  detail?: string
}

/** ready: nothing found. review: warnings the user should read. blocked: the wallet prompt must not open. */
export type Verdict = 'ready' | 'review' | 'blocked'

export interface GuardianReport {
  verdict: Verdict
  checks: CheckResult[]
  /** True only when the exact transaction was simulated against current chain state and did not revert. */
  simulated: boolean
  /** Short plain reason when blocked, for example "Amount is too small for the current protocol fee." */
  reason?: string
  /** Technical detail for the expandable section (decoded revert, RPC error text). */
  technical?: string
  /** The blocking reason is a read failure (RPC), not a problem with the transaction. A retry may clear it. */
  rpcFailure: boolean
  /** The blocking reason is a matching transaction already in flight. */
  duplicateOf?: Hex
  checkedAt: number
}

export type GuardianView = { status: 'idle' } | { status: 'checking' } | { status: 'done'; report: GuardianReport }
