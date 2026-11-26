import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ArrowUpRight, ArrowDownLeft, BadgeCheck, Copy, ShieldCheck, Tag, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { ActivityItem, ActivityKind, ActivityStatus } from '@/lib/activity'
import { copyText } from '@/lib/clipboard'
import { contactFor, useContacts } from '@/lib/contacts'
import { formatTimestamp, formatUsdcDisplay, shortAddress, shortHash, timeAgo } from '@/lib/format'
import { useTxMetas } from '@/lib/txMeta'
import { ExplorerLink, cx } from '@/components/ui'
import { Stepper } from '@/components/TxStepper'
import { useNow } from '@/hooks/useNow'
import { CategoryBadge, TxMetaEditor } from '@/components/TxMetaEditor'

const KIND_META: Record<ActivityKind, { label: string; icon: LucideIcon; sign: '+' | '-' | ''; tint: string }> = {
  send: { label: 'Send', icon: ArrowUpRight, sign: '-', tint: '#22d3ee' },
  receive: { label: 'Receive', icon: ArrowDownLeft, sign: '+', tint: '#2cf5a6' },
  deposit: { label: 'Deposit', icon: ArrowDownToLine, sign: '', tint: '#4f8cff' },
  withdraw: { label: 'Withdraw', icon: ArrowUpFromLine, sign: '', tint: '#a855f7' },
  swap: { label: 'Swap', icon: ArrowLeftRight, sign: '', tint: '#e879f9' },
  approve: { label: 'Approval', icon: ShieldCheck, sign: '', tint: '#94a3b8' },
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

function CopyChip({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void copyText(value).then((ok) => (ok ? toast.success('Copied to clipboard') : toast.error('Copy failed. Select the text and copy it manually.')))}
      className="inline-flex size-7 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
    >
      <Copy className="size-3.5" aria-hidden />
    </button>
  )
}

interface RowProps {
  item: ActivityItem
  compact?: boolean
  index?: number
  /** The connected wallet. Enables saved names for addresses and local notes and categories. */
  owner?: string
  fresh?: boolean
}

export function ActivityRow({ item, compact = false, index = 0, owner, fresh = false }: RowProps) {
  const { label, icon: Icon, sign, tint } = KIND_META[item.kind]
  const toward = item.kind === 'receive' ? 'From' : item.kind === 'deposit' ? 'To vault' : 'To'
  const contacts = useContacts(owner)
  const metas = useTxMetas(owner)
  const meta = metas[item.hash.toLowerCase()]
  const [editing, setEditing] = useState(false)
  const saved = contactFor(contacts, item.counterparty)
  const showCounterparty = item.counterparty && item.kind !== 'deposit'

  return (
    <li
      className={cx('slide-in -mx-2 flex items-start gap-3 rounded-2xl px-2 py-3.5 transition-colors duration-200 hover:bg-accent-soft', fresh && 'flash-in')}
      style={{ ['--d' as string]: `${(index % 8) * 55}ms` }}
    >
      <span
        className="relative z-10 mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl text-ink-2"
        style={{ background: `color-mix(in srgb, ${tint} 14%, var(--surface-muted))`, color: tint, boxShadow: item.status === 'confirmed' ? `0 0 16px -6px ${tint}` : undefined }}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink">{label}</span>
          <span className={cx('text-sm font-semibold tabular-nums', sign === '+' ? 'text-success' : 'text-ink')}>
            {sign}
            {formatUsdcDisplay(item.amount)} {item.token}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span title={item.timestamp ? timeAgo(item.timestamp) : undefined}>{whenLabel(item)}</span>
          <StatusPill status={item.status} />
          {showCounterparty && item.counterparty && (
            <span className="inline-flex items-center gap-0.5">
              <span className="mono" title={item.counterparty}>
                {toward} {saved ? <strong className="font-semibold text-ink-2">{saved.name} </strong> : null}
                {saved ? `(${shortAddress(item.counterparty)})` : shortAddress(item.counterparty)}
              </span>
              {!compact && <CopyChip value={item.counterparty} label="Copy wallet address" />}
            </span>
          )}
        </div>

        {item.status === 'pending' && !compact && (
          <div className="mt-3 max-w-xs">
            <Stepper active={2} />
            <p className="mt-1.5 text-[11px] text-muted">Submitted to Arc. This updates by itself when the network confirms it.</p>
          </div>
        )}

        {(meta?.note || meta?.category) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {meta.category && <CategoryBadge category={meta.category} />}
            {meta.note && <span className="text-xs italic text-ink-2 [overflow-wrap:anywhere]">“{meta.note}”</span>}
          </div>
        )}

        {!compact && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {item.status === 'confirmed' && <BadgeCheck className="size-3.5 text-success" aria-label="Verified onchain" />}
            <span className="mono text-[11px] text-subtle" title={item.hash}>
              {shortHash(item.hash)}
            </span>
            <CopyChip value={item.hash} label="Copy transaction hash" />
            <ExplorerLink hash={item.hash} label="Explorer" />
            {owner && !editing && (
              <button type="button" onClick={() => setEditing(true)} className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-accent-hover hover:bg-surface-muted">
                <Tag className="size-3" aria-hidden />
                {meta ? 'Edit label' : 'Add label'}
              </button>
            )}
          </div>
        )}
        {editing && owner && <TxMetaEditor owner={owner} hash={item.hash} initial={meta} onClose={() => setEditing(false)} />}
      </div>
    </li>
  )
}

