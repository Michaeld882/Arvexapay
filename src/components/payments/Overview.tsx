import { ArrowDownLeft, ArrowUpRight, CheckCheck, Clock, Hash } from 'lucide-react'
import { MODULES, ModuleIcon, StatusBadge, type ModuleId } from '@/components/payments/kit'
import { Banner, Button, Card, Skeleton, cx } from '@/components/ui'
import { formatUsdcDisplay } from '@/lib/format'
import { categoryTotals, type LedgerEntry, type Overview } from '@/lib/payments/ledger'
import { DUE_COLOR, dueLabel, dueState, localDate, payReminderPath, upcoming, useReminders } from '@/lib/payments/reminders'
import { statusOf, type PaymentRequest } from '@/lib/payments/requests'
import { Link, navigate } from '@/lib/router'
import type { TxMeta } from '@/lib/txMeta'
import { useNow } from '@/hooks/useNow'
import type { usePaymentsData } from '@/hooks/usePayments'

type Data = ReturnType<typeof usePaymentsData>

function Stat({ label, value, sub, color, icon: Icon }: { label: string; value: string; sub: string; color: string; icon: typeof Hash }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface-muted p-3" style={{ boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 30%, transparent)` }}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        <Icon className="size-3.5 shrink-0" style={{ color }} aria-hidden />
        <span className="truncate">{label}</span>
      </p>
      <p className="display mt-1.5 truncate text-lg font-semibold tabular-nums sm:text-xl" title={value}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted">{sub}</p>
    </div>
  )
}

/** Totals from real, verified payments and your open requests. Every figure says what it counts. */
export function OverviewStats({ overview, loading, unavailable = false }: { overview: Overview; loading: boolean; unavailable?: boolean }) {
  if (loading)
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-busy>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-[88px] w-full" />
        ))}
      </div>
    )
  if (unavailable)
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Totals unavailable">
        {['Total received', 'Total sent', 'Pending', 'Completed', 'Payments'].map((label) => (
          <div key={label} className="rounded-2xl border border-line bg-surface-muted p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{label}</p>
            <p className="display mt-1.5 text-lg font-semibold text-subtle">—</p>
            <p className="mt-0.5 text-[11px] text-muted">unavailable</p>
          </div>
        ))}
      </div>
    )
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Stat label="Total received" value={formatUsdcDisplay(overview.received)} sub="USDC verified in" color="#2cf5a6" icon={ArrowDownLeft} />
      <Stat label="Total sent" value={formatUsdcDisplay(overview.sent)} sub="USDC verified out" color="#22d3ee" icon={ArrowUpRight} />
      <Stat label="Pending" value={String(overview.pendingCount)} sub={`${formatUsdcDisplay(overview.pendingAmount)} USDC awaited`} color="#f59e0b" icon={Clock} />
      <Stat label="Completed" value={String(overview.completedCount)} sub="requests paid" color="#a855f7" icon={CheckCheck} />
      <Stat label="Payments" value={String(overview.paymentCount)} sub="sent and received" color="#4f8cff" icon={Hash} />
    </div>
  )
}

const KIND_MODULE: Record<PaymentRequest['kind'], ModuleId> = { request: 'request', link: 'link', invoice: 'invoice', split: 'split' }

