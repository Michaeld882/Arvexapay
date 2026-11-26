import { Check, X } from 'lucide-react'
import type { FlowPhase } from '@/hooks/useTxFlow'
import { cx } from '@/components/ui'

export const TX_STEPS = ['Preparing', 'Confirming', 'Submitted', 'Confirmed'] as const

/**
 * Where a transaction is, from the real flow state:
 * Preparing  you are reviewing it, nothing is signed
 * Confirming the wallet is asking you to confirm
 * Submitted  the wallet sent it and we are waiting for the Arc receipt (the transaction hash exists)
 * Confirmed  the receipt succeeded and the expected onchain events were verified
 */
export function stepFor(phase: FlowPhase, hasHash: boolean): { active: number; failed: boolean; done: boolean } {
  switch (phase) {
    case 'idle':
    case 'review':
      return { active: 0, failed: false, done: false }
    case 'signing':
      return { active: 1, failed: false, done: false }
    case 'confirming':
    case 'stalled':
      return { active: 2, failed: false, done: false }
    case 'success':
      return { active: 3, failed: false, done: true }
    case 'failed':
      return { active: hasHash ? 2 : 1, failed: true, done: false }
  }
}

export function Stepper({ active, failed = false, done = false, className }: { active: number; failed?: boolean; done?: boolean; className?: string }) {
  return (
    <ol className={cx('flex items-start', className)} aria-label="Transaction progress">
      {TX_STEPS.map((label, index) => {
        const complete = done || index < active
        const current = !done && index === active
        const bad = current && failed
        return (
          <li key={label} className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center" aria-current={current ? 'step' : undefined}>
            {index > 0 && (
              <span aria-hidden className="absolute right-1/2 top-[13px] h-0.5 w-full overflow-hidden rounded-full bg-line">
                <span className="block h-full origin-left bg-accent transition-transform duration-500" style={{ transform: `scaleX(${index <= active || done ? 1 : 0})` }} />
              </span>
            )}
            <span
              className={cx(
                'relative z-10 flex size-[26px] items-center justify-center rounded-full border text-[11px] font-bold transition-colors duration-300',
                complete && 'border-transparent bg-accent text-accent-ink',
                current && !bad && 'border-accent bg-surface-strong text-accent-hover',
                bad && 'border-danger bg-surface-strong text-danger',
                !complete && !current && 'border-line bg-surface-strong text-subtle',
              )}
            >
              {complete ? <Check className="size-3.5" aria-hidden /> : bad ? <X className="size-3.5" aria-hidden /> : index + 1}
              {current && !bad && !done && <span aria-hidden className="status-ring absolute inset-0 rounded-full border border-accent" />}
            </span>
            <span className={cx('text-[11px] font-medium leading-tight', current || complete ? 'text-ink' : 'text-subtle', bad && 'text-danger')}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** The four-step tracker for the transaction dialog. */
export function TxStepper({ phase, hasHash }: { phase: FlowPhase; hasHash: boolean }) {
  const { active, failed, done } = stepFor(phase, hasHash)
  return <Stepper active={active} failed={failed} done={done} className="mb-5" />
}
