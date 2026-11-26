import { useEffect, useState } from 'react'

/**
 * A small line under a skeleton that appears only when a section is taking unusually long (Arc busy or limiting
 * requests). The section keeps loading; the hint just offers a retry so the user is never left guessing.
 */
export function SlowHint({ loading, onRetry, after = 6000 }: { loading: boolean; onRetry: () => void; after?: number }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setSlow(true), after)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [loading, after])
  if (!loading || !slow) return null
  return (
    <p role="status" className="fade-in text-xs text-muted">
      Taking longer than usual. Arc may be busy.{' '}
      <button type="button" onClick={onRetry} className="font-semibold text-accent-hover hover:underline">
        Try again
      </button>
    </p>
  )
}
