import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react'
import { NETWORK_LABEL } from '@/chain'
import { useFeeEstimate } from '@/hooks/useFeeEstimate'
import type { useTxFlow } from '@/hooks/useTxFlow'
import { useWallet } from '@/hooks/useWallet'
import { classifyError, type AppError } from '@/lib/errors'
import { formatUsdcDisplay, shortHash } from '@/lib/format'
import { Banner, Button, ExplorerLink, Row, Skeleton, Spinner } from '@/components/ui'

type Flow = ReturnType<typeof useTxFlow>

interface TxDialogProps {
  flow: Flow
  /** Raw wallet USDC balance. On Arc this single pool also pays the network fee. */
  walletUsdc: bigint | undefined
}

function TechnicalDetails({ error }: { error: AppError }) {
  if (!error.detail || error.detail === error.message || error.kind === 'user_rejected') return null
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer select-none font-semibold">Technical details</summary>
      <pre className="mono mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-muted p-2.5 [overflow-wrap:anywhere]">{error.detail}</pre>
    </details>
  )
}

function ReviewBody({ flow, walletUsdc }: TxDialogProps) {
  const { state, submit, reset } = flow
  const plan = state.plan
  const { address, wrongNetwork, switchToArc, isSwitching } = useWallet()
  const fee = useFeeEstimate(plan?.call ?? null, address)
  if (!plan) return null

  const feeUsdc = fee.data?.feeUsdc
  const spendsFromWallet = plan.kind === 'send' || plan.kind === 'deposit'
  const required = feeUsdc === undefined ? undefined : spendsFromWallet ? plan.amount + feeUsdc : feeUsdc
  const short = walletUsdc !== undefined && required !== undefined && walletUsdc < required ? required - walletUsdc : 0n
  const canConfirm = !wrongNetwork && feeUsdc !== undefined && walletUsdc !== undefined && short === 0n

  return (
    <>
      <dl className="divide-y divide-line rounded-2xl border border-line bg-surface-muted px-4">
        {plan.rows.map((row) => (
          <Row key={row.label} label={row.label}>
            <span className={row.mono ? 'mono text-xs' : undefined}>{row.value}</span>
          </Row>
        ))}
        <Row label="Network">{NETWORK_LABEL}</Row>
        <Row label="Network fee (up to)">
          {fee.isPending ? (
            <Skeleton className="ml-auto h-4 w-24" />
          ) : feeUsdc !== undefined ? (
            <span className="tabular-nums">{formatUsdcDisplay(feeUsdc)} USDC</span>
          ) : (
            'Unavailable'
          )}
        </Row>
        {spendsFromWallet && feeUsdc !== undefined && (
          <Row label="Total from wallet">
            <span className="tabular-nums">{formatUsdcDisplay(plan.amount + feeUsdc)} USDC</span>
          </Row>
        )}
      </dl>

      <div className="mt-3 space-y-3">
        {state.error && (
          <Banner tone={state.error.kind === 'user_rejected' ? 'info' : 'danger'}>
            {state.error.message}
            <TechnicalDetails error={state.error} />
          </Banner>
        )}
        {fee.isError && (
          <Banner
            tone="danger"
            title="Could not prepare this transaction"
            action={
              <Button variant="secondary" className="min-h-10" loading={fee.isFetching} onClick={() => void fee.refetch()}>
                Try again
              </Button>
            }
          >
            {classifyError(fee.error).message}
            <TechnicalDetails error={classifyError(fee.error)} />
          </Banner>
        )}
        {short > 0n && (
          <Banner tone="warn" title="Not enough USDC for the network fee">
            On Arc, gas is paid in the same USDC balance. {spendsFromWallet ? 'Reduce the amount by about' : 'Add about'} {formatUsdcDisplay(short)} USDC.
          </Banner>
        )}
        {wrongNetwork && (
          <Banner tone="danger" title="Wrong network">
            Switch your wallet to {NETWORK_LABEL} before confirming.
          </Banner>
        )}
      </div>

      <div className="mt-5 flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={reset}>
          Cancel
        </Button>
        {wrongNetwork ? (
          <Button className="flex-[2]" loading={isSwitching} onClick={() => void switchToArc()}>
            Switch network
          </Button>
        ) : (
          <Button className="flex-[2]" disabled={!canConfirm} onClick={() => void submit()}>
            {plan.confirmLabel}
          </Button>
        )}
      </div>
    </>
  )
}

