import { HandCoins, QrCode, RefreshCw, ScanLine, Send, type LucideIcon } from 'lucide-react'
import type { Address } from 'viem'
import { NETWORK_LABEL } from '@/chain'
import { ActivityList } from '@/components/ActivityList'
import { AnimatedAmount } from '@/components/AnimatedAmount'
import { ConnectGate } from '@/components/ConnectGate'
import { Insights } from '@/components/Insights'
import { MODULES } from '@/components/payments/kit'
import { DataError, OverviewStats, PendingList, UpcomingCard } from '@/components/payments/Overview'
import { Banner, Button, Card, CopyButton, Skeleton, cx } from '@/components/ui'
import { usePaymentsData } from '@/hooks/usePayments'
import { useBalances } from '@/hooks/useBalances'
import { useWallet } from '@/hooks/useWallet'
import { SlowHint } from '@/components/SlowHint'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay, shortAddress } from '@/lib/format'
import { Link } from '@/lib/router'

const ACTIONS: ReadonlyArray<{ to: string; label: string; full: string; icon: LucideIcon; tint: string }> = [
  { to: '/send', label: 'Send', full: 'Send', icon: Send, tint: '#22d3ee' },
  { to: '/receive', label: 'Receive', full: 'Receive', icon: QrCode, tint: '#2cf5a6' },
  { to: '/scan', label: 'Scan & Pay', full: 'Scan and pay', icon: ScanLine, tint: '#4f8cff' },
  { to: MODULES.split.path, label: 'Split', full: 'Split payment', icon: MODULES.split.icon, tint: MODULES.split.from },
  { to: MODULES.link.path, label: 'Pay Link', full: 'Payment link', icon: MODULES.link.icon, tint: MODULES.link.from },
  { to: MODULES.invoice.path, label: 'Invoice', full: 'Invoice', icon: MODULES.invoice.icon, tint: MODULES.invoice.from },
  { to: MODULES.request.path, label: 'Request', full: 'Request payment', icon: HandCoins, tint: MODULES.request.from },
  { to: MODULES.merchant.path, label: 'Merchant', full: 'Merchant mode', icon: MODULES.merchant.icon, tint: MODULES.merchant.from },
]

const MORE: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/deposit', label: 'Deposit' },
  { to: '/withdraw', label: 'Withdraw' },
  { to: '/swap', label: 'Swap' },
  { to: '/activity', label: 'History' },
  { to: MODULES.receipts.path, label: 'Receipts' },
  { to: '/payments', label: 'All payment tools' },
]

/** The hero shows the exact balance (never a rounded 0.00); longer numbers get a smaller type size. */
function HeroAmount({ raw, loading, address }: { raw: bigint | undefined; loading: boolean; address: string }) {
  if (loading) return <Skeleton className="h-11 w-48" />
  const text = raw === undefined ? '—' : formatUsdcDisplay(raw)
  const size = text.length <= 10 ? 'text-4xl sm:text-5xl' : text.length <= 14 ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl'
  const classes = cx('display min-w-0 font-semibold tabular-nums text-ink [overflow-wrap:anywhere]', size)
  return (
    <span data-testid="hero-balance" className={classes}>
      {raw === undefined ? text : <AnimatedAmount raw={raw} resetKey={address} />}
    </span>
  )
}

/** The eight payment actions and the secondary links. Plain links, so they work before any data has loaded. */
function QuickActions() {
  return (
      <section aria-label="Quick actions" className="space-y-2.5">
        <nav className="grid grid-cols-4 gap-2 sm:gap-3">
          {ACTIONS.map(({ to, label, full, icon: Icon, tint }, index) => (
            <Link
              key={to}
              to={to}
              aria-label={full}
              style={{ ['--d' as string]: `${300 + index * 45}ms`, ['--tint' as string]: tint }}
              className="tile surface lift rise group flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-2xl px-1 text-center text-[11px] font-semibold leading-tight text-ink sm:text-xs"
            >
              <span className="icon-chip">
                <Icon className="size-5 transition-transform duration-300 group-hover:scale-110 group-active:scale-90" aria-hidden />
              </span>
              {label}
            </Link>
          ))}
        </nav>
        <nav aria-label="More" className="flex flex-wrap gap-1.5">
          {MORE.map(({ to, label }) => (
            <Link key={to} to={to} className="inline-flex min-h-9 items-center rounded-full border border-line bg-surface-muted px-3.5 text-xs font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink">
              {label}
            </Link>
          ))}
        </nav>
      </section>
  )
}

/** What shows while a saved wallet session is being restored: the real layout with skeletons, and working actions. */
function DashboardShell() {
  return (
    <div className="space-y-5" aria-busy>
      <Card className="hero-card">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Wallet balance</p>
        <Skeleton className="mt-3 h-11 w-48" />
        <Skeleton className="mt-3 h-4 w-32" />
      </Card>
      <QuickActions />
      <Card className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-full" />
      </Card>
      <Card className="space-y-3">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </Card>
    </div>
  )
}

