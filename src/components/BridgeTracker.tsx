import { Check, Circle, Loader2, X } from 'lucide-react'
import type { TransferRecord } from '@/circle/cctp'
import { bridgeStages, type BridgeStageState } from '@/guardian/bridge'
import { cx } from '@/components/ui'

const ICON: Record<BridgeStageState, typeof Check> = { done: Check, active: Loader2, waiting: Circle, failed: X }

/** The Guardian's cross-chain timeline. Each stage turns done only when its own proof exists. */
export function BridgeTracker({ record }: { record: TransferRecord }) {
  const stages = bridgeStages(record)
  return (
    <ol className="space-y-1.5 rounded-2xl border border-line bg-surface-muted px-3.5 py-3 text-xs" aria-label="Cross-chain tracking">
      {stages.map((stage) => {
        const Icon = ICON[stage.state]
        return (
          <li key={stage.id} className="flex items-start gap-2" data-stage={stage.id} data-state={stage.state}>
            <Icon className={cx('mt-0.5 size-3.5 shrink-0', stage.state === 'done' && 'text-accent-hover', stage.state === 'active' && 'animate-spin text-ink-2', stage.state === 'failed' && 'text-danger', stage.state === 'waiting' && 'text-subtle')} aria-hidden />
            <span className={cx(stage.state === 'waiting' ? 'text-muted' : 'text-ink-2', 'font-medium')}>{stage.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
