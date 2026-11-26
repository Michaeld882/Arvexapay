import { Clock } from 'lucide-react'
import { ExplorerLink } from '@/components/ui'
import { useRecovery } from '@/hooks/useRecovery'
import { useWallet } from '@/hooks/useWallet'
import { Link } from '@/lib/router'
import type { RecoveredSubmission, RecoveryOutcome } from '@/guardian/recovery'

/**
 * Shown only while something this wallet submitted is still unresolved, for example after a reload. It states what
 * is known (a real hash, still pending) and sends the user to the screen that owns it, instead of letting the same
 * transaction be started again.
 */
export function RecoveryNotice() {
  const { address } = useWallet()
  // Only submissions with a real hash are shown: those are known to exist onchain or in a pending state.
  const { pending, settled } = useRecovery(address)
  const items = pending.filter((item) => item.hash)
  if (items.length === 0 && settled.length === 0) return null
  if (items.length === 0) return <RecoveredList settled={settled} />
  return (
    <div>
    <section aria-label="Transactions in progress" className="mb-4 space-y-2 rounded-2xl border border-line bg-surface-muted p-3.5 text-sm">
      <p className="flex items-center gap-2 font-semibold text-ink">
        <Clock className="size-4 text-ink-2" aria-hidden />
        {items.length === 1 ? 'A transaction is still in progress' : `${items.length} transactions are still in progress`}
      </p>
      <ul className="space-y-1.5 text-xs text-ink-2">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {item.title}: waiting for confirmation
            </span>
            {item.kind === 'cctp' ? (
              <Link to="/circle/bridge" className="font-semibold text-accent-hover hover:underline">Open Bridge</Link>
            ) : item.kind.startsWith('gateway-') ? (
              <Link to="/circle/gateway" className="font-semibold text-accent-hover hover:underline">Open Gateway</Link>
            ) : item.hash ? (
              <ExplorerLink hash={item.hash} />
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted">It is checked again automatically. Do not send it a second time.</p>
    </section>
    {settled.length > 0 && <RecoveredList settled={settled} />}
    </div>
  )
}

const OUTCOME_TEXT: Record<RecoveryOutcome, string> = {
  verified: 'confirmed, and the expected result was found in it',
  confirmed: 'confirmed by the network (the result was not checked)',
  unverified: 'confirmed, but the expected result was NOT found in it. Check the explorer',
  failed: 'failed onchain, no funds moved',
  pending: 'still pending',
  unknown: 'could not be checked yet',
}

/** What recovery found for transactions that were in flight before the reload. Only "verified" claims the result matched. */
function RecoveredList({ settled }: { settled: RecoveredSubmission[] }) {
  return (
    <section aria-label="Recovered transactions" className="mb-4 space-y-1.5 rounded-2xl border border-line bg-surface-muted p-3.5 text-xs text-ink-2">
      <p className="text-sm font-semibold text-ink">Recovered after reload</p>
      <ul className="space-y-1">
        {settled.map((item) => (
          <li key={item.submission.id} className="flex flex-wrap items-center justify-between gap-2" data-outcome={item.outcome}>
            <span>
              {item.submission.title}: {OUTCOME_TEXT[item.outcome]}
            </span>
            {item.submission.hash && <ExplorerLink hash={item.submission.hash} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
