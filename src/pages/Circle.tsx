import { ArrowRight, Check, RefreshCw, X } from 'lucide-react'
import { ARC_CHAIN_ID, ARC_RPC_URL, NETWORK_LABEL, USDC } from '@/chain'
import { PAYMENT_RAILS, usePayments } from '@/circle/payments/rails'
import type { PaymentRail } from '@/circle/payments/types'
import { useArcHead, useCctpChains, useCircleChecks, useIntegrationStatus, useUsdcOnArc } from '@/circle/status'
import type { CheckGroup } from '@/circle/verify'
import { ExternalTx, StatusPill } from '@/circle/ui'
import { Banner, Button, Card, CopyButton, PageHeader, Row, Skeleton, cx } from '@/components/ui'
import { useWallet } from '@/hooks/useWallet'
import { formatTimestamp, formatUsdcDisplay, shortAddress } from '@/lib/format'
import { Link } from '@/lib/router'

function StatusRow({ item }: { item: ReturnType<typeof useIntegrationStatus>[number] }) {
  const body = (
    <div className="flex items-start justify-between gap-3 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{item.title}</p>
        <p className="mt-0.5 text-xs text-muted">{item.detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusPill state={item.state} />
        {item.path && <ArrowRight className="size-4 text-subtle" aria-hidden />}
      </div>
    </div>
  )
  return <li>{item.path ? <Link to={item.path} className="block rounded-xl transition-colors hover:bg-surface-muted/60">{body}</Link> : body}</li>
}

function StatusCard() {
  const items = useIntegrationStatus()
  const live = items.filter((item) => item.group === 'live')
  const access = items.filter((item) => item.group === 'access')
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="display text-lg font-semibold">Integration status</h2>
        <p className="mt-1 text-sm text-muted">Each status comes from a live check against Arc Mainnet or Circle, not a fixed label.</p>
      </div>
      <section aria-label="Live now">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Live now, no Circle credentials needed</h3>
        <ul className="divide-y divide-line">
          {live.map((item) => (
            <StatusRow key={item.id} item={item} />
          ))}
        </ul>
      </section>
      <section aria-label="Needs Circle access">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Needs Circle access</h3>
        <ul className="divide-y divide-line">
          {access.map((item) => (
            <StatusRow key={item.id} item={item} />
          ))}
        </ul>
      </section>
    </Card>
  )
}

function UsdcCard() {
  const usdc = useUsdcOnArc()
  const cctp = useCctpChains()
  const head = useArcHead()
  return (
    <Card className="space-y-2">
      <h2 className="display text-lg font-semibold">USDC on Arc</h2>
      <p className="text-sm text-muted">Circle-issued native USDC is Arvexa's settlement and payment asset. Balances, Send, Deposit, Withdraw and the vault all use this one contract.</p>
      <dl className="divide-y divide-line">
        <Row label="Network">{NETWORK_LABEL}</Row>
        <Row label="USDC contract"><span className="mono text-xs">{USDC.address}</span></Row>
        <Row label="Decimals">{USDC.decimals} (ERC-20 view)</Row>
        <Row label="Gas token">USDC. Fees are paid from the same balance, so it is never counted twice.</Row>
        <Row label="CCTP domain">{cctp.data ? (cctp.data.destination.cctp?.domain ?? '—') : cctp.isPending ? <Skeleton className="ml-auto h-4 w-8" /> : '—'}</Row>
        <Row label="RPC endpoint"><span className="mono text-xs">{new URL(ARC_RPC_URL).host}</span></Row>
        <Row label="Latest Arc block">{head.data !== undefined ? <span className="tabular-nums">{head.data.toString()}</span> : head.isError ? 'Unavailable' : <Skeleton className="ml-auto h-4 w-20" />}</Row>
        <Row label="Contract check">{usdc.isPending ? <Skeleton className="ml-auto h-4 w-24" /> : usdc.isError ? 'Could not check' : usdc.data.ok ? 'Verified on Arc Mainnet' : 'Mismatch'}</Row>
      </dl>
      <CopyButton value={USDC.address} label="Copy USDC address" className="min-h-10" />
    </Card>
  )
}

const GROUP_TITLES: Record<CheckGroup, string> = { usdc: 'USDC on Arc', cctp: 'CCTP', gateway: 'Gateway' }

