import { useMemo, useState } from 'react'
import { ChevronDown, QrCode, Trash2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { Empty, Field, MODULES, ModuleHero, ShareRow, StatusBadge, SyncStatus, inputClass, useShareBase, type ModuleId } from '@/components/payments/kit'
import { ReceiptCard } from '@/components/payments/ReceiptCard'
import { sanitizeAmount } from '@/components/Inputs'
import { CategoryBadge, CategoryChips } from '@/components/TxMetaEditor'
import { Banner, Button, Card, ExplorerLink, cx } from '@/components/ui'
import { ConnectGate } from '@/components/ConnectGate'
import { DisabledHint } from '@/components/DisabledHint'
import { usePaymentSync } from '@/hooks/usePayments'
import { useNow } from '@/hooks/useNow'
import { contactFor, useContacts } from '@/lib/contacts'
import { formatTimestamp, formatUsdcDisplay, shortAddress, shortHash, timeAgo } from '@/lib/format'
import { linkForRequest, payLinkPath } from '@/lib/payments/links'
import { buildReceipts } from '@/lib/payments/receipts'
import { useMerchantName } from '@/lib/payments/receipts'
import { cancelRequest, createRequest, removeRequest, reopenRequest, setRequestCategory, statusOf, useRequests, type PaymentRequest, type RequestKind, type RequestStatus } from '@/lib/payments/requests'
import { verifyPaymentByHash } from '@/lib/payments/settle'
import { getArcClient } from '@/lib/rpc'
import { useTxMetas, type Category } from '@/lib/txMeta'
import { checkAmount } from '@/lib/validate'

type EngineKind = Extract<RequestKind, 'request' | 'link' | 'invoice'>

interface Config {
  module: ModuleId
  noun: string
  createLabel: string
  descriptionLabel: string
  descriptionPlaceholder: string
  customer: boolean
  expiryLabel: string
  defaultDays: number
  emptyTitle: string
  emptyBody: string
}

const CONFIG: Record<EngineKind, Config> = {
  request: { module: 'request', noun: 'request', createLabel: 'Create request', descriptionLabel: 'What is it for', descriptionPlaceholder: 'Dinner, rent share…', customer: false, expiryLabel: 'Expires', defaultDays: 7, emptyTitle: 'No payment requests yet', emptyBody: 'Create a request, share it, and it turns Paid by itself when the USDC arrives on Arc.' },
  link: { module: 'link', noun: 'payment link', createLabel: 'Create link', descriptionLabel: 'Payment description', descriptionPlaceholder: 'Logo design, tickets…', customer: false, expiryLabel: 'Link expires', defaultDays: 30, emptyTitle: 'No payment links yet', emptyBody: 'A payment link opens a page where anyone can connect a wallet and pay you in USDC.' },
  invoice: { module: 'invoice', noun: 'invoice', createLabel: 'Create invoice', descriptionLabel: 'Description', descriptionPlaceholder: 'Website work, March…', customer: true, expiryLabel: 'Due within', defaultDays: 30, emptyTitle: 'No invoices yet', emptyBody: 'Create an invoice for a customer. It is marked Paid only after the real USDC payment is found on Arc.' },
}

const EXPIRY = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 0, label: 'Never' },
]

