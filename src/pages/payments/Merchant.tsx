import { useEffect, useState } from 'react'
import { BadgeCheck, Maximize2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { ActivityList } from '@/components/ActivityList'
import { Empty, Field, MODULES, ModuleHero, SyncStatus, inputClass, useShareBase } from '@/components/payments/kit'
import { ReceiptCard } from '@/components/payments/ReceiptCard'
import { sanitizeAmount } from '@/components/Inputs'
import { Banner, Button, Card, CopyButton, Skeleton } from '@/components/ui'
import { useNow } from '@/hooks/useNow'
import { usePaymentsData } from '@/hooks/usePayments'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { ledgerAsActivity } from '@/lib/payments/ledger'
import { linkForRequest, payLinkPath } from '@/lib/payments/links'
import { buildReceipts, saveMerchantName, useMerchantName } from '@/lib/payments/receipts'
import { createRequest, statusOf, useRequests } from '@/lib/payments/requests'
import { getArcClient } from '@/lib/rpc'
import { checkAmount } from '@/lib/validate'

/** Full-screen view for the customer: a big QR, the amount, and a live "payment received" once Arc shows the USDC. */
function CustomerDisplay({ owner, requestId, link, name, onClose }: { owner: Address; requestId: string; link: string; name?: string; onClose: () => void }) {
  const requests = useRequests(owner)
  const { sync, metas } = usePaymentsData(owner)
  const now = Math.floor(useNow(15_000) / 1000)
  const request = requests.find((candidate) => candidate.id === requestId)
  const paid = request?.paid
  // While a customer is waiting, look for the payment every 5 seconds (reading only).
  useEffect(() => {
    if (paid) return
    const timer = setInterval(sync.checkNow, 5000)
    return () => clearInterval(timer)
  }, [paid, sync.checkNow])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const receipt = request?.paid ? buildReceipts(owner, [request], [], metas)[0] : undefined
  const status = request ? statusOf(request, now) : 'cancelled'

  return (
    <div role="dialog" aria-modal="true" aria-label="Customer payment screen" className="fixed inset-0 z-50 overflow-y-auto bg-bg p-4">
      <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-5 py-6 text-center">
        <button type="button" onClick={onClose} aria-label="Close customer screen" className="absolute right-4 top-4 inline-flex size-11 items-center justify-center rounded-2xl border border-line bg-surface-muted">
          <X className="size-5" aria-hidden />
        </button>
        {paid && receipt ? (
          <>
            <span className="status-pop flex size-16 items-center justify-center rounded-full text-success" style={{ background: 'color-mix(in srgb, var(--success) 16%, transparent)' }}>
              <BadgeCheck className="size-9" aria-hidden />
            </span>
            <h2 className="display text-2xl font-semibold">Payment received</h2>
            <p className="text-sm text-muted">Verified on Arc Mainnet.</p>
            <div className="w-full text-left">
              <ReceiptCard receipt={receipt} owner={owner} />
            </div>
            <Button className="w-full" onClick={onClose}>
              New sale
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold uppercase tracking-[0.1em] text-muted">{name ?? 'Pay with USDC'}</p>
            {request && (
              <p className="display text-5xl font-semibold tabular-nums">
                {formatUsdcDisplay(BigInt(request.amount))} <span className="text-xl text-subtle">USDC</span>
              </p>
            )}
            <div className="rounded-3xl bg-white p-4 shadow-[0_0_60px_-10px_var(--accent)]">
              <QRCodeSVG value={link} size={248} level="M" bgColor="#ffffff" fgColor="#0c2118" title="Payment QR code" />
            </div>
            <p className="text-sm text-muted">Scan with Arvexa or any camera, then confirm in your wallet.</p>
            <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
              <span aria-hidden className="pulse-dot size-2 rounded-full bg-warn" />
              {status === 'expired' ? 'This sale expired' : 'Waiting for the payment on Arc…'}
            </p>
            <Button variant="secondary" onClick={onClose}>
              Cancel sale
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function MerchantContent({ owner }: { owner: Address }) {
  const base = useShareBase()
  const name = useMerchantName(owner)
  const [nameInput, setNameInput] = useState(name ?? '')
  const [amount, setAmount] = useState('')
  const [what, setWhat] = useState('')
  const [display, setDisplay] = useState<{ requestId: string; link: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const data = usePaymentsData(owner)
  const amountCheck = checkAmount(amount)
  const openLink = base ? `${base}${payLinkPath({ to: owner, name })}` : undefined
  const incoming = data.ledger.filter((entry) => entry.direction === 'in')

  const accept = async () => {
    if (!amountCheck.ok || !base) return
    setStarting(true)
    let head: bigint | undefined
    try {
      head = await getArcClient().getBlockNumber()
    } catch {
      head = undefined
    }
    const created = createRequest(owner, 'request', { amount, description: what || 'Sale', expiresInDays: 1 }, head)
    setStarting(false)
    if (!created.ok) return toast.error(created.message)
    setDisplay({ requestId: created.request.id, link: `${base}${payLinkPath(linkForRequest(created.request, name))}` })
    setAmount('')
    setWhat('')
  }

  return (
    <div className="space-y-5">
      <ModuleHero module={MODULES.merchant} />

      <Card className="space-y-4 text-center">
        <Field label="Store or business name" optional>
          {({ id }) => (
            <div className="flex gap-2">
              <input id={id} value={nameInput} maxLength={40} autoComplete="off" placeholder="Corner Coffee" onChange={(event) => setNameInput(event.target.value)} className={inputClass} />
              <Button variant="secondary" className="min-h-12" disabled={nameInput.trim() === (name ?? '')} onClick={() => { saveMerchantName(owner, nameInput); toast.success('Name saved') }}>
                Save
              </Button>
            </div>
          )}
        </Field>
        <div>
          <p className="display text-lg font-semibold">{name ?? 'Your payment QR'}</p>
          <p className="text-xs text-muted">Customers scan this and choose the amount, or use Accept USDC below for a fixed amount.</p>
        </div>
        <div className="mx-auto w-fit rounded-3xl bg-white p-4 shadow-[0_0_50px_-12px_var(--accent)]">
          {openLink ? <QRCodeSVG value={openLink} size={208} level="M" bgColor="#ffffff" fgColor="#0c2118" title="Merchant payment QR code" /> : <Skeleton className="size-[208px]" />}
        </div>
        <p className="mono rounded-2xl border border-line bg-surface-muted px-4 py-3 text-xs [overflow-wrap:anywhere]">{owner}</p>
        <div className="flex gap-2">
          <CopyButton value={owner} label="Copy address" className="min-h-10 flex-1" />
          {openLink && <CopyButton value={openLink} label="Copy pay link" className="min-h-10 flex-1" />}
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="display text-lg font-semibold">Accept USDC</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (USDC)" error={amount && !amountCheck.ok ? amountCheck.message : null}>
            {({ id, invalid }) => <input id={id} inputMode="decimal" value={amount} aria-invalid={invalid} autoComplete="off" placeholder="0.00" onChange={(event) => setAmount(sanitizeAmount(event.target.value))} className={`${inputClass} display text-lg font-semibold tabular-nums`} />}
          </Field>
          <Field label="For" optional>
            {({ id }) => <input id={id} value={what} maxLength={80} autoComplete="off" placeholder="Coffee and cake" onChange={(event) => setWhat(event.target.value)} className={inputClass} />}
          </Field>
        </div>
        <Button className="w-full" loading={starting} disabled={!amountCheck.ok || !base} onClick={() => void accept()}>
          <Maximize2 className="size-4" aria-hidden />
          Accept USDC
        </Button>
        <p className="text-center text-[11px] text-muted">Shows a full-screen QR for the customer. It says "Payment received" only after the USDC arrives on Arc.</p>
      </Card>

      <SyncStatus sync={data.sync} />

      <Card className="!p-4 sm:!p-5">
        <h2 className="display mb-1 text-lg font-semibold">Recent verified payments</h2>
        {data.activity.isLoading ? (
          <div className="space-y-3 py-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : data.activity.isError && incoming.length === 0 ? (
          <Banner tone="warn" title="Could not load payments" className="mt-3" action={<Button variant="secondary" className="min-h-10" onClick={data.activity.refresh}>Try again</Button>}>
            {classifyError(data.activity.error).message}
          </Banner>
        ) : incoming.length === 0 ? (
          <Empty module={MODULES.merchant} title="No payments received yet">
            Verified USDC payments to this wallet appear here as they arrive.
          </Empty>
        ) : (
          <ActivityList items={ledgerAsActivity(incoming).slice(0, 5)} compact owner={owner} />
        )}
      </Card>

      {display && <CustomerDisplay owner={owner} requestId={display.requestId} link={display.link} name={name} onClose={() => setDisplay(null)} />}
    </div>
  )
}

export default function Merchant() {
  return <ConnectGate allowWrongNetwork>{(address) => <MerchantContent owner={address} />}</ConnectGate>
}