function ChecksCard() {
  const checks = useCircleChecks()
  const passed = checks.data?.filter((check) => check.ok).length ?? 0
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg font-semibold">Live configuration checks</h2>
          <p className="mt-1 text-sm text-muted">Read-only. They compare Arc Mainnet, Circle's registry and this app. No keys, no signing.</p>
        </div>
        <Button variant="secondary" className="min-h-10 shrink-0 px-3" loading={checks.isFetching} onClick={() => void checks.refetch()} aria-label="Run the checks again">
          {!checks.isFetching && <RefreshCw className="size-4" aria-hidden />}
          Re-run
        </Button>
      </div>
      {checks.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : checks.isError ? (
        <Banner tone="danger" title="Could not run the checks">Try again in a moment.</Banner>
      ) : (
        <>
          <p className={cx('text-sm font-semibold', passed === checks.data.length ? 'text-accent-hover' : 'text-warn')} data-testid="check-summary">
            {passed} of {checks.data.length} checks passed
          </p>
          {(['usdc', 'cctp', 'gateway'] as const).map((group) => (
            <details key={group} className="rounded-2xl border border-line bg-surface-muted px-3.5" open={checks.data.some((check) => check.group === group && !check.ok)}>
              <summary className="cursor-pointer select-none py-3 text-sm font-semibold text-ink-2">{GROUP_TITLES[group]}</summary>
              <ul className="divide-y divide-line pb-1">
                {checks.data
                  .filter((check) => check.group === group)
                  .map((check) => (
                    <li key={check.id} className="flex items-start gap-2.5 py-2.5">
                      {check.ok ? <Check className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" /> : <X className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{check.label}</p>
                        <p className="mono text-[11px] text-muted [overflow-wrap:anywhere]">{check.detail}</p>
                      </div>
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </>
      )}
    </Card>
  )
}

function Rail({ rail }: { rail: PaymentRail }) {
  const readiness = rail.readiness()
  const state = readiness.status === 'active' ? 'active' : readiness.status
  return (
    <li className="space-y-2 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{rail.label}</p>
          <p className="mt-0.5 text-xs text-muted">{rail.summary}</p>
        </div>
        <StatusPill state={state} />
      </div>
      <p className="text-xs text-ink-2">{readiness.detail}</p>
      {readiness.status !== 'active' && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          {readiness.requirements.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {rail.startPath && readiness.status === 'active' && (
        <Link to={rail.startPath} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-hover hover:underline">
          Start a payment <ArrowRight className="size-3" aria-hidden />
        </Link>
      )}
    </li>
  )
}

function Payments({ address }: { address: string | undefined }) {
  const payments = usePayments(address)
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">Payment tracking</h3>
      {!address ? (
        <p className="mt-2 text-sm text-muted">Connect a wallet to see payments made from this browser.</p>
      ) : payments.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No payments yet. A payment appears here with its recipient, amount and settlement as soon as you send one.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {payments.slice(0, 6).map((payment) => (
            <li key={payment.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-semibold tabular-nums">{formatUsdcDisplay(payment.amount)} USDC</p>
                <p className="mono text-xs text-muted">to {payment.recipient ? shortAddress(payment.recipient, 8, 6) : 'unknown'}</p>
                <p className="text-xs text-muted">{formatTimestamp(Math.floor(payment.createdAt / 1000))}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs font-semibold">
                  {payment.settlement.state === 'settled' ? 'Settled on Arc' : payment.settlement.state === 'failed' ? 'Failed' : payment.settlement.state === 'unverified' ? 'Mined, not verified' : 'Settling'}
                </p>
                {payment.settlement.reference && <ExternalTx url={payment.settlement.url} hash={payment.settlement.reference} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PaymentsCard() {
  const { address } = useWallet()
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="display text-lg font-semibold">Payment infrastructure</h2>
        <p className="mt-1 text-sm text-muted">Payments run on rails behind one interface, so another rail can be connected without changing Send, tracking or settlement.</p>
      </div>
      <ul className="divide-y divide-line">
        {PAYMENT_RAILS.map((rail) => (
          <Rail key={rail.id} rail={rail} />
        ))}
      </ul>
      <Payments address={address} />
    </Card>
  )
}

export default function Circle() {
  return (
    <>
      <PageHeader title="Circle Integration" subtitle={`Native USDC, CCTP, Gateway and payment rails on ${NETWORK_LABEL}.`} />
      <div className="space-y-5">
        <Banner tone="info" title="What is active and what needs Circle">
          USDC on Arc, CCTP and Gateway are live and need no Circle credentials. Your wallet signs every transaction, and nothing moves until you confirm it. Circle Payments Network needs access from Circle and a server you run, so it stays marked "Needs Circle access" until then.
        </Banner>
        <StatusCard />
        <UsdcCard />
        <PaymentsCard />
        <ChecksCard />
        <p className="text-center text-xs text-muted">Chain ID {ARC_CHAIN_ID}. Mainnet moves real funds and transactions cannot be reversed.</p>
      </div>
    </>
  )
}
