import { BarChart3 } from 'lucide-react'
import type { Address } from 'viem'
import { ActivityList } from '@/components/ActivityList'
import { ConnectGate } from '@/components/ConnectGate'
import { Trend } from '@/components/Insights'
import { MODULES, ModuleIcon, type ModuleId, SyncStatus } from '@/components/payments/kit'
import { CategoryBreakdown, DataError, OverviewStats, PendingList, UpcomingCard } from '@/components/payments/Overview'
import { Card, PageHeader, Skeleton } from '@/components/ui'
import { usePaymentsData } from '@/hooks/usePayments'
import { useContacts } from '@/lib/contacts'
import { formatUsdcDisplay } from '@/lib/format'
import { computeInsights } from '@/lib/insights'
import { ledgerAsActivity } from '@/lib/payments/ledger'
import { useReminders } from '@/lib/payments/reminders'
import { statusOf } from '@/lib/payments/requests'
import { useSplits } from '@/lib/payments/splits'
import { Link } from '@/lib/router'

const HUB: ModuleId[] = ['split', 'link', 'invoice', 'request', 'merchant', 'receipts', 'customers', 'reminders', 'contacts']

function PaymentsContent({ owner }: { owner: Address }) {
  const data = usePaymentsData(owner)
  const splits = useSplits(owner)
  const reminders = useReminders(owner)
  const contacts = useContacts(owner)
  const open = (kind: string) => data.requests.filter((request) => request.kind === kind && statusOf(request, data.nowSeconds) === 'pending').length
  const badge: Partial<Record<ModuleId, string>> = {
    split: splits.length ? `${splits.length} ${splits.length === 1 ? 'bill' : 'bills'}` : undefined,
    link: open('link') ? `${open('link')} open` : undefined,
    invoice: open('invoice') ? `${open('invoice')} open` : undefined,
    request: open('request') ? `${open('request')} open` : undefined,
    reminders: reminders.length ? `${reminders.length} set` : undefined,
    contacts: contacts.length ? `${contacts.length} saved` : undefined,
  }
  const trend = computeInsights(ledgerAsActivity(data.ledger), data.nowSeconds).trend
  const recent = ledgerAsActivity(data.ledger).slice(0, 6)
  const loading = data.activity.isLoading && data.ledger.length === 0

  return (
    <div className="space-y-5">
      <section aria-label="Payment tools" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {HUB.map((id, index) => {
          const module = MODULES[id]
          return (
            <Link key={id} to={module.path} style={{ ['--d' as string]: `${index * 45}ms`, ['--glow' as string]: module.from }} className="pay-tile surface rise relative flex flex-col gap-3 rounded-3xl p-4">
              <div className="flex items-start justify-between gap-2">
                <ModuleIcon module={module} />
                {badge[id] && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-hover">{badge[id]}</span>}
              </div>
              <div>
                <p className="display text-sm font-semibold">{module.title}</p>
                <p className="mt-0.5 text-xs text-muted">{module.tagline}</p>
              </div>
            </Link>
          )
        })}
      </section>

      <Card className="rise space-y-4">
        <div className="flex items-center gap-3">
          <ModuleIcon module={MODULES.insights} />
          <div>
            <h2 className="display text-lg font-semibold">Payment overview</h2>
            <p className="text-xs text-muted">Real USDC payments found on Arc, and your open requests.</p>
          </div>
        </div>
        <DataError data={data} />
        <OverviewStats overview={data.overview} loading={data.activity.isLoading && data.ledger.length === 0} />
        <SyncStatus sync={data.sync} />
      </Card>

      <UpcomingCard owner={owner} />

      <Card className="rise space-y-3">
        <h2 className="display text-lg font-semibold">Pending requests and outstanding invoices</h2>
        <PendingList requests={data.requests} nowSeconds={data.nowSeconds} limit={6} />
        {data.overview.outstandingInvoices > 0 && (
          <p className="text-xs text-muted">
            {data.overview.outstandingInvoices} outstanding {data.overview.outstandingInvoices === 1 ? 'invoice' : 'invoices'} totalling {formatUsdcDisplay(data.overview.outstandingInvoiceAmount)} USDC.
          </p>
        )}
      </Card>

      <Card className="rise">
        <h2 className="display mb-1 text-lg font-semibold">Recent payments</h2>
        {data.activity.isLoading && recent.length === 0 ? (
          <Skeleton className="my-3 h-14 w-full" />
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No verified payments found in the scanned blocks yet.</p>
        ) : (
          <ActivityList items={recent} compact owner={owner} />
        )}
      </Card>

      <Card className="rise">
        <h2 className="display mb-1 flex items-center gap-2 text-lg font-semibold">
          <BarChart3 className="size-5 text-accent-hover" aria-hidden />
          Payment volume
        </h2>
        {loading ? <Skeleton className="my-3 h-24 w-full" /> : trend.length > 0 ? <Trend buckets={trend} now={data.nowSeconds} /> : <p className="py-3 text-sm text-muted">A sent and received trend appears once you have two or more verified payments.</p>}
      </Card>

      <Card className="rise">
        <h2 className="display mb-3 text-lg font-semibold">By category</h2>
        {loading ? <Skeleton className="h-20 w-full" /> : <CategoryBreakdown ledger={data.ledger} metas={data.metas} requests={data.requests} />}
      </Card>
    </div>
  )
}

export default function Payments() {
  return (
    <>
      <PageHeader title="Payments" subtitle="Request, split, invoice and accept USDC, with every payment verified on Arc." />
      <ConnectGate allowWrongNetwork>{(address) => <PaymentsContent owner={address} />}</ConnectGate>
    </>
  )
}
