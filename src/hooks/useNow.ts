import { useEffect, useState } from 'react'

/** The current time in milliseconds, refreshed on an interval, so relative times ("5m ago") stay current without impure calls during render. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