/** Open requests, links, invoices and split shares that are still waiting for a payment. */
export function PendingList({ requests, nowSeconds, limit = 5 }: { requests: readonly PaymentRequest[]; nowSeconds: number; limit?: number }) {
  const open = requests.filter((request) => statusOf(request, nowSeconds) === 'pending').slice(0, limit)
  if (open.length === 0) return <p className="py-4 text-center text-sm text-muted">Nothing is waiting to be paid.</p>
  return (
    <ul className="space-y-2">
      {open.map((request) => {
        const module = MODULES[KIND_MODULE[request.kind]]
        return (
          <li key={request.id}>
            <Link to={request.kind === 'split' ? MODULES.split.path : module.path} className="pay-tile flex items-center gap-3 rounded-2xl border border-line bg-surface-muted/60 p-3">
              <ModuleIcon module={module} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{request.kind === 'invoice' ? `${request.invoiceNo ?? 'Invoice'} · ${request.customer ?? ''}` : request.description || 'Payment request'}</span>
                <span className="block text-xs text-muted">{module.title}</span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="text-sm font-semibold tabular-nums">{formatUsdcDisplay(BigInt(request.amount))}</span>
                <StatusBadge status="pending" />
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/** Reminders that are overdue, due today or due within two weeks. Paying always goes through the Send review. */
export function UpcomingCard({ owner }: { owner: string }) {
  const reminders = useReminders(owner)
  const today = localDate(new Date(useNow(60_000)))
  const due = upcoming(reminders, today)
  if (due.length === 0) return null
  return (
    <Card className="rise space-y-3" style={{ ['--d' as string]: '0ms' }}>
      <div className="flex items-center justify-between">
        <h2 className="display text-lg font-semibold">Upcoming payments</h2>
        <Link to={MODULES.reminders.path} className="text-xs font-semibold text-accent-hover hover:underline">
          Manage
        </Link>
      </div>
      <ul className="space-y-2">
        {due.slice(0, 4).map((reminder) => {
          const state = dueState(reminder, today)
          const color = DUE_COLOR[state.state]
          return (
            <li key={reminder.id} className="flex items-center gap-3 rounded-2xl border border-line bg-surface-muted/60 p-3">
              <ModuleIcon module={MODULES.reminders} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{reminder.name}</span>
                <span className="block text-xs" style={{ color }}>
                  {dueLabel(state)}
                </span>
              </span>
              {reminder.amount && <span className="text-sm font-semibold tabular-nums">{formatUsdcDisplay(BigInt(reminder.amount))}</span>}
              <Button className="min-h-9 px-3 text-xs" disabled={!reminder.to} onClick={() => navigate(payReminderPath(reminder))}>
                Pay
              </Button>
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-muted">Reminders never send money. Paying opens the review screen and asks your wallet to confirm.</p>
    </Card>
  )
}

/** Spending and income by the categories you set. */
export function CategoryBreakdown({ ledger, metas, requests }: { ledger: readonly LedgerEntry[]; metas: Record<string, TxMeta>; requests: readonly PaymentRequest[] }) {
  const totals = categoryTotals(ledger, metas, requests)
  const categorized = totals.filter((row) => row.category !== 'Uncategorized')
  if (categorized.length === 0) return <p className="py-3 text-sm text-muted">Label payments with a category (in Activity, or when you send) to see where your USDC goes.</p>
  const max = totals.reduce((top, row) => (row.sent + row.received > top ? row.sent + row.received : top), 0n)
  return (
    <ul className="space-y-2.5" aria-label="Payments by category">
      {totals.map((row) => {
        const total = row.sent + row.received
        const width = max === 0n ? 0 : Math.max(4, Number((total * 100n) / max))
        return (
          <li key={row.category}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-semibold text-ink-2">
                {row.category} <span className="font-normal text-muted">· {row.count}</span>
              </span>
              <span className="tabular-nums text-muted">
                {row.received > 0n && <span className="text-success">+{formatUsdcDisplay(row.received)} </span>}
                {row.sent > 0n && <span>-{formatUsdcDisplay(row.sent)}</span>}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-line">
              <div className={cx('h-full rounded-full transition-[width] duration-700', row.category === 'Uncategorized' && 'opacity-40')} style={{ width: `${width}%`, background: 'linear-gradient(90deg, #2cf5a6, #22d3ee, #4f8cff)' }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function DataError({ data }: { data: Data }) {
  if (!data.activity.failed || data.ledger.length > 0) return null
  return (
    <Banner tone="warn" title="Could not load payments" action={<Button variant="secondary" className="min-h-10" onClick={data.activity.refresh}>Try again</Button>}>
      {data.activity.failureMessage} No figures are shown rather than guessing.
    </Banner>
  )
}
