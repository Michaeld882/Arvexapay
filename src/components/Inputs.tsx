import { useId } from 'react'
import { USDC } from '@/chain'
import { formatUsdc } from '@/onchain-money'
import { formatUsdcDisplay } from '@/lib/format'
import { cx, Skeleton } from '@/components/ui'

interface AmountInputProps {
  value: string
  onChange: (value: string) => void
  /** Raw 6-decimal balance available for this action. Undefined while unknown. */
  balance?: bigint
  balanceLabel?: string
  balanceLoading?: boolean
  balanceUnavailable?: boolean
  disabled?: boolean
  error?: string | null
}

/** Keeps only digits and one dot, and caps the fraction at the token's decimals. */
export function sanitizeAmount(input: string): string {
  const cleaned = input.replace(/,/g, '.').replace(/[^0-9.]/g, '')
  const [int, ...rest] = cleaned.split('.')
  if (rest.length === 0) return int
  return `${int}.${rest.join('').slice(0, USDC.decimals)}`
}

export function AmountInput({
  value,
  onChange,
  balance,
  balanceLabel = 'Balance',
  balanceLoading,
  balanceUnavailable,
  disabled,
  error,
}: AmountInputProps) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div>
      <div className={cx('rounded-2xl border bg-surface-muted p-4 transition-colors duration-200', error ? 'border-danger' : 'border-line')}>
        <label htmlFor={id} className="sr-only">
          Amount in USDC
        </label>
        <div className="flex items-baseline gap-2">
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onChange(sanitizeAmount(event.target.value))}
            className="display w-full min-w-0 bg-transparent text-4xl font-semibold tabular-nums text-ink outline-none placeholder:text-subtle disabled:opacity-60"
          />
          <span className="text-sm font-semibold text-subtle">USDC</span>
        </div>
        <div className="mt-2 flex min-h-5 items-center justify-between text-xs text-muted">
          {balanceLoading ? (
            <Skeleton className="h-4 w-32" />
          ) : balanceUnavailable || balance === undefined ? (
            <span>{balanceLabel} unavailable</span>
          ) : (
            <span className="tabular-nums">
              {balanceLabel}: {formatUsdcDisplay(balance)} USDC
            </span>
          )}
          <button
            type="button"
            disabled={disabled || balance === undefined || balance === 0n}
            onClick={() => balance !== undefined && onChange(formatUsdc(balance))}
            className="min-h-8 rounded-lg px-2 font-semibold text-accent-hover transition-colors hover:bg-surface disabled:opacity-40"
          >
            Max
          </button>
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

interface RecipientInputProps {
  value: string
  onChange: (value: string) => void
  error?: string | null
  disabled?: boolean
  label?: string
}

export function RecipientInput({ value, onChange, error, disabled, label = 'Recipient address' }: RecipientInputProps) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-semibold text-ink-2">
        {label}
      </label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder="0x…"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value.trim())}
        className={cx(
          'mono min-h-12 w-full rounded-2xl border bg-surface-muted px-3 text-[11px] tracking-tight text-ink sm:px-4 sm:text-sm sm:tracking-normal outline-none transition-colors duration-200 placeholder:text-subtle disabled:opacity-60',
          error ? 'border-danger' : 'border-line focus:border-line-strong',
        )}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
