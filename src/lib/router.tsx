import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

const NAVIGATE_EVENT = 'arvexa:navigate'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE_EVENT, onChange)
  }
}

const getSnapshot = (): string => {
  const path = window.location.pathname.replace(/\/+$/, '')
  return path === '' ? '/' : path
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => '/')
}

/** How many in-app pages sit behind this one. 0 means the app was opened directly on this page. */
function historyDepth(): number {
  const state = window.history.state as { arvexaDepth?: number } | null
  return typeof state?.arvexaDepth === 'number' ? state.arvexaDepth : 0
}

export function navigate(to: string): void {
  if (to === getSnapshot()) return
  window.history.pushState({ arvexaDepth: historyDepth() + 1 }, '', to)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
  window.scrollTo({ top: 0 })
}

/**
 * Returns to the previous in-app screen. When the page was opened directly (no previous
 * in-app screen), it goes to the Dashboard instead of leaving the app.
 */
export function goBack(): void {
  if (historyDepth() > 0) window.history.back()
  else navigate('/')
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  children: ReactNode
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