function dayLabel(timestamp: number | undefined, now: Date): string {
  if (timestamp === undefined) return 'Recent'
  const date = new Date(timestamp * 1000)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

const NONE: ReadonlySet<string> = new Set()

/**
 * Newly arrived items (above everything already shown) get a brief highlight. The first load and
 * "load older" never flash, because those items are not new.
 */
function useFreshIds(items: readonly ActivityItem[]): ReadonlySet<string> {
  const [track, setTrack] = useState<{ seen: ReadonlySet<string>; fresh: ReadonlySet<string> } | null>(null)
  if (items.length > 0) {
    const ids = items.map((item) => item.id)
    if (track === null) {
      setTrack({ seen: new Set(ids), fresh: NONE })
    } else if (ids.some((id) => !track.seen.has(id))) {
      const firstSeen = items.findIndex((item) => track.seen.has(item.id))
      const arrived = firstSeen > 0 ? items.slice(0, firstSeen).filter((item) => !track.seen.has(item.id)).map((item) => item.id) : []
      setTrack({ seen: new Set(ids), fresh: new Set([...track.fresh, ...arrived]) })
    }
  }
  return track?.fresh ?? NONE
}

export function ActivityList({ items, compact = false, owner }: { items: readonly ActivityItem[]; compact?: boolean; owner?: string }) {
  const fresh = useFreshIds(items)
  const nowMs = useNow(60_000)
  const groups = useMemo(() => {
    if (compact) return [{ label: '', rows: items.map((item, index) => ({ item, index })) }]
    const now = new Date(nowMs)
    const out: Array<{ label: string; rows: Array<{ item: ActivityItem; index: number }> }> = []
    items.forEach((item, index) => {
      const label = dayLabel(item.timestamp, now)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push({ item, index })
      else out.push({ label, rows: [{ item, index }] })
    })
    return out
  }, [items, compact, nowMs])

  if (compact) {
    return (
      <ul className="divide-y divide-line">
        {items.map((item, index) => (
          <ActivityRow key={item.id} item={item} compact index={index} owner={owner} fresh={fresh.has(item.id)} />
        ))}
      </ul>
    )
  }
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{group.label}</h3>
          <ul className="timeline relative divide-y divide-line">
            {group.rows.map(({ item, index }) => (
              <ActivityRow key={item.id} item={item} index={index} owner={owner} fresh={fresh.has(item.id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
