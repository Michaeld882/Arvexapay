import { useSyncExternalStore } from 'react'

/**
 * A small per-wallet record store backed by localStorage, used for CCTP transfers and Gateway operations.
 * Records are what the SDK and chain reported (real hashes, real states); a record that was interrupted can be
 * resumed after a page reload. The JSON codec keeps bigint values the SDK may return.
 */

const BIGINT_TAG = '__bigint__'

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? { [BIGINT_TAG]: item.toString() } : item))
}

function decode<T>(raw: string): T {
  return JSON.parse(raw, (_key, item: unknown) => {
    if (item && typeof item === 'object' && BIGINT_TAG in item) return BigInt((item as Record<string, string>)[BIGINT_TAG])
    return item
  }) as T
}

export interface RecordStore<T extends { id: string; createdAt: number }> {
  read: (owner: string) => T[]
  upsert: (owner: string, record: T) => void
  remove: (owner: string, id: string) => void
  useRecords: (owner: string | undefined) => T[]
}

export function createRecordStore<T extends { id: string; createdAt: number }>(name: string, max = 30): RecordStore<T> {
  const EMPTY: T[] = []
  const cache = new Map<string, T[]>()
  const listeners = new Set<() => void>()
  const keyFor = (owner: string) => `arvexa:circle:${name}:v1:${owner.toLowerCase()}`
  const notify = () => listeners.forEach((listener) => listener())

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== null && !event.key.startsWith(`arvexa:circle:${name}:v1:`)) return
      cache.clear()
      notify()
    })
  }

  const read = (owner: string): T[] => {
    const id = owner.toLowerCase()
    const hit = cache.get(id)
    if (hit) return hit
    let parsed: T[] = EMPTY
    try {
      const raw = window.localStorage.getItem(keyFor(owner))
      if (raw) {
        const data = decode<unknown>(raw)
        if (Array.isArray(data)) parsed = data as T[]
      }
    } catch {
      parsed = EMPTY
    }
    cache.set(id, parsed)
    return parsed
  }

  const write = (owner: string, next: T[]) => {
    cache.set(owner.toLowerCase(), next)
    try {
      window.localStorage.setItem(keyFor(owner), encode(next))
    } catch {
      // storage unavailable: records stay in memory for this session
    }
    notify()
  }

  const upsert = (owner: string, record: T) => {
    const others = read(owner).filter((existing) => existing.id !== record.id)
    write(owner, [record, ...others].sort((a, b) => b.createdAt - a.createdAt).slice(0, max))
  }

  const remove = (owner: string, id: string) => write(owner, read(owner).filter((existing) => existing.id !== id))

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const useRecords = (owner: string | undefined): T[] =>
    useSyncExternalStore(
      subscribe,
      () => (owner ? read(owner) : EMPTY),
      () => EMPTY,
    )

  return { read, upsert, remove, useRecords }
}

/**
 * A lock that lives at module level, not in a component. Only one signed Circle operation can run at a time, even if
 * the user leaves the page and comes back while it is still running, so one transfer can never be started twice.
 */
export function createExclusive() {
  let active: string | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const notify = () => listeners.forEach((listener) => listener())
  return {
    tryAcquire(id: string): boolean {
      if (active !== undefined) return false
      active = id
      notify()
      return true
    },
    release(id: string): void {
      if (active !== id) return
      active = undefined
      notify()
    },
    current: (): string | undefined => active,
    useActive: (): string | undefined => useSyncExternalStore(subscribe, () => active, () => undefined),
  }
}
