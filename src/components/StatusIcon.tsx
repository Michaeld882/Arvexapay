import { Loader2, ShieldAlert, X } from 'lucide-react'
import { cx } from '@/components/ui'

type Status = 'success' | 'pending' | 'failed' | 'warn'

const TONE: Record<Status, { color: string; label: string }> = {
  success: { color: 'var(--success)', label: 'Success' },
  pending: { color: 'var(--accent-hover)', label: 'In progress' },
  failed: { color: 'var(--danger)', label: 'Failed' },
  warn: { color: 'var(--warn)', label: 'Needs attention' },
}

/**
 * Animated transaction status: a drawn checkmark for success, pulsing rings for pending,
 * a short shake for failure. Motion is driven by CSS and is disabled for reduced-motion users.
 */
export function StatusIcon({ status, className }: { status: Status; className?: string }) {
  const { color, label } = TONE[status]
  return (
    <div role="img" aria-label={label} className={cx('relative mx-auto grid size-16 place-items-center', className)} style={{ color }}>
      {status === 'pending' && (
        <>
          <span aria-hidden className="status-ring absolute inset-0 rounded-full border-2" style={{ borderColor: color }} />
          <span aria-hidden className="status-ring absolute inset-0 rounded-full border-2" style={{ borderColor: color, animationDelay: '0.9s' }} />
        </>
      )}
      {status === 'success' && (
        <span
          aria-hidden
          className="status-ring absolute inset-0 rounded-full border-2"
          style={{ borderColor: color, animationIterationCount: 1, animationDelay: '0.2s' }}
        />
      )}
      <span
        className={cx('relative grid size-14 place-items-center rounded-full border', status === 'success' && 'status-pop', status === 'failed' && 'status-shake status-pop')}
        style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
      >
        {status === 'success' && (
          <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path className="status-check" d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        )}
        {status === 'pending' && <Loader2 className="size-7 animate-spin" aria-hidden />}
        {status === 'failed' && <X className="size-7" strokeWidth={2.6} aria-hidden />}
        {status === 'warn' && <ShieldAlert className="size-7" aria-hidden />}
      </span>
    </div>
  )
}
