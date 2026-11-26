import { useSyncExternalStore } from 'react'

/**
 * A small localStorage store kept per wallet address, shared across components and browser tabs.
 * It stores only what the caller gives it: saved names, notes, categories. Never keys or seed phrases.
 */
export function createOwnerStore<T>(prefix: string, empty: T, sanitize: (raw: unknown) => T) {
  const cache = new Map<string, T>()
  const listeners = new Set<() => void>()
  const storageKey = (owner: string) => `${prefix}:${owner.toLowerCase()}`
  const notify = () => listeners.forEach((listener) => listener())

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== null && !event.key.startsWith(`${prefix}:`)) return
      cache.clear()
      notify()
    })
  }

  function read(owner: string): T {
    const key = owner.toLowerCase()
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let value = empty
    try {
      const raw = window.localStorage.getItem(storageKey(owner))
      if (raw) value = sanitize(JSON.parse(raw))
    } catch {
      value = empty
    }
    cache.set(key, value)
    return value
  }

  /** Returns false when the browser refused to save (storage full or blocked); the value then lives in memory only. */
  function write(owner: string, value: T): boolean {
    cache.set(owner.toLowerCase(), value)
    let saved = true
    try {
      window.localStorage.setItem(storageKey(owner), JSON.stringify(value))
    } catch {
      saved = false
    }
    notify()
    return saved
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function useOwner(owner: string | undefined): T {
    return useSyncExternalStore(
      subscribe,
      () => (owner ? read(owner) : empty),
      () => empty,
    )
  }

  return { read, write, useOwner }
}
