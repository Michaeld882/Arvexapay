import type { ErrorKind } from '@/lib/errors'
import type { GuardianPhase, GuardianView } from '@/guardian/types'

/** The flow hook's own phases, restated here so this module has no dependency on React. */
export type FlowPhaseName = 'idle' | 'review' | 'signing' | 'confirming' | 'stalled' | 'success' | 'failed'

const RPC_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['rpc_unavailable', 'rpc_timeout', 'rpc_rate_limited'])

/**
 * The reliable Guardian state for what the flow is doing right now. It is derived only from real facts: the check
 * result, whether the wallet returned a hash, the receipt, and the verified logs. Nothing here is a guess.
 */
export function guardianPhase(input: { flow: FlowPhaseName; errorKind?: ErrorKind; hasHash: boolean; view: GuardianView }): GuardianPhase {
  const { flow, errorKind, hasHash, view } = input
  switch (flow) {
    case 'signing':
      return 'SIGNING'
    case 'confirming':
      return hasHash ? 'PENDING' : 'SUBMITTED'
    case 'stalled':
      return errorKind === 'rpc_timeout' ? 'TIMEOUT' : 'RPC_ERROR'
    case 'success':
      return 'VERIFIED'
    case 'failed':
      return errorKind === 'unverified' ? 'VERIFICATION_FAILED' : 'REVERTED'
    case 'idle':
    case 'review': {
      if (errorKind === 'user_rejected') return 'USER_REJECTED'
      if (errorKind && RPC_KINDS.has(errorKind)) return 'RPC_ERROR'
      if (view.status === 'idle') return 'VALIDATING'
      if (view.status === 'checking') return 'VALIDATING'
      const { report } = view
      if (report.verdict !== 'blocked') return 'READY'
      if (report.rpcFailure) return 'RPC_ERROR'
      return report.checks.some((check) => check.id === 'simulation' && check.status === 'fail') ? 'SIMULATION_FAILED' : 'VALIDATION_FAILED'
    }
  }
}