function DashboardContent({ address }: { address: Address }) {
  const balances = useBalances(address)
  const data = usePaymentsData(address)
  const activity = data.activity
  const recent = activity.items.slice(0, 5)

  return (
    <div className="space-y-5">
      <Card className="rise ambient lift-lg hero-card">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            {balances.vaultReady ? 'Total available' : 'Wallet balance'}
          </p>
          <div className="flex items-center gap-1.5">
            <span className="mono rounded-full bg-surface-muted px-2.5 py-1 text-[11px] text-ink-2" title={address}>
              {shortAddress(address)}
            </span>
            <button
              type="button"
              onClick={balances.refetch}
              disabled={balances.isFetching}
              aria-label="Refresh balance"
              title="Refresh balance"
              className="inline-flex size-8 items-center justify-center rounded-full bg-surface-muted text-ink-2 transition-colors hover:text-ink disabled:opacity-60"
            >
              <RefreshCw className={cx('size-3.5', balances.isFetching && 'animate-spin')} aria-hidden />
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2">
          <HeroAmount raw={balances.total} loading={balances.isLoading} address={address} />
          <span className="text-lg font-medium text-subtle">USDC</span>
        </div>
        <p className="mt-2 text-xs text-muted">{NETWORK_LABEL}</p>
        <SlowHint loading={balances.isLoading} onRetry={balances.refetch} />
        {balances.vaultReady && (
          <dl className="mt-4 flex flex-wrap gap-2" aria-label="Where your USDC is">
            <div className="stat-pill rounded-full px-3 py-1.5 text-xs">
              <dt className="inline text-muted">In wallet </dt>
              <dd className="inline font-semibold tabular-nums text-ink">
                {balances.walletRaw === undefined ? '—' : formatUsdcDisplay(balances.walletRaw)}
              </dd>
            </div>
            <div className="stat-pill rounded-full px-3 py-1.5 text-xs">
              <dt className="inline text-muted">In vault </dt>
              <dd className="inline font-semibold tabular-nums text-ink">
                {balances.vaultRaw === undefined ? '—' : formatUsdcDisplay(balances.vaultRaw)}
              </dd>
            </div>
          </dl>
        )}
        {balances.total === 0n && !balances.isError && (
          <p className="mt-4 rounded-2xl bg-accent-soft p-3 text-xs text-ink-2">
            No USDC on Arc Mainnet at this address yet. USDC on other networks is not counted.{' '}
            <Link to="/deposit" className="font-semibold text-accent-hover hover:underline">
              Add funds
            </Link>
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <CopyButton value={address} label="Copy address" className="min-h-10 flex-1" />
        </div>
      </Card>

      {balances.isError && (
        <Banner
          tone="danger"
          title="Could not load balances"
          action={
            <Button variant="secondary" className="min-h-10" onClick={balances.refetch}>
              Try again
            </Button>
          }
        >
          {classifyError(balances.wallet.error ?? balances.vault.error).message} No balance is shown until it loads.
        </Banner>
      )}

      <QuickActions />

      <Card className="rise space-y-3.5" style={{ ['--d' as string]: '420ms' }}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="display text-lg font-semibold">Payment overview</h2>
          <Link to="/payments" className="text-xs font-semibold text-accent-hover hover:underline">
            Open Payments
          </Link>
        </div>
        <DataError data={data} />
        <OverviewStats overview={data.overview} loading={activity.isLoading && data.ledger.length === 0} unavailable={activity.failed && data.ledger.length === 0} />
      </Card>

      <UpcomingCard owner={address} />

      <Card className="rise space-y-3" style={{ ['--d' as string]: '470ms' }}>
        <h2 className="display text-lg font-semibold">Pending requests and invoices</h2>
        <PendingList requests={data.requests} nowSeconds={data.nowSeconds} />
      </Card>

      <Card className="rise lift-lg" style={{ ['--d' as string]: '520ms' }}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="display text-lg font-semibold">Recent transactions</h2>
          <Link to="/activity" className="text-xs font-semibold text-accent-hover hover:underline">
            View all
          </Link>
        </div>
        {activity.isLoading ? (
          <div className="space-y-3 py-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <SlowHint loading onRetry={activity.refresh} />
          </div>
        ) : activity.failed && recent.length === 0 ? (
          <Banner tone="warn" title="Could not load activity" className="mt-3" action={<Button variant="secondary" className="min-h-10" onClick={activity.refresh}>Try again</Button>}>
            {activity.failureMessage}
          </Banner>
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No transactions found in the recently scanned blocks.</p>
        ) : (
          <ActivityList items={recent} compact owner={address} />
        )}
      </Card>

      <Insights activity={activity} />
    </div>
  )
}

export default function Dashboard() {
  const { status } = useWallet()
  if (status === 'connecting') return <DashboardShell />
  return <ConnectGate allowWrongNetwork>{(address) => <DashboardContent address={address} />}</ConnectGate>
}
