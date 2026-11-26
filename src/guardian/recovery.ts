import type { Hex, TransactionReceipt } from 'viem'
import { canCheckArrival, type TransferRecord } from '@/circle/cctp'
import type { GatewayRecord } from '@/circle/gateway'
import { verifyExpectations } from '@/guardian/expect'
import { inFlight, readSubmissions, updateSubmission, type Submission } from '@/guardian/lock'

/**
 * Reload-safe recovery. After a reload the app does not know what the old screen was doing, but it kept real
 * records: the submission registry, the CCTP transfers and the Gateway operations. This module restores their state
 * from the chain with READ-ONLY calls. It never signs, never submits and never resends anything, so recovering can
 * never create a second transaction.
 */

export type ReceiptStatus = 'success' | 'reverted' | 'pending'

/** The kinds the registry holds for flows that have their own records and their own recovery. */
const OWN_RECOVERY = (kind: string) => kind === 'cctp' || kind.startsWith('gateway-')

export interface RecoveryDeps {
  /** Reads one receipt. Resolves undefined while the transaction is not mined. Read-only. */
  readReceipt(hash: Hex): Promise<TransactionReceipt | undefined>
  now?: () => number
}

/**
 * verified    the receipt succeeded AND holds the expected result (amount, recipient, events)
 * confirmed   the receipt succeeded, but there was nothing recorded to check it against
 * unverified  the receipt succeeded, but the expected result is not in it
 * failed      the transaction reverted
 */
export type RecoveryOutcome = 'verified' | 'confirmed' | 'unverified' | 'failed' | 'pending' | 'unknown'

export interface RecoveredSubmission {
  submission: Submission
  /** What the chain showed, or 'unknown' when the read failed (the record is left as it was). */
  status: ReceiptStatus | 'unknown'
  outcome: RecoveryOutcome
  /** What was missing, when the outcome is unverified. */
  missing?: string[]
}

/**
 * Settles direct wallet transactions (Send, Cash Out, Top Up, approvals, swaps) that were submitted before the
 * reload. The receipt is read from the chain and compared with what the submission was expected to produce, which
 * was stored when it was handed to the wallet. A successful receipt is CONFIRMED; it becomes VERIFIED only when the
 * expected result is in it. A transaction that has no stored expectation stays CONFIRMED, never VERIFIED.
 */
export async function recoverSubmissions(owner: string, deps: RecoveryDeps): Promise<RecoveredSubmission[]> {
  const now = deps.now?.() ?? Date.now()
  const results: RecoveredSubmission[] = []
  for (const submission of inFlight(owner, now)) {
    if (OWN_RECOVERY(submission.kind) || !submission.hash) continue
    let receipt: TransactionReceipt | undefined
    try {
      receipt = await deps.readReceipt(submission.hash)
    } catch {
      results.push({ submission, status: 'unknown', outcome: 'unknown' })
      continue
    }
    if (!receipt) {
      results.push({ submission, status: 'pending', outcome: 'pending' })
    } else if (receipt.status !== 'success') {
      updateSubmission(owner, submission.id, { state: 'FAILED' }, now)
      results.push({ submission, status: 'reverted', outcome: 'failed' })
    } else if (!submission.expect || submission.expect.length === 0) {
      updateSubmission(owner, submission.id, { state: 'CONFIRMED' }, now)
      results.push({ submission, status: 'success', outcome: 'confirmed' })
    } else {
      const check = verifyExpectations(submission.expect, receipt)
      updateSubmission(owner, submission.id, { state: check.ok ? 'VERIFIED' : 'UNVERIFIED' }, now)
      results.push({ submission, status: 'success', outcome: check.ok ? 'verified' : 'unverified', missing: check.ok ? undefined : check.missing })
    }
  }
  return results
}

export interface GatewayRecoveryDeps {
  recheck(record: GatewayRecord): Promise<GatewayRecord>
  /** Persist a record that changed without a chain read (an interrupted request with no hash). */
  update(record: GatewayRecord): void
}

export const INTERRUPTED_BEFORE_HASH =
  'This page was closed before the wallet returned a transaction hash. Nothing was assumed. Check your wallet and the explorer before trying again, so you do not send it twice.'

/**
 * Gateway operations that were running when the page closed. One with a hash is read back from its chain. One with
 * no hash is closed honestly: it is not retried and it is not called a success.
 */
export async function recoverGateway(records: readonly GatewayRecord[], deps: GatewayRecoveryDeps): Promise<GatewayRecord[]> {
  const out: GatewayRecord[] = []
  for (const record of records) {
    if (record.state === 'pending' && !record.txHash) {
      const closed: GatewayRecord = { ...record, state: 'error', error: INTERRUPTED_BEFORE_HASH }
      deps.update(closed)
      out.push(closed)
    } else if ((record.state === 'pending' || record.state === 'unconfirmed') && record.txHash) {
      out.push(await deps.recheck(record))
    }
  }
  return out
}

export interface CctpRecoveryDeps {
  recheck(record: TransferRecord): Promise<TransferRecord>
}

/**
 * CCTP transfers that stopped at the Arc mint: reads Arc for the mint again. Resuming a transfer that needs the
 * wallet is never automatic; that stays a button the user presses.
 */
export async function recoverCctp(records: readonly TransferRecord[], deps: CctpRecoveryDeps): Promise<TransferRecord[]> {
  const out: TransferRecord[] = []
  for (const record of records) {
    if (!canCheckArrival(record)) continue
    out.push(await deps.recheck(record))
  }
  return out
}

/** Registry items that still count as in flight, for the notice. */
export const pendingSubmissions = (owner: string, now = Date.now()): Submission[] => inFlight(owner, now)

/** Delay before the next recovery poll: starts at 15s, grows by half each time, never above 2 minutes. */
export const recoveryDelay = (attempt: number): number => Math.min(120_000, Math.round(15_000 * 1.5 ** Math.max(0, attempt)))

export const hasAnyRecord = (owner: string): boolean => readSubmissions(owner).length > 0
