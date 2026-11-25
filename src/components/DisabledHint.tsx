/** One short line that says why the primary button is disabled. Renders nothing when the button is usable. */
export function DisabledHint({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null
  return (
    <p className="text-center text-xs text-muted" aria-live="polite" data-testid="disabled-reason">
      {reason}
    </p>
  )
}
