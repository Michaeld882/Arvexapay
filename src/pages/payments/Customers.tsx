import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { Empty, MODULES, ModuleHero, StatusBadge } from '@/components/payments/kit'
import { Banner, Button, Card, CopyButton, Skeleton, ExplorerLink } from '@/components/ui'
import { usePaymentsData } from '@/hooks/usePayments'
import { contactFor, useContacts } from '@/lib/contacts'
import { classifyError } from '@/lib/errors'
import { formatTimestamp, formatUsdcDisplay, shortAddress, timeAgo } from '@/lib/format'
import { groupCustomers } from '@/lib/payments/ledger'
import { statusOf } from '@/lib/payments/requests'

const TINTS = ['#2cf5a6', '#22d3ee', '#4f8cff', '#a855f7', '#e879f9']

function CustomersContent({ owner }: { owner: Address }) {
  const { ledger, requests, activity, nowSeconds } = usePaymentsData(owner)
  const contacts = useContacts(owner)
  const groups = groupCustomers(ledger, requests)

  return (
    <div className="space-y-5">
      <ModuleHero module={MODULES.customers} />
      <Card className="!p-4 sm:!p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="display text-lg font-semibold">Payers and payees</h2>
          <span className="text-xs text-muted">Grouped on this device</span>
        </div>
        {activity.isLoading && groups.length === 0 ? (
          <div className="space-y-3" aria-busy>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : activity.isError && groups.length === 0 ? (
          <Banner tone="danger" title="Could not load payments" action={<Button variant="secondary" className="min-h-10" onClick={activity.refresh}>Try again</Button>}>
            {classifyError(activity.error).message}
          </Banner>
        ) : groups.length === 0 ? (
          <Empty module={MODULES.customers} title="No customers yet">
            When the same wallet pays you or you pay it, its payments are grouped here with the total and the last payment.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {groups.map((group) => {
              const saved = contactFor(contacts, group.address)
              const tint = TINTS[parseInt(group.address.slice(2, 6), 16) % TINTS.length]
              return (
                <li key={group.address} className="slide-in rounded-2xl border border-line bg-surface-muted/60 p-4">
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold" style={{ color: tint, background: `color-mix(in srgb, ${tint} 16%, transparent)` }}>
                      {(saved?.name ?? group.address.slice(2, 3)).charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{saved?.name ?? shortAddress(group.address, 8, 6)}</p>
                      <p className="mono truncate text-[11px] text-muted" title={group.address}>{group.address}</p>
                    </div>
                    <CopyButton value={group.address} label="Copy" className="min-h-9 px-3 text-xs" />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                    {[
                      ['Payments', String(group.count)],
                      ['Received', formatUsdcDisplay(group.received)],
                      ['Sent', formatUsdcDisplay(group.sent)],
                      ['Last payment', group.lastTimestamp ? timeAgo(group.lastTimestamp) : '—'],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl border border-line bg-surface p-2">
                        <dt className="text-[11px] text-muted">{label}</dt>
                        <dd className="display text-sm font-semibold tabular-nums" title={label === 'Last payment' && group.lastTimestamp ? formatTimestamp(group.lastTimestamp) : undefined}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {group.related.length > 0 && (
                    <ul className="mt-3 space-y-1.5" aria-label="Related requests">
                      {group.related.map((request) => (
                        <li key={request.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-xs">
                          <span className="min-w-0 truncate">{request.invoiceNo ? `${request.invoiceNo} · ` : ''}{request.description || 'Payment request'}</span>
                          <span className="flex shrink-0 items-center gap-2">
                            <StatusBadge status={statusOf(request, nowSeconds)} />
                            {request.paid && <ExplorerLink hash={request.paid.hash} label="Tx" />}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {activity.hasMore && groups.length > 0 && (
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

export default function Customers() {
  return <ConnectGate allowWrongNetwork>{(address) => <CustomersContent owner={address} />}</ConnectGate>
}
