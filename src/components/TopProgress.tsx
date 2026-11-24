import { useIsFetching } from '@tanstack/react-query'

/**
 * A thin green bar along the bottom of the header while onchain data is loading.
 * It fades in after a short delay, so quick reads never flash it.
 */
export function TopProgress() {
  const fetching = useIsFetching() > 0
  if (!fetching) return null
  return (
    <div
      aria-hidden
      className="fade-in pointer-events-none absolute inset-x-0 bottom-[-1px] h-0.5 overflow-hidden"
      style={{ ['--d' as string]: '220ms' }}
    >
      <div className="progress-bar h-full w-2/5 rounded-full bg-accent" />
    </div>
  )
}
