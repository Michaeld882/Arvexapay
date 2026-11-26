import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Address } from 'viem'
import { ActivityList } from '@/components/ActivityList'
import { ConnectGate } from '@/components/ConnectGate'
import { Banner, Button, Card, PageHeader, Skeleton, cx } from '@/components/ui'
import { useActivity } from '@/hooks/useActivity'
import type { ActivityKind } from '@/lib/activity'
import { classifyError } from '@/lib/errors'

type Filter = 'all' | Exclude<ActivityKind, 'approve'>

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Receive' },
  { id: 'deposit', label: 'Deposit' },
  { id: 'withdraw', label: 'Withdraw' },
  { id: 'swap', label: 'Swap' },
]

function ActivityContent({ address }: { address: Address }) {
  const activity = useActivity(address)
  const [filter, setFilter] = useState<Filter>('all')
  const visible = useMemo(() => (filter === 'all' ? activity.items : activity.items.filter((item) => item.kind === filter)), [activity.items, filter])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter activity">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cx(
                'min-h-9 rounded-full border px-3.5 text-xs font-semibold transition-colors duration-200',
                filter === id ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-muted text-ink-2 hover:border-line-strong',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button variant="secondary" className="min-h-9 px-3" onClick={activity.refresh} disabled={activity.isFetching} aria-label="Refresh activity">
          <RefreshCw className={cx('size-4', activity.isFetching && 'animate-spin')} aria-hidden />
        </Button>
      </div>

      <Card className="!p-4 sm:!p-5">
        {activity.isLoading ? (
          <div className="space-y-3 py-2" aria-busy>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : activity.failed && activity.items.length === 0 ? (
          <Banner tone="danger" title="Could not load activity" action={<Button variant="secondary" className="min-h-10" onClick={activity.refresh}>Try again</Button>}>
            {activity.failureMessage} No history is shown rather than guessing.
          </Banner>
        ) : visible.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted">
            <p className="font-semibold text-ink">{filter === 'all' ? 'No activity found yet' : `No ${filter} activity found`}</p>
            <p className="mt-1">
              {filter === 'swap'
                ? 'Swaps appear here once a swap provider is configured and a swap is completed.'
                : 'Nothing was found in the scanned blocks. Older activity can be loaded below.'}
            </p>
          </div>
        ) : (
          <ActivityList items={visible} owner={address} />
        )}
      </Card>

      {activity.incomplete && (
        <Banner tone="warn" title="Part of the scan did not finish">
          The RPC stopped answering partway through. What was found is shown; use Load older activity to continue.
        </Banner>
      )}
      {activity.isError && activity.items.length > 0 && (
        <Banner tone="warn" title="Some activity could not be loaded">
          {classifyError(activity.error).message}
        </Banner>
      )}

      {activity.hasWindowData && (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-xs text-muted">
            Scanned blocks {activity.oldestScannedBlock?.toString()} to {activity.headBlock?.toString()}. Showing confirmed USDC transfers and Arvexa vault events.
          </p>
          {activity.hasMore ? (
            <Button variant="secondary" loading={activity.isFetchingMore} onClick={activity.loadMore}>
              Load older activity
            </Button>
          ) : (
            <p className="text-xs text-muted">You have reached the start of the chain.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function Activity() {
  return (
    <>
      <PageHeader title="Activity" subtitle="Your wallet timeline, built from real onchain history. Failed or pending transactions appear only if you submitted them from this browser." />
      <ConnectGate allowWrongNetwork>{(address) => <ActivityContent address={address} />}</ConnectGate>
    </>
  )
}
