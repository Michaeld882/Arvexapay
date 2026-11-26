import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { preloadPage } from '@/lib/pages'

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

interface HistoryState {
  arvexaDepth?: number
  arvexaScroll?: number
}

const currentState = (): HistoryState => (window.history.state as HistoryState | null) ?? {}
const fullPath = (): string => `${window.location.pathname}${window.location.search}`

/** How many in-app pages sit behind this one. 0 means the app was opened directly on this page. */
function historyDepth(): number {
  const depth = currentState().arvexaDepth
  return typeof depth === 'number' ? depth : 0
}

/** Remembers how far this screen was scrolled, so coming back to it lands in the same place. */
function rememberScroll(): void {
  try {
    window.history.replaceState({ ...currentState(), arvexaScroll: window.scrollY }, '')
  } catch {
    // history can be locked in some embeds; scroll memory is a nicety
  }
}

function restoreScroll(): void {
  const top = currentState().arvexaScroll
  if (typeof top !== 'number') return
  // The screen may still be filling in, so try again shortly.
  for (const delay of [0, 80, 250]) setTimeout(() => window.scrollTo({ top }), delay)
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', restoreScroll)
}

/**
 * Moves to another screen without reloading. The same screen opened again does not add a history entry, so the
 * Back button and the device back button never step through duplicates.
 */
export function navigate(to: string): void {
  preloadPage(to)
  if (to === fullPath()) return
  rememberScroll()
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

/**
 * A page opened directly (a bookmark, a shared link, a refresh) has nothing behind it, so the device back button
 * would leave the app. Put the Dashboard behind it once, so Back goes there first. Public payment links are left alone.
 */
export function ensureBackStack(): void {
  const here = fullPath()
  if (window.location.pathname === '/' || window.location.pathname === '/pay' || historyDepth() > 0) return
  window.history.replaceState({ arvexaDepth: 0 }, '', '/')
  window.history.pushState({ arvexaDepth: 1 }, '', here)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  children: ReactNode
}

export function Link({ to, children, onClick, onPointerEnter, onPointerDown, onFocus, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(to)
  }
  return (
    <a
      href={to}
      onClick={handle}
      // Start downloading the screen as soon as a finger or pointer shows interest, before the tap completes.
      onPointerEnter={(event) => {
        preloadPage(to)
        onPointerEnter?.(event)
      }}
      onPointerDown={(event) => {
        preloadPage(to)
        onPointerDown?.(event)
      }}
      onFocus={(event) => {
        preloadPage(to)
        onFocus?.(event)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
