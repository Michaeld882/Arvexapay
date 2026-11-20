import { formatUsdc } from '@/onchain-money'

export const shortAddress = (address: string, head = 6, tail = 4): string =>
  address.length <= head + tail + 2 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`

export const shortHash = (hash: string): string => shortAddress(hash, 8, 6)

/**
 * USDC for display: truncated (never rounded up), at least 2 and at most 6 decimals,
 * with thousands separators. Raw is in 6-decimal ERC-20 base units. maxDecimals truncates further
 * (used for the large hero amount); the exact value is always shown elsewhere.
 */
export function formatUsdcDisplay(raw: bigint, maxDecimals = 6): string {
  const negative = raw < 0n
  const [int, frac = ''] = formatUsdc(negative ? -raw : raw).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const trimmed = frac.slice(0, Math.max(2, maxDecimals)).replace(/0+$/, '')
  const decimals = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed
  return `${negative ? '-' : ''}${grouped}.${decimals}`
}

export function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function timeAgo(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - seconds)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86_400)}d ago`
}
