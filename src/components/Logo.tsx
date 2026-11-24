import { useId } from 'react'
import { cx } from '@/components/ui'

/**
 * The Arvexa mark: a rounded tile with a white arch (the "A" and the "arc" in one shape)
 * holding a coin. The green gradient is the same in light and dark themes so it reads on both.
 */
export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  const id = useId()
  const tile = `${id}-tile`
  const shine = `${id}-shine`
  return (
    <svg
      role="img"
      aria-label="Arvexa"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={cx('shrink-0', className)}
    >
      <defs>
        <linearGradient id={tile} x1="6" y1="2" x2="42" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3fd39a" />
          <stop offset="1" stopColor="#0b4a34" />
        </linearGradient>
        <linearGradient id={shine} x1="24" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill={`url(#${tile})`} />
      <rect width="48" height="24" rx="13" fill={`url(#${shine})`} />
      <path d="M13.5 35V25a10.5 10.5 0 0 1 21 0v10" fill="none" stroke="#ffffff" strokeWidth="4.6" strokeLinecap="round" />
      <circle cx="24" cy="29.5" r="3.6" fill="#c4f7de" />
    </svg>
  )
}

interface LogoProps {
  size?: number
  /** Tailwind classes for the wordmark, so callers can hide it on narrow screens. */
  wordmarkClassName?: string
  className?: string
}

export function Logo({ size = 36, wordmarkClassName, className }: LogoProps) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      <span aria-hidden className={cx('display text-lg font-semibold tracking-[-0.02em] text-ink', wordmarkClassName)}>
        Arvexa
      </span>
    </span>
  )
}
