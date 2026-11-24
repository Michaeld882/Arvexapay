import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type PointerEvent, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Check, ChevronLeft, Copy, ExternalLink, Info, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { explorerAddressUrl, explorerTxUrl } from '@/chain'
import { goBack } from '@/lib/router'

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cx('surface card-in rounded-3xl p-5 sm:p-6', className)} {...rest} />
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover hover:text-accent-ink',
  secondary: 'bg-surface-muted text-ink border border-line hover:border-line-strong',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-muted',
  danger: 'bg-danger text-accent-ink hover:opacity-90',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  loading?: boolean
}

/** Spawns a short ripple at the touch or click point. Skipped when the user prefers reduced motion. */
function spawnRipple(event: PointerEvent<HTMLButtonElement>) {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const button = event.currentTarget
  const rect = button.getBoundingClientRect()
  const size = Math.max(rect.width, rect.height) * 2.4
  const ripple = document.createElement('span')
  ripple.className = 'ripple'
  ripple.style.width = ripple.style.height = `${size}px`
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true })
  button.appendChild(ripple)
}

function releasePress(event: PointerEvent<HTMLButtonElement>) {
  delete event.currentTarget.dataset.pressed
}

export function Button({ variant = 'primary', loading, className, children, disabled, type = 'button', onPointerDown, ...rest }: ButtonProps) {
  const inactive = disabled || loading
  return (
    <button
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      onPointerDown={(event) => {
        if (!inactive) {
          spawnRipple(event)
          event.currentTarget.dataset.pressed = 'true'
        }
        onPointerDown?.(event)
      }}
      onPointerUp={releasePress}
      onPointerLeave={releasePress}
      onPointerCancel={releasePress}
      className={cx(
        'ripple-host inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-[transform,background-color,color,border-color,opacity,box-shadow] duration-200 ease-out active:scale-[0.96] data-[pressed=true]:scale-[0.96]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        (variant === 'primary' || variant === 'danger') && 'btn-glow',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

type Tone = 'info' | 'warn' | 'danger' | 'success'

const TONES: Record<Tone, { icon: typeof Info; color: string }> = {
  info: { icon: Info, color: 'var(--accent-hover)' },
  warn: { icon: AlertTriangle, color: 'var(--warn)' },
  danger: { icon: XCircle, color: 'var(--danger)' },
  success: { icon: CheckCircle2, color: 'var(--success)' },
}

interface BannerProps {
  tone?: Tone
  title?: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}

export function Banner({ tone = 'info', title, children, action, className }: BannerProps) {
  const { icon: Icon, color } = TONES[tone]
  return (
    <div
      role={tone === 'danger' || tone === 'warn' ? 'alert' : 'status'}
      className={cx('flex items-start gap-3 rounded-2xl border p-3.5 text-sm', className)}
      style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 9%, transparent)` }}
    >
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children && <div className="text-ink-2 [overflow-wrap:anywhere]">{children}</div>}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse skeleton rounded-lg', className)} />
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className)} aria-hidden />
}

export function BackButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="Go back"
      className={cx(
        '-ml-2 mb-2 inline-flex min-h-11 items-center gap-1 rounded-xl pl-1.5 pr-3 text-sm font-semibold text-ink-2 transition-colors duration-200 hover:bg-surface-muted hover:text-ink',
        className,
      )}
    >
      <ChevronLeft className="size-5" aria-hidden />
      Back
    </button>
  )
}

/** Header for every secondary page. It always includes a Back control. */
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-5">
      <BackButton />
      <h1 className="display text-2xl font-semibold text-ink sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-1 max-w-prose text-sm text-muted">{subtitle}</p>}
    </header>
  )
}

export function ExplorerLink({ hash, address, label = 'View on Arc Explorer' }: { hash?: string; address?: string; label?: string }) {
  const href = hash ? explorerTxUrl(hash) : address ? explorerAddressUrl(address) : undefined
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-semibold text-accent-hover underline-offset-2 hover:underline"
    >
      {label}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  )
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const onCopy = useCallback(async () => {
    const ok = await copyText(value)
    if (!ok) {
      toast.error('Copy failed. Select the text and copy it manually.')
      return
    }
    toast.success('Copied to clipboard')
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1800)
  }, [value])

  return (
    <>
      <Button variant="secondary" onClick={() => void onCopy()} className={className} title={value}>
        {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {copied ? 'Copied' : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}
