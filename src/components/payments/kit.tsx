import { useEffect, useId, useState, type ReactNode } from 'react'
import { BarChart3, BookUser, CalendarClock, FileText, Globe, HandCoins, Link2, ReceiptText, RefreshCw, Share2, Store, Users, UsersRound, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { BackButton, Banner, Button, CopyButton, cx } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { classifyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { STATUS_LABEL, type RequestStatus } from '@/lib/payments/requests'
import { getShareBase } from '@/lib/share'

export type ModuleId = 'split' | 'link' | 'invoice' | 'request' | 'merchant' | 'receipts' | 'customers' | 'reminders' | 'contacts' | 'insights' | 'x402'

export interface PayModule {
  id: ModuleId
  title: string
  tagline: string
  path: string
  icon: LucideIcon
  from: string
  to: string
}

/** Each payment tool has its own colour pair and icon, so they are easy to tell apart. */
export const MODULES: Record<ModuleId, PayModule> = {
  split: { id: 'split', title: 'Split Payment', tagline: 'Share a bill and see who has paid', path: '/payments/split', icon: Users, from: '#a855f7', to: '#e879f9' },
  link: { id: 'link', title: 'Payment Links', tagline: 'A link anyone can open and pay', path: '/payments/links', icon: Link2, from: '#22d3ee', to: '#4f8cff' },
  invoice: { id: 'invoice', title: 'Invoices', tagline: 'Bill customers and track payment', path: '/payments/invoices', icon: FileText, from: '#4f8cff', to: '#a855f7' },
  request: { id: 'request', title: 'Payment Requests', tagline: 'Ask for USDC and track the reply', path: '/payments/requests', icon: HandCoins, from: '#2cf5a6', to: '#22d3ee' },
  merchant: { id: 'merchant', title: 'PayHub', tagline: 'Show a QR and accept USDC', path: '/payments/merchant', icon: Store, from: '#2cf5a6', to: '#4f8cff' },
  receipts: { id: 'receipts', title: 'Receipts', tagline: 'Verified proof of every payment', path: '/payments/receipts', icon: ReceiptText, from: '#22d3ee', to: '#a855f7' },
  customers: { id: 'customers', title: 'Customers', tagline: 'Payments grouped by wallet', path: '/payments/customers', icon: UsersRound, from: '#e879f9', to: '#4f8cff' },
  reminders: { id: 'reminders', title: 'Reminders', tagline: 'Recurring payments, never automatic', path: '/payments/reminders', icon: CalendarClock, from: '#4f8cff', to: '#22d3ee' },
  contacts: { id: 'contacts', title: 'Contacts', tagline: 'Saved addresses for fast sending', path: '/payments/contacts', icon: BookUser, from: '#2cf5a6', to: '#a855f7' },
  x402: { id: 'x402', title: 'API Payments', tagline: 'Pay a web API with x402', path: '/payments/x402', icon: Globe, from: '#22d3ee', to: '#2cf5a6' },
  insights: { id: 'insights', title: 'Insights', tagline: 'Real totals and trends', path: '/payments', icon: BarChart3, from: '#a855f7', to: '#22d3ee' },
}

/** The coloured chip with an animated icon that gives each module its look. */
export function ModuleIcon({ module, size = 'md' }: { module: PayModule; size?: 'md' | 'lg' }) {
  const Icon = module.icon
  return (
    <span
      aria-hidden
      className={cx('pay-icon relative flex shrink-0 items-center justify-center rounded-2xl text-white', size === 'lg' ? 'size-14' : 'size-11')}
      style={{ background: `linear-gradient(135deg, ${module.from}, ${module.to})`, boxShadow: `0 8px 24px -8px ${module.from}` }}
    >
      <Icon className={cx('pay-icon-glyph', size === 'lg' ? 'size-7' : 'size-5')} />
    </span>
  )
}

/** The top of a module page: its icon, name and what it is for, with a glowing coloured edge. */
export function ModuleHero({ module, children }: { module: PayModule; children?: ReactNode }) {
  return (
    <header className="mb-5">
      <BackButton />
      <div className="rise rounded-3xl p-px" style={{ background: `linear-gradient(135deg, ${module.from}, transparent 55%, ${module.to})` }}>
        <div className="flex items-center gap-4 rounded-[calc(1.5rem-1px)] bg-surface-strong p-4 sm:p-5">
          <ModuleIcon module={module} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="display text-xl font-semibold tracking-tight sm:text-2xl">{module.title}</h1>
            <p className="text-sm text-muted">{module.tagline}</p>
          </div>
          {children}
        </div>
      </div>
    </header>
  )
}

const STATUS_COLOR: Record<RequestStatus, string> = { pending: 'var(--warn)', paid: 'var(--success)', expired: 'var(--muted)', cancelled: 'var(--muted)' }

export function StatusBadge({ status }: { status: RequestStatus }) {
  const color = STATUS_COLOR[status]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      {status === 'pending' && <span aria-hidden className="pulse-dot size-1.5 rounded-full" style={{ background: color }} />}
      {STATUS_LABEL[status]}
    </span>
  )
}

export const inputClass =
  'min-h-12 w-full rounded-2xl border border-line bg-surface-muted px-4 text-sm text-ink outline-none transition-colors placeholder:text-subtle focus:border-line-strong disabled:opacity-60'

export function Field({ label, hint, error, children, optional }: { label: string; hint?: string; error?: string | null; children: (props: { id: string; invalid: boolean }) => ReactNode; optional?: boolean }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-semibold text-ink-2">
        {label} {optional && <span className="font-normal text-muted">(optional)</span>}
      </label>
      {children({ id, invalid: Boolean(error) })}
      {error ? (
        <p role="alert" className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-[11px] text-muted">{hint}</p>
      )}
    </div>
  )
}

