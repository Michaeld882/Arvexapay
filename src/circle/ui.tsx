import type { ReactNode } from 'react'
import { Check, CircleDashed, ExternalLink, Loader2, X } from 'lucide-react'
import { STEP_LABELS, type StepView, type TransferRecord } from '@/circle/cctp'
import type { IntegrationState } from '@/circle/status'
import { cx } from '@/components/ui'
import { shortHash } from '@/lib/format'

const PILL: Record<IntegrationState, { label: string; color: string }> = {
  active: { label: 'Active', color: 'var(--success)' },
  checking: { label: 'Checking', color: 'var(--accent-hover)' },
  unavailable: { label: 'Unavailable', color: 'var(--danger)' },
  disabled: { label: 'Turned off', color: 'var(--muted)' },
  needs_access: { label: 'Needs Circle access', color: 'var(--warn)' },
  needs_configuration: { label: 'Needs setup', color: 'var(--warn)' },
}

export function StatusPill({ state }: { state: IntegrationState }) {
  const { label, color } = PILL[state]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-ink-2"
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px 0 ${color}` }} aria-hidden />
      {label}
    </span>
  )
}

export function ExternalTx({ url, hash }: { url?: string; hash: string }) {
  const text = shortHash(hash)
  if (!url) return <span className="mono text-xs">{text}</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={hash} className="mono inline-flex items-center gap-1 text-xs font-semibold text-accent-hover underline-offset-2 hover:underline">
      {text}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  )
}

function StepIcon({ state }: { state: StepView['state'] }) {
  if (state === 'success') return <Check className="size-4 text-success" aria-hidden />
  if (state === 'error') return <X className="size-4 text-danger" aria-hidden />
  if (state === 'active') return <Loader2 className="size-4 animate-spin text-accent-hover" aria-hidden />
  return <CircleDashed className="size-4 text-subtle" aria-hidden />
}

/** The four CCTP steps with their real transaction hashes as they arrive. */
export function StepList({ record }: { record: TransferRecord }) {
  return (
    <ol className="space-y-2" aria-label="Transfer steps">
      {record.steps.map((step) => (
        <li key={step.name} className="flex items-start justify-between gap-3 rounded-2xl border border-line bg-surface-muted px-3.5 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5">
              <StepIcon state={step.state} />
            </span>
            <div className="min-w-0">
              <p className={cx('text-sm font-semibold', step.state === 'idle' ? 'text-muted' : 'text-ink')}>{STEP_LABELS[step.name]}</p>
              {step.message && step.state === 'error' && <p className="mt-0.5 text-xs text-danger [overflow-wrap:anywhere]">{step.message}</p>}
              {step.name === 'fetchAttestation' && step.state === 'active' && <p className="mt-0.5 text-xs text-muted">Waiting for Circle to sign the burn.</p>}
              {step.name === 'mint' && step.state === 'active' && record.useForwarder && <p className="mt-0.5 text-xs text-muted">Circle submits the mint on Arc for you.</p>}
            </div>
          </div>
          {step.txHash && <ExternalTx url={step.explorerUrl} hash={step.txHash} />}
        </li>
      ))}
    </ol>
  )
}

export function FeeRows({ lines, loading, error }: { lines: ReadonlyArray<{ label: string; amount: string; token: string }> | undefined; loading: boolean; error?: ReactNode }) {
  if (loading) return <p className="py-2.5 text-sm text-muted">Getting the fee from Circle...</p>
  if (error) return <p className="py-2.5 text-sm text-warn">{error}</p>
  if (!lines || lines.length === 0) return <p className="py-2.5 text-sm text-muted">Enter an amount to see the fee.</p>
  return (
    <>
      {lines.map((line) => (
        <div key={`${line.label}-${line.token}`} className="flex items-start justify-between gap-4 py-2.5 text-sm">
          <dt className="shrink-0 text-muted">{line.label}</dt>
          <dd className="min-w-0 text-right font-medium tabular-nums text-ink">
            {line.amount} {line.token}
          </dd>
        </div>
      ))}
    </>
  )
}