function Progress({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <Spinner className="size-8 text-accent-hover" />
      <p className="display text-lg font-semibold">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  )
}

export function TxDialog({ flow, walletUsdc }: TxDialogProps) {
  const { state, recheck, reset } = flow
  const plan = state.plan
  const open = state.phase !== 'idle' && plan !== null
  const panel = useRef<HTMLDivElement>(null)
  const closable = state.phase === 'review' || state.phase === 'success' || state.phase === 'failed' || state.phase === 'stalled'

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => previous?.focus?.()
  }, [open])

  // Keep keyboard focus inside the dialog while it is open.
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !panel.current) return
    const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  useEffect(() => {
    if (!open || !closable) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && reset()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closable, reset])

  const unverified = state.error?.kind === 'unverified'

  return (
    <AnimatePresence>
      {open && plan && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close"
            disabled={!closable}
            onClick={reset}
            className="absolute inset-0 cursor-default backdrop-blur-sm"
            style={{ background: 'var(--overlay)' }}
          />
          <motion.div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={plan.title}
            onKeyDown={trapFocus}
            className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-line bg-surface-strong p-5 pb-[76px] shadow-2xl outline-none sm:rounded-3xl sm:pb-5"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 36 }}
          >
            <h2 className="display mb-4 text-xl font-semibold">{plan.title}</h2>

            {state.phase === 'review' && <ReviewBody flow={flow} walletUsdc={walletUsdc} />}

            {state.phase === 'signing' && <Progress title="Confirm in your wallet">Review the request in your wallet and approve it. Nothing is sent until you do.</Progress>}

            {state.phase === 'confirming' && (
              <Progress title="Waiting for confirmation">
                <p>Submitted to Arc Mainnet. Do not close this window.</p>
                {state.hash && (
                  <p className="mt-2 flex flex-col items-center gap-1">
                    <span className="mono text-xs">{shortHash(state.hash)}</span>
                    <ExplorerLink hash={state.hash} />
                  </p>
                )}
              </Progress>
            )}

            {state.phase === 'stalled' && state.hash && (
              <div className="space-y-3">
                <Banner tone="warn" title="Confirmation not received yet">
                  The transaction was submitted, but the network could not be reached to confirm it. It may still succeed, so do not send it again.
                  {state.error && <TechnicalDetails error={state.error} />}
                </Banner>
                <p className="mono text-center text-xs">{state.hash}</p>
                <div className="flex justify-center">
                  <ExplorerLink hash={state.hash} />
                </div>
                <div className="flex gap-3">
                  <Button variant="secondary" className="flex-1" onClick={reset}>
                    Close
                  </Button>
                  <Button className="flex-[2]" onClick={() => void recheck()}>
                    Check again
                  </Button>
                </div>
              </div>
            )}

            {state.phase === 'success' && (
              <div className="space-y-4 text-center">
                <CheckCircle2 className="mx-auto size-12 text-success" aria-hidden />
                <div>
                  <p className="display text-lg font-semibold">Confirmed</p>
                  <p className="mt-1 text-sm text-muted">{plan.successText}</p>
                </div>
                {state.hash && (
                  <div className="rounded-2xl border border-line bg-surface-muted p-3">
                    <p className="text-xs text-muted">Transaction hash</p>
                    <p className="mono mt-1 text-xs [overflow-wrap:anywhere]">{state.hash}</p>
                    <div className="mt-2">
                      <ExplorerLink hash={state.hash} />
                    </div>
                  </div>
                )}
                <Button className="w-full" onClick={reset}>
                  Done
                </Button>
              </div>
            )}

            {state.phase === 'failed' && (
              <div className="space-y-4 text-center">
                {unverified ? <ShieldAlert className="mx-auto size-12 text-warn" aria-hidden /> : <XCircle className="mx-auto size-12 text-danger" aria-hidden />}
                <div>
                  <p className="display text-lg font-semibold">{unverified ? 'Could not verify result' : 'Transaction failed'}</p>
                  <p className="mt-1 text-sm text-muted">{state.error?.message}</p>
                  {state.error && <TechnicalDetails error={state.error} />}
                </div>
                {state.hash && (
                  <div className="rounded-2xl border border-line bg-surface-muted p-3">
                    <p className="mono text-xs [overflow-wrap:anywhere]">{state.hash}</p>
                    <div className="mt-2">
                      <ExplorerLink hash={state.hash} />
                    </div>
                  </div>
                )}
                <Button className="w-full" onClick={reset}>
                  Close
                </Button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
