import { useMemo } from 'react'
import { ArrowDownLeft, ArrowUpRight, Hash } from 'lucide-react'
import type { useActivity } from '@/hooks/useActivity'
import { useNow } from '@/hooks/useNow'
import { formatUsdcDisplay, timeAgo } from '@/lib/format'
import { computeInsights, type TrendBucket } from '@/lib/insights'
import { SlowHint } from '@/components/SlowHint'
import { Banner, Button, Card, Skeleton } from '@/components/ui'

type Activity = ReturnType<typeof useActivity>

function Stat({ label, value, sub, color, icon: Icon }: { label: string; value: string; sub?: string; color: string; icon: typeof Hash }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface-muted p-3" style={{ boxShadow: `inset 0 1px 0 color-mix(in srgb, ${color} 30%, transparent)` }}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        <Icon className="size-3.5 shrink-0" style={{ color }} aria-hidden />
        <span className="truncate">{label}</span>
      </p>
      <p className="display mt-1.5 truncate text-lg font-semibold tabular-nums text-ink sm:text-xl" title={value}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-muted">{sub}</p>}
    </div>
  )
}

/** Two thin bars per time step: sent (cyan) and received (green), scaled to the biggest step. */
export function Trend({ buckets, now }: { buckets: TrendBucket[]; now: number }) {
  const max = buckets.reduce((top, bucket) => (bucket.sent > top ? bucket.sent : bucket.received > top ? bucket.received : top), 0n)
  const height = (value: bigint) => (max === 0n || value === 0n ? 0 : Math.max(6, Number((value * 100n) / max)))
  const summary = buckets.map((bucket) => `${timeAgo(bucket.start, now * 1000)}: sent ${formatUsdcDisplay(bucket.sent)}, received ${formatUsdcDisplay(bucket.received)}`).join('. ')
  return (
    <figure className="mt-4">
      <div className="flex h-24 items-end gap-1.5" role="img" aria-label={`Sent and received trend. ${summary}`}>
        {buckets.map((bucket) => (
          <div key={bucket.start} className="flex h-full min-w-0 flex-1 items-end justify-center gap-[3px]" title={`Sent ${formatUsdcDisplay(bucket.sent)} / received ${formatUsdcDisplay(bucket.received)} USDC`}>
            <span className="w-full max-w-[10px] origin-bottom rounded-t-md transition-[height] duration-500" style={{ height: `${height(bucket.sent)}%`, background: 'linear-gradient(to top, #22d3ee, #4f8cff)', minHeight: bucket.sent > 0n ? 4 : 2, opacity: bucket.sent > 0n ? 1 : 0.18 }} />
            <span className="w-full max-w-[10px] origin-bottom rounded-t-md transition-[height] duration-500" style={{ height: `${height(bucket.received)}%`, background: 'linear-gradient(to top, #2cf5a6, #22d3ee)', minHeight: bucket.received > 0n ? 4 : 2, opacity: bucket.received > 0n ? 1 : 0.18 }} />
          </div>
        ))}
      </div>
      <figcaption className="mt-2 flex items-center justify-between text-[11px] text-muted">
        <span>{timeAgo(buckets[0].start, now * 1000)}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-full bg-[#22d3ee]" />
            Sent
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-full bg-[#2cf5a6]" />
            Received
          </span>
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  )
}

/** Totals and a trend from real, confirmed transactions found onchain. Nothing here is estimated or sample data. */
export function Insights({ activity }: { activity: Activity }) {
  const now = Math.floor(useNow() / 1000)
  const insights = useMemo(() => computeInsights(activity.items, now), [activity.items, now])

  return (
    <Card className="rise lift-lg" style={{ ['--d' as string]: '480ms' }}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="display text-lg font-semibold">Payment insights</h2>
        {insights.lastTimestamp !== undefined && <span className="text-xs text-muted">Last activity {timeAgo(insights.lastTimestamp)}</span>}
      </div>
      {activity.isLoading ? (
        <div className="space-y-3" aria-busy>
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
          <Skeleton className="h-24 w-full" />
          <SlowHint loading onRetry={activity.refresh} />
        </div>
      ) : activity.failed && activity.items.length === 0 ? (
        <Banner tone="warn" title="Could not load insights" action={<Button variant="secondary" className="min-h-10" onClick={activity.refresh}>Try again</Button>}>
          {activity.failureMessage} No figures are shown rather than guessing.
        </Banner>
      ) : insights.count === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No confirmed transactions were found in the scanned blocks yet. Insights appear as you send and receive USDC.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Sent" value={formatUsdcDisplay(insights.sent)} sub={`${insights.sentCount} ${insights.sentCount === 1 ? 'transfer' : 'transfers'}`} color="#22d3ee" icon={ArrowUpRight} />
            <Stat label="Received" value={formatUsdcDisplay(insights.received)} sub={`${insights.receivedCount} ${insights.receivedCount === 1 ? 'transfer' : 'transfers'}`} color="#2cf5a6" icon={ArrowDownLeft} />
            <Stat label="Transactions" value={String(insights.count)} sub="confirmed" color="#a855f7" icon={Hash} />
          </div>
          {insights.trend.length > 0 ? <Trend buckets={insights.trend} now={now} /> : <p className="mt-4 text-xs text-muted">A sent and received trend appears once you have two or more transfers.</p>}
          <p className="mt-3 text-[11px] text-muted">
            USDC, from confirmed transactions in blocks {activity.oldestScannedBlock?.toString() ?? '…'} to {activity.headBlock?.toString() ?? '…'}. Vault top-ups and cash-outs are not counted as sent or received.
          </p>
          {activity.hasMore && (
            <div className="mt-2">
              <Button variant="secondary" className="min-h-9 text-xs" loading={activity.isFetchingMore} onClick={activity.loadMore}>
                Include older activity
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
