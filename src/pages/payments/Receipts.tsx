import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { Empty, MODULES, ModuleHero } from '@/components/payments/kit'
import { ReceiptCard } from '@/components/payments/ReceiptCard'
import { Banner, Button, Card, Skeleton, cx } from '@/components/ui'
import { usePaymentsData } from '@/hooks/usePayments'
import { classifyError } from '@/lib/errors'
import { formatTimestamp, formatUsdcDisplay, shortAddress } from '@/lib/format'
import { buildReceipts } from '@/lib/payments/receipts'
import { useLocalTxs } from '@/lib/txLog'

const FILTERS = ['all', 'received', 'sent'] as const

function ReceiptsContent({ owner }: { owner: Address }) {
  const { ledger, requests, metas, activity } = usePaymentsData(owner)
  const localTxs = useLocalTxs(owner)
  const receipts = useMemo(() => buildReceipts(owner, requests, localTxs, metas, ledger), [owner, requests, localTxs, metas, ledger])
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [openHash, setOpenHash] = useState<string | null>(null)
  const visible = filter === 'all' ? receipts : receipts.filter((receipt) => receipt.direction === filter)

  return (
    <div className="space-y-5">
      <ModuleHero module={MODULES.receipts} />
      <Card className="!p-4 sm:!p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="display text-lg font-semibold">Your receipts</h2>
          <div className="flex gap-1.5" role="group" aria-label="Filter receipts">
            {FILTERS.map((id) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('min-h-9 rounded-full border px-3.5 text-xs font-semibold capitalize transition-colors', filter === id ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-muted text-ink-2 hover:border-line-strong')}>
                {id}
              </button>
            ))}
          </div>
        </div>
        {activity.isLoading && receipts.length === 0 ? (
          <div className="space-y-3 py-2" aria-busy>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : activity.isError && receipts.length === 0 ? (
          <Banner tone="danger" title="Could not load payments" action={<Button variant="secondary" className="min-h-10" onClick={activity.refresh}>Try again</Button>}>
            {classifyError(activity.error).message}
          </Banner>
        ) : visible.length === 0 ? (
          <Empty module={MODULES.receipts} title="No receipts yet">
            A receipt is created for every USDC payment that is verified on Arc, sent or received.
          </Empty>
        ) : (
          <ul className="space-y-2.5">
            {visible.map((receipt) => {
              const open = openHash === receipt.hash
              return (
                <li key={receipt.hash}>
                  <button type="button" aria-expanded={open} onClick={() => setOpenHash(open ? null : receipt.hash)} className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface-muted/60 p-3.5 text-left transition-colors hover:border-line-strong">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: receipt.direction === 'received' ? '#2cf5a6' : '#22d3ee' }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{receipt.direction === 'received' ? `From ${shortAddress(receipt.from)}` : `To ${shortAddress(receipt.to)}`}</span>
                      <span className="block truncate text-xs text-muted">{receipt.timestamp ? formatTimestamp(receipt.timestamp) : 'Time not available'}</span>
                    </span>
                    <span className={cx('text-sm font-semibold tabular-nums', receipt.direction === 'received' && 'text-success')}>
                      {receipt.direction === 'received' ? '+' : '-'}
                      {formatUsdcDisplay(receipt.amount)}
                    </span>
                    <ChevronDown className={cx('size-4 shrink-0 text-subtle transition-transform duration-300', open && 'rotate-180')} aria-hidden />
                  </button>
                  {open && (
                    <div className="mt-2">
                      <ReceiptCard receipt={receipt} owner={owner} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {activity.hasMore && (
          <div className="mt-3 text-center">
            <Button variant="secondary" className="min-h-9 text-xs" loading={activity.isFetchingMore} onClick={activity.loadMore}>
              Include older payments
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

export default function Receipts() {
  return <ConnectGate allowWrongNetwork>{(address) => <ReceiptsContent owner={address} />}</ConnectGate>
}
