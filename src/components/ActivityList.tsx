import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ArrowUpRight, ArrowDownLeft, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { ActivityItem, ActivityKind, ActivityStatus } from '@/lib/activity'
import { formatTimestamp, formatUsdcDisplay, shortAddress, shortHash } from '@/lib/format'
import { ExplorerLink, cx } from '@/components/ui'

const KIND_META: Record<ActivityKind, { label: string; icon: LucideIcon; sign: '+' | '-' | '' }> = {
  send: { label: 'Send', icon: ArrowUpRight, sign: '-' },
  receive: { label: 'Receive', icon: ArrowDownLeft, sign: '+' },
  deposit: { label: 'Deposit', icon: ArrowDownToLine, sign: '' },
  withdraw: { label: 'Withdraw', icon: ArrowUpFromLine, sign: '' },
  swap: { label: 'Swap', icon: ArrowLeftRight, sign: '' },
  approve: { label: 'Approval', icon: ShieldCheck, sign: '' },
}

const STATUS_META: Record<ActivityStatus, { label: string; color: string }> = {
  confirmed: { label: 'Confirmed', color: 'var(--success)' },
  pending: { label: 'Pending', color: 'var(--warn)' },
  failed: { label: 'Failed', color: 'var(--danger)' },
  unverified: { label: 'Unverified', color: 'var(--warn)' },
}

export const kindLabel = (kind: ActivityKind): string => KIND_META[kind].label

function StatusPill({ status }: { status: ActivityStatus }) {
  const { label, color } = STATUS_META[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {status === 'pending' && <span aria-hidden className="pulse-dot size-1.5 rounded-full" style={{ background: color }} />}
      {label}
    </span>
  )
}

function whenLabel(item: ActivityItem): string {
  if (item.timestamp) return formatTimestamp(item.timestamp)
  if (item.blockNumber !== undefined) return `Block ${item.blockNumber.toString()}`
  return 'Just now'
}

export function ActivityRow({ item, compact = false, index = 0 }: { item: ActivityItem; compact?: boolean; index?: number }) {
  const { label, icon: Icon, sign } = KIND_META[item.kind]
  const toward = item.kind === 'receive' ? 'From' : item.kind === 'deposit' ? 'To vault' : 'To'
  return (
    <li
      className="slide-in -mx-2 flex items-start gap-3 rounded-2xl px-2 py-3.5 transition-colors duration-200 hover:bg-accent-soft"
      style={{ ['--d' as string]: `${(index % 8) * 55}ms` }}
    >
      <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-ink-2">
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink">{label}</span>
          <span
            className={cx('text-sm font-semibold tabular-nums', sign === '+' ? 'text-success' : 'text-ink')}
          >
            {sign}
            {formatUsdcDisplay(item.amount)} {item.token}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>{whenLabel(item)}</span>
          <StatusPill status={item.status} />
          {item.counterparty && item.kind !== 'deposit' && (
            <span className="mono">
              {toward} {shortAddress(item.counterparty)}
            </span>
          )}
        </div>
        {!compact && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="mono text-[11px] text-subtle" title={item.hash}>
              {shortHash(item.hash)}
            </span>
            <ExplorerLink hash={item.hash} label="Explorer" />
          </div>
        )}
      </div>
    </li>
  )
}

export function ActivityList({ items, compact = false }: { items: readonly ActivityItem[]; compact?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((item, index) => (
        <ActivityRow key={item.id} item={item} compact={compact} index={index} />
      ))}
    </ul>
  )
}
