import type { ActivityItem } from '@/lib/activity'

export interface TrendBucket {
  /** Unix seconds. */
  start: number
  end: number
  sent: bigint
  received: bigint
}

export interface Insights {
  /** Confirmed USDC sent to other addresses (vault deposits and withdrawals are your own funds and are not counted). */
  sent: bigint
  received: bigint
  sentCount: number
  receivedCount: number
  /** Every confirmed transaction found, whatever its type. Approvals are not counted. */
  count: number
  lastTimestamp?: number
  trend: TrendBucket[]
}

/**
 * Totals and a sent/received trend computed only from confirmed transactions that were actually found onchain.
 * Pending, failed and unverified transactions never count. The trend covers the time from the oldest confirmed
 * transfer found up to now, in equal steps, so it never invents days that were not scanned.
 */
export function computeInsights(items: readonly ActivityItem[], nowSeconds: number, bucketCount = 7): Insights {
  const confirmed = items.filter((item) => item.status === 'confirmed' && item.kind !== 'approve')
  let sent = 0n
  let received = 0n
  let sentCount = 0
  let receivedCount = 0
  let lastTimestamp: number | undefined
  for (const item of confirmed) {
    if (item.kind === 'send') {
      sent += item.amount
      sentCount += 1
    } else if (item.kind === 'receive') {
      received += item.amount
      receivedCount += 1
    }
    if (item.timestamp !== undefined && (lastTimestamp === undefined || item.timestamp > lastTimestamp)) lastTimestamp = item.timestamp
  }

  const timed = confirmed.filter((item) => (item.kind === 'send' || item.kind === 'receive') && item.timestamp !== undefined)
  let trend: TrendBucket[] = []
  if (timed.length >= 2) {
    const start = Math.min(...timed.map((item) => item.timestamp as number))
    const width = Math.max(60, Math.ceil((Math.max(nowSeconds, start + 1) - start + 1) / bucketCount))
    trend = Array.from({ length: bucketCount }, (_, index) => ({
      start: start + index * width,
      end: start + (index + 1) * width,
      sent: 0n,
      received: 0n,
    }))
    for (const item of timed) {
      const index = Math.min(bucketCount - 1, Math.floor(((item.timestamp as number) - start) / width))
      if (item.kind === 'send') trend[index].sent += item.amount
      else trend[index].received += item.amount
    }
  }
  return { sent, received, sentCount, receivedCount, count: confirmed.length, lastTimestamp, trend }
}
