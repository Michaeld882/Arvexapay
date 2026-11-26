import { Check, CircleAlert, Clock, Loader2, ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react'
import { guardianPhase, type FlowPhaseName } from '@/guardian/state'
import type { CheckStatus, GuardianView } from '@/guardian/types'
import type { ErrorKind } from '@/lib/errors'
import { Banner, Button, cx } from '@/components/ui'

interface GuardianStatusProps {
  view: GuardianView
  flowPhase: FlowPhaseName
  hasHash: boolean
  errorKind?: ErrorKind
  /** Run the checks again. Offered when the network could not be reached. */
  onRecheck?: () => void
}

export function Pill({ tone, icon: Icon, children, spin }: { tone: 'good' | 'warn' | 'bad' | 'info'; icon: typeof Check; children: string; spin?: boolean }) {
  const color = tone === 'good' ? 'var(--accent-hover, #2cf5a6)' : tone === 'warn' ? 'var(--warn, #f5b02c)' : tone === 'bad' ? 'var(--danger, #ff5d6c)' : 'var(--muted, #8a9a93)'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold text-ink-2" style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
      <Icon className={cx('size-3.5', spin && 'animate-spin')} style={{ color }} aria-hidden />
      {children}
    </span>
  )
}

const MARK: Record<CheckStatus, { icon: typeof Check; color: string }> = {
  pass: { icon: Check, color: 'var(--accent-hover, #2cf5a6)' },
  warn: { icon: CircleAlert, color: 'var(--warn, #f5b02c)' },
  fail: { icon: X, color: 'var(--danger, #ff5d6c)' },
  skipped: { icon: Clock, color: 'var(--muted, #8a9a93)' },
}

function Details({ view, technical }: { view: Extract<GuardianView, { status: 'done' }>; technical?: string }) {
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer select-none font-semibold">What was checked</summary>
      <ul className="mt-1.5 space-y-1">
        {view.report.checks.map((check) => {
          const { icon: Icon, color } = MARK[check.status]
          return (
            <li key={check.id} className="flex items-start gap-1.5">
              <Icon className="mt-0.5 size-3 shrink-0" style={{ color }} aria-hidden />
              <span>
                <span className="font-semibold text-ink-2">{check.label}</span>
                {check.message ? `: ${check.message}` : ''}
              </span>
            </li>
          )
        })}
      </ul>
      {technical && <pre className="mono mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-muted p-2.5 [overflow-wrap:anywhere]">{technical}</pre>}
    </details>
  )
}

/**
 * A small status for the transaction screen. Before signing it shows what the Guardian found; after the wallet
 * submits it shows that the transaction is being watched, and "Verified" only once the receipt and its logs match.
 */
export function GuardianStatus({ view, flowPhase, hasHash, errorKind, onRecheck }: GuardianStatusProps) {
  const phase = guardianPhase({ flow: flowPhase, errorKind, hasHash, view })

  if (phase === 'PENDING' || phase === 'SUBMITTED' || phase === 'TIMEOUT' || (phase === 'RPC_ERROR' && hasHash)) {
    return <div className="mb-3 flex flex-wrap gap-2" aria-label="Guardian status"><Pill tone="info" icon={Clock}>Monitoring</Pill></div>
  }
  if (phase === 'VERIFIED') {
    return <div className="mb-3 flex flex-wrap gap-2" aria-label="Guardian status"><Pill tone="good" icon={ShieldCheck}>Verified</Pill></div>
  }
  if (flowPhase !== 'review') return null

  if (view.status !== 'done') {
    return <div className="mb-3 flex flex-wrap gap-2" aria-label="Guardian status"><Pill tone="info" icon={Loader2} spin>Checking this transaction</Pill></div>
  }
  const { report } = view
  if (report.verdict === 'blocked') {
    return (
      <Banner
        className="mb-3"
        tone="danger"
        title="Transaction blocked"
        action={
          onRecheck ? (
            <Button variant="secondary" className="min-h-10" onClick={onRecheck}>
              {report.rpcFailure ? 'Try again' : 'Check again'}
            </Button>
          ) : undefined
        }
      >
        {report.reason ?? 'This transaction did not pass the safety checks. Nothing was sent.'}
        <Details view={view} technical={report.technical} />
      </Banner>
    )
  }
  const warnings = report.checks.filter((check) => check.status === 'warn')
  if (report.verdict === 'review') {
    return (
      <div className="mb-3">
        <div className="flex flex-wrap gap-2" aria-label="Guardian status">
          <Pill tone="warn" icon={ShieldAlert}>Review required</Pill>
          {report.simulated && <Pill tone="good" icon={Check}>Simulation passed</Pill>}
        </div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-2">
          {warnings.map((check) => (
            <li key={check.id}>{check.message}</li>
          ))}
        </ul>
        <Details view={view} />
      </div>
    )
  }
  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-2" aria-label="Guardian status">
        <Pill tone="good" icon={ShieldCheck}>Ready to sign</Pill>
        {report.simulated && <Pill tone="good" icon={Check}>Simulation passed</Pill>}
        {!report.simulated && <Pill tone="warn" icon={ShieldX}>{report.checks.some((check) => check.id === 'estimate' && check.status === 'pass') ? 'Estimated, not simulated' : 'Not simulated'}</Pill>}
      </div>
      <Details view={view} />
    </div>
  )
}
