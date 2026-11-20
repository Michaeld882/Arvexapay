import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, QrCode, RefreshCw, Send, type LucideIcon } from 'lucide-react'
import type { Address } from 'viem'
import { NETWORK_LABEL } from '@/chain'
import { ActivityList } from '@/components/ActivityList'
import { ConnectGate } from '@/components/ConnectGate'
import { Banner, Button, Card, CopyButton, Skeleton, cx } from '@/components/ui'
import { VAULT_LABEL } from '@/components/VaultStatus'
import { useActivity } from '@/hooks/useActivity'
import { useBalances } from '@/hooks/useBalances'
import { useVault } from '@/hooks/useVault'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay, shortAddress } from '@/lib/format'
import { Link } from '@/lib/router'

const ACTIONS: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/send', label: 'Send', icon: Send },
  { to: '/receive', label: 'Receive', icon: QrCode },
  { to: '/swap', label: 'Swap', icon: ArrowLeftRight },
  { to: '/deposit', label: 'Deposit', icon: ArrowDownToLine },
  { to: '/withdraw', label: 'Withdraw', icon: ArrowUpFromLine },
]

function Amount({ raw, loading, className }: { raw: bigint | undefined; loading: boolean; className?: string }) {
  if (loading) return <Skeleton className="h-8 w-32" />
  return <span className={className}>{raw === undefined ? '—' : formatUsdcDisplay(raw)}</span>
}

/** The hero shows the exact balance (never a rounded 0.00); longer numbers get a smaller type size. */
function HeroAmount({ raw, loading }: { raw: bigint | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-11 w-48" />
  const text = raw === undefined ? '—' : formatUsdcDisplay(raw)
  const size = text.length <= 10 ? 'text-4xl sm:text-5xl' : text.length <= 14 ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl'
  return (
    <span data-testid="hero-balance" className={cx('display min-w-0 font-semibold tabular-nums text-ink [overflow-wrap:anywhere]', size)}>
      {text}
    </span>
  )
}

function DashboardContent({ address }: { address: Address }) {
  const balances = useBalances(address)
  const { vault } = useVault()
  const activity = useActivity(address)
  const recent = activity.items.slice(0, 5)

  return (
    <div className="space-y-5">
      <Card>
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
          <HeroAmount raw={balances.total} loading={balances.isLoading} />
          <span className="text-lg font-medium text-subtle">USDC</span>
        </div>
        <p className="mt-2 text-xs text-muted">{NETWORK_LABEL}</p>
        {balances.total === 0n && !balances.isError && (
          <p className="mt-3 rounded-2xl bg-surface-muted p-3 text-xs text-ink-2">
            This address holds no USDC on Arc Mainnet. Balances are read from Arc Mainnet only, so USDC on Arc Testnet or another network is not counted here.
          </p>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-surface-muted p-3.5">
            <dt className="text-xs text-muted">Wallet USDC</dt>
            <dd className="mt-1 text-base font-semibold tabular-nums">
              <Amount raw={balances.walletRaw} loading={balances.wallet.isPending} />
            </dd>
          </div>
          <div className="rounded-2xl bg-surface-muted p-3.5">
            <dt className="text-xs text-muted">Arvexa vault</dt>
            <dd className="mt-1 text-base font-semibold tabular-nums">
              {balances.vaultReady ? (
                <Amount raw={balances.vaultRaw} loading={balances.vault.isPending} />
              ) : (
                <span className="text-sm font-medium text-muted">{VAULT_LABEL[vault.state]}</span>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">Network fees are paid in USDC from your wallet balance. There is no separate gas token, so it is not counted twice.</p>
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

      <nav aria-label="Quick actions" className="grid grid-cols-5 gap-2 sm:gap-3">
        {ACTIONS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="surface flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-2xl px-1 text-xs font-semibold text-ink transition-colors hover:border-line-strong"
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>

      <Card>
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
          </div>
        ) : activity.isError ? (
          <Banner tone="warn" title="Could not load activity" className="mt-3" action={<Button variant="secondary" className="min-h-10" onClick={activity.refresh}>Try again</Button>}>
            {classifyError(activity.error).message}
          </Banner>
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No transactions found in the recently scanned blocks.</p>
        ) : (
          <ActivityList items={recent} compact />
        )}
      </Card>
    </div>
  )
}

export default function Dashboard() {
  return <ConnectGate allowWrongNetwork>{(address) => <DashboardContent address={address} />}</ConnectGate>
}