/** The base address links are built on (the app's own address; correct inside a preview too). */
export function useShareBase(): string | undefined {
  const [base, setBase] = useState<string>()
  useEffect(() => {
    let live = true
    void getShareBase().then((value) => live && setBase(value))
    return () => {
      live = false
    }
  }, [])
  return base
}

/** Shares through the device's share sheet when there is one, and copies otherwise. */
export async function shareOrCopy(payload: { title: string; text: string; url?: string }): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share(payload)
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
  }
  const ok = await copyText(payload.url ? `${payload.text}\n${payload.url}` : payload.text)
  if (ok) toast.success('Copied. Paste it in any chat.')
  else toast.error('Copy failed. Select the text and copy it manually.')
}

export function ShareRow({ url, title, text }: { url: string | undefined; title: string; text: string }) {
  const [busy, setBusy] = useState(false)
  if (!url) return <p className="text-xs text-muted">Preparing link…</p>
  return (
    <div className="space-y-2">
      <p className="mono rounded-2xl border border-line bg-surface-muted px-3 py-2 text-[11px] text-ink-2 [overflow-wrap:anywhere]">{url}</p>
      <div className="flex gap-2">
        <CopyButton value={url} label="Copy link" className="min-h-10 flex-1" />
        <Button
          className="min-h-10 flex-1"
          loading={busy}
          onClick={() => {
            setBusy(true)
            void shareOrCopy({ title, text, url }).finally(() => setBusy(false))
          }}
        >
          <Share2 className="size-4" aria-hidden />
          Share
        </Button>
      </div>
    </div>
  )
}

export function Empty({ module, title, children, action }: { module: PayModule; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-9 text-center">
      <ModuleIcon module={module} />
      <p className="display font-semibold">{title}</p>
      <p className="max-w-sm text-sm text-muted">{children}</p>
      {action}
    </div>
  )
}

/** Honest status line for the search for payments on Arc. */
export function SyncStatus({ sync }: { sync: { waiting: boolean; isChecking: boolean; isError: boolean; error: unknown; checkedAt?: number; caughtUp?: boolean; checkNow: () => void } }) {
  if (!sync.waiting) return null
  if (sync.isError)
    return (
      <Banner tone="warn" title="Could not check Arc for payments" action={<Button variant="secondary" className="min-h-10" onClick={sync.checkNow}>Try again</Button>}>
        {classifyError(sync.error).message} Requests stay Pending until a payment is found. This retries by itself.
      </Banner>
    )
  return (
    <p className="flex items-center gap-2 text-xs text-muted" role="status">
      <RefreshCw className={cx('size-3.5', sync.isChecking && 'animate-spin')} aria-hidden />
      {sync.isChecking ? 'Checking Arc for payments…' : sync.checkedAt ? `Checked Arc ${timeAgo(Math.floor(sync.checkedAt / 1000))}${sync.caughtUp === false ? ' (still catching up)' : ''}. Watching for new payments.` : 'Watching for new payments.'}
      {!sync.isChecking && (
        <button type="button" onClick={sync.checkNow} className="font-semibold text-accent-hover hover:underline">
          Check now
        </button>
      )}
    </p>
  )
}

export const shortOwner = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`