function RequestForm({ owner, kind, onCreated }: { owner: Address; kind: EngineKind; onCreated: (request: PaymentRequest) => void }) {
  const config = CONFIG[kind]
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [customer, setCustomer] = useState('')
  const [reference, setReference] = useState('')
  const [days, setDays] = useState(config.defaultDays)
  const [category, setCategory] = useState<Category | undefined>()
  const [error, setError] = useState<{ field: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const amountCheck = useMemo(() => checkAmount(amount), [amount])

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    setSaving(true)
    let head: bigint | undefined
    try {
      head = await getArcClient().getBlockNumber()
    } catch {
      head = undefined // creating still works; the search then starts from a recent block
    }
    const result = createRequest(owner, kind, { amount, description, reference, customer, expiresInDays: days, category }, head)
    setSaving(false)
    if (!result.ok) {
      setError({ field: result.field, message: result.message })
      return
    }
    setError(null)
    setAmount('')
    setDescription('')
    setCustomer('')
    setReference('')
    setCategory(undefined)
    toast.success(`${config.createLabel.replace('Create ', '')} created`)
    onCreated(result.request)
  }
  const err = (field: string) => (error?.field === field ? error.message : null)

  return (
    <Card>
      <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        {config.customer && (
          <Field label="Customer name" error={err('customer')}>
            {({ id, invalid }) => <input id={id} value={customer} maxLength={40} aria-invalid={invalid} autoComplete="off" placeholder="Acme Studio" onChange={(event) => setCustomer(event.target.value)} className={inputClass} />}
          </Field>
        )}
        <Field label="Amount (USDC)" error={err('amount')}>
          {({ id, invalid }) => <input id={id} inputMode="decimal" value={amount} aria-invalid={invalid} autoComplete="off" placeholder="0.00" onChange={(event) => setAmount(sanitizeAmount(event.target.value))} className={cx(inputClass, 'display text-lg font-semibold tabular-nums')} />}
        </Field>
        <Field label={config.descriptionLabel} error={err('description')} optional={kind === 'request'}>
          {({ id, invalid }) => <input id={id} value={description} maxLength={80} aria-invalid={invalid} autoComplete="off" placeholder={config.descriptionPlaceholder} onChange={(event) => setDescription(event.target.value)} className={inputClass} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference" optional error={err('reference')}>
            {({ id, invalid }) => <input id={id} value={reference} maxLength={40} aria-invalid={invalid} autoComplete="off" placeholder="PO-1042" onChange={(event) => setReference(event.target.value)} className={inputClass} />}
          </Field>
          <Field label={config.expiryLabel} error={err('expiry')}>
            {({ id }) => (
              <select id={id} value={days} onChange={(event) => setDays(Number(event.target.value))} className={inputClass}>
                {EXPIRY.map((option) => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <CategoryChips value={category} onChange={setCategory} />
        <Button type="submit" className="w-full" loading={saving} disabled={!amountCheck.ok}>
          {config.createLabel}
        </Button>
        <DisabledHint reason={amountCheck.ok ? null : amount ? null : 'Enter an amount to create it.'} />
        <p className="text-center text-[11px] text-muted">Saved on this device. It turns Paid only when the USDC payment is found on Arc Mainnet.</p>
      </form>
    </Card>
  )
}

export function VerifyByHash({ owner, request }: { owner: Address; request: PaymentRequest }) {
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setMessage(null)
    const result = await verifyPaymentByHash(owner, request, hash)
    setBusy(false)
    if (result.ok) toast.success('Payment found and verified on Arc')
    else setMessage(result.message)
  }
  return (
    <div className="space-y-2 rounded-2xl border border-line bg-surface-muted p-3">
      <p className="text-xs text-muted">Already paid? Paste the transaction hash and Arc is checked directly.</p>
      <div className="flex gap-2">
        <input value={hash} onChange={(event) => setHash(event.target.value.trim())} aria-label="Transaction hash" placeholder="0x…" spellCheck={false} className={cx(inputClass, 'mono min-h-11 text-xs')} />
        <Button variant="secondary" className="min-h-11" loading={busy} disabled={hash === ''} onClick={() => void run()}>
          Verify
        </Button>
      </div>
      {message && (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      )}
    </div>
  )
}

function RequestCard({ owner, request, now, open, onToggle }: { owner: Address; request: PaymentRequest; now: number; open: boolean; onToggle: () => void }) {
  const status = statusOf(request, now)
  const module = MODULES[request.kind === 'split' ? 'split' : (request.kind)]
  const base = useShareBase()
  const merchant = useMerchantName(owner)
  const contacts = useContacts(owner)
  const metas = useTxMetas(owner)
  const [qr, setQr] = useState(false)
  const [showReceipt, setShowReceipt] = useState(false)
  const url = base ? `${base}${payLinkPath(linkForRequest(request, merchant))}` : undefined
  const amount = BigInt(request.amount)
  const title = request.kind === 'invoice' ? `${request.invoiceNo ?? 'Invoice'} · ${request.customer ?? ''}` : request.description || 'Payment request'
  const receipt = request.paid ? buildReceipts(owner, [request], [], metas)[0] : undefined
  const payer = request.paid ? contactFor(contacts, request.paid.from) : undefined

  return (
    <li className="rounded-2xl border border-line bg-surface-muted/60 transition-colors hover:border-line-strong">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 p-3.5 text-left">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: `linear-gradient(135deg, ${module.from}, ${module.to})` }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{title}</span>
          <span className="block truncate text-xs text-muted">
            {request.kind === 'invoice' && request.description ? `${request.description} · ` : ''}
            {status === 'paid' && request.paid?.timestamp ? `Paid ${timeAgo(request.paid.timestamp)}` : request.expiresAt ? `${status === 'expired' ? 'Expired' : 'Expires'} ${formatTimestamp(request.expiresAt)}` : `Created ${timeAgo(request.createdAt)}`}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums">{formatUsdcDisplay(amount)} USDC</span>
          <StatusBadge status={status} />
        </span>
        <ChevronDown className={cx('size-4 shrink-0 text-subtle transition-transform duration-300', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className="space-y-3 border-t border-line p-3.5">
          {request.category && <CategoryBadge category={request.category} />}
          {request.reference && <p className="text-xs text-muted">Reference: {request.reference}</p>}

          {status === 'paid' && request.paid && (
            <div className="space-y-2 rounded-2xl p-3" style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)' }}>
              <p className="text-sm font-semibold text-success">Paid and verified on Arc</p>
              <p className="text-xs text-ink-2">
                From <span className="mono">{payer ? `${payer.name} · ` : ''}{shortAddress(request.paid.from)}</span>
                {request.paid.timestamp ? ` · ${formatTimestamp(request.paid.timestamp)}` : ''}
              </p>
              <p className="flex flex-wrap items-center gap-3 text-xs">
                <span className="mono" title={request.paid.hash}>{shortHash(request.paid.hash)}</span>
                <ExplorerLink hash={request.paid.hash} label="Explorer" />
              </p>
              <Button variant="secondary" className="min-h-10" onClick={() => setShowReceipt((value) => !value)} aria-expanded={showReceipt}>
                {showReceipt ? 'Hide receipt' : 'View receipt'}
              </Button>
              {showReceipt && receipt && <ReceiptCard receipt={receipt} owner={owner} />}
            </div>
          )}

          {(status === 'pending' || status === 'expired') && (
            <>
              {status === 'pending' && (
                <>
                  <ShareRow url={url} title={`Payment request: ${title}`} text={`${merchant ?? 'Pay me'}: ${formatUsdcDisplay(amount)} USDC${request.description ? ` for ${request.description}` : ''}`} />
                  <Button variant="secondary" className="min-h-10" onClick={() => setQr((value) => !value)} aria-expanded={qr}>
                    <QrCode className="size-4" aria-hidden />
                    {qr ? 'Hide QR code' : 'Show QR code'}
                  </Button>
                  {qr && url && (
                    <div className="mx-auto w-fit rounded-2xl bg-white p-3">
                      <QRCodeSVG value={url} size={176} level="M" bgColor="#ffffff" fgColor="#0c2118" title="Payment QR code" />
                    </div>
                  )}
                </>
              )}
              {status === 'expired' && <Banner tone="warn">This one expired. A payment found before it expired still settles it. You can reopen it for another 7 days.</Banner>}
              <VerifyByHash owner={owner} request={request} />
            </>
          )}

          <div className="flex flex-wrap gap-2">
            {status === 'pending' && (
              <Button variant="secondary" className="min-h-10" onClick={() => cancelRequest(owner, request.id)}>
                Cancel {request.kind === 'invoice' ? 'invoice' : 'request'}
              </Button>
            )}
            {(status === 'expired' || status === 'cancelled') && (
              <Button variant="secondary" className="min-h-10" onClick={() => reopenRequest(owner, request.id)}>
                Reopen
              </Button>
            )}
            {status !== 'paid' && (
              <Button variant="secondary" className="min-h-10 text-danger" onClick={() => removeRequest(owner, request.id)}>
                <Trash2 className="size-4" aria-hidden />
                Delete
              </Button>
            )}
          </div>
          {status !== 'paid' && <CategoryChips value={request.category} onChange={(next) => setRequestCategory(owner, request.id, next)} />}
        </div>
      )}
    </li>
  )
}

const FILTERS: ReadonlyArray<{ id: 'all' | RequestStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'paid', label: 'Paid' },
  { id: 'expired', label: 'Expired' },
]

function EngineContent({ owner, kind }: { owner: Address; kind: EngineKind }) {
  const config = CONFIG[kind]
  const module = MODULES[config.module]
  const requests = useRequests(owner)
  const sync = usePaymentSync(owner)
  const now = Math.floor(useNow(30_000) / 1000)
  const [filter, setFilter] = useState<'all' | RequestStatus>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const mine = useMemo(() => requests.filter((request) => request.kind === kind), [requests, kind])
  const visible = filter === 'all' ? mine : mine.filter((request) => statusOf(request, now) === filter)
  const count = (status: RequestStatus) => mine.filter((request) => statusOf(request, now) === status).length
  const pendingTotal = mine.filter((request) => statusOf(request, now) === 'pending').reduce((sum, request) => sum + BigInt(request.amount), 0n)

  return (
    <div className="space-y-5">
      <ModuleHero module={module}>
        {mine.length > 0 && (
          <div className="hidden text-right sm:block">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted">Waiting</p>
            <p className="display text-lg font-semibold tabular-nums">{formatUsdcDisplay(pendingTotal)}</p>
          </div>
        )}
      </ModuleHero>
      <RequestForm owner={owner} kind={kind} onCreated={(request) => setOpenId(request.id)} />
      <SyncStatus sync={sync} />
      <Card className="!p-4 sm:!p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="display text-lg font-semibold">Your {kind === 'link' ? 'payment links' : `${config.noun}s`}</h2>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {FILTERS.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('min-h-9 rounded-full border px-3 text-xs font-semibold transition-colors', filter === id ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-muted text-ink-2 hover:border-line-strong')}>
                {label}
                {id !== 'all' && mine.length > 0 ? ` ${count(id)}` : ''}
              </button>
            ))}
          </div>
        </div>
        {mine.length === 0 ? (
          <Empty module={module} title={config.emptyTitle}>
            {config.emptyBody}
          </Empty>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nothing {filter} yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {visible.map((request) => (
              <RequestCard key={request.id} owner={owner} request={request} now={now} open={openId === request.id} onToggle={() => setOpenId((current) => (current === request.id ? null : request.id))} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/** One screen engine for payment requests, payment links and invoices. */
export function RequestsPage({ kind }: { kind: EngineKind }) {
  return <ConnectGate allowWrongNetwork>{(address) => <EngineContent owner={address} kind={kind} />}</ConnectGate>
}

