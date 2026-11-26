import type { ComponentType } from 'react'

type Loader = () => Promise<{ default: ComponentType }>

/**
 * Every screen, loaded on its own. Opening a screen only waits for its chunk, never for blockchain data.
 * The same loaders feed `lazy()` in App.tsx and the preloading below, so a preloaded screen opens instantly.
 */
export const PAGE_LOADERS: Record<string, Loader> = {
  '/': () => import('@/pages/Dashboard'),
  '/send': () => import('@/pages/Send'),
  '/receive': () => import('@/pages/Receive'),
  '/scan': () => import('@/pages/Scan'),
  '/swap': () => import('@/pages/Swap'),
  '/deposit': () => import('@/pages/Deposit'),
  '/withdraw': () => import('@/pages/Withdraw'),
  '/activity': () => import('@/pages/Activity'),
  '/settings': () => import('@/pages/Settings'),
  '/payments': () => import('@/pages/Payments'),
  '/pay': () => import('@/pages/Pay'),
  '/payments/requests': () => import('@/pages/payments/Requests'),
  '/payments/links': () => import('@/pages/payments/Links'),
  '/payments/invoices': () => import('@/pages/payments/Invoices'),
  '/payments/split': () => import('@/pages/payments/Split'),
  '/payments/merchant': () => import('@/pages/payments/Merchant'),
  '/payments/receipts': () => import('@/pages/payments/Receipts'),
  '/payments/customers': () => import('@/pages/payments/Customers'),
  '/payments/reminders': () => import('@/pages/payments/Reminders'),
  '/payments/contacts': () => import('@/pages/payments/Contacts'),
  '/circle': () => import('@/pages/Circle'),
  '/circle/bridge': () => import('@/pages/CircleBridge'),
  '/circle/gateway': () => import('@/pages/CircleGateway'),
}

const started = new Map<string, Promise<unknown>>()

const pathOf = (target: string): string => {
  const path = target.split(/[?#]/)[0].replace(/\/+$/, '')
  return path === '' ? '/' : path
}

/** Starts loading a screen's code (once). Safe to call as often as you like; it never touches the network for data. */
export function preloadPage(target: string): void {
  const path = pathOf(target)
  const load = PAGE_LOADERS[path]
  if (!load || started.has(path)) return
  started.set(
    path,
    load().catch(() => {
      started.delete(path) // a failed download is retried the next time it is needed
    }),
  )
}

export const isPagePreloaded = (target: string): boolean => started.has(pathOf(target))

let warmed = false

/**
 * Once the app is showing, quietly fetch the code of every other screen when the browser is idle, a few at a time.
 * Screens are small, so later taps open straight away. Only code is fetched here, not blockchain data.
 */
export function warmAllPages(): void {
  if (warmed || typeof window === 'undefined') return
  warmed = true
  const queue = Object.keys(PAGE_LOADERS)
  const idle: (callback: () => void) => void = (callback) => ('requestIdleCallback' in window ? window.requestIdleCallback(callback, { timeout: 2000 }) : void setTimeout(callback, 300))
  const pump = () => {
    for (const path of queue.splice(0, 3)) preloadPage(path)
    if (queue.length > 0) idle(pump)
  }
  idle(pump)
}
