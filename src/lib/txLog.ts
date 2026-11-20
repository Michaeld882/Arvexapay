import { useSyncExternalStore } from 'react'
import type { Address, Hex } from 'viem'

/**
 * Records of transactions THIS app submitted from the browser (real hashes only).
 * They let Activity show pending and failed transactions, which leave no onchain logs.
 */

export type LocalTxKind = 'send' | 'withdraw' | 'deposit' | 'approve' | 'swap'
export type LocalTxStatus = 'pending' | 'success' | 'failed' | 'unverified'

export interface LocalTx {
  hash: Hex
  kind: LocalTxKind
  /** Raw 6-decimal USDC amount as a decimal string. */
  amount: string
  to?: Address
  status: LocalTxStatus
  createdAt: number
}

const MAX_RECORDS = 50
const EMPTY: LocalTx[] = []
const cache = new Map<string, LocalTx[]>()
const listeners = new Set<() => void>()

const storageKey = (address: string) => `arvexa:txs:v1:${address.toLowerCase()}`

// Another browser tab can add records (a send started there). Drop the cache so this tab shows them.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && !event.key.startsWith('arvexa:txs:v1:')) return
    cache.clear()
    listeners.forEach((listener) => listener())
  })
}

export function readLocalTxs(address: string): LocalTx[] {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached
  let parsed: LocalTx[] = EMPTY
  try {
    const raw = window.localStorage.getItem(storageKey(address))
    if (raw) {
      const data: unknown = JSON.parse(raw)
      if (Array.isArray(data)) parsed = data as LocalTx[]
    }
  } catch {
    parsed = EMPTY
  }
  cache.set(key, parsed)
  return parsed
}

export function upsertLocalTx(address: string, tx: LocalTx): void {
  const others = readLocalTxs(address).filter((existing) => existing.hash !== tx.hash)
  const next = [tx, ...others].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS)
  cache.set(address.toLowerCase(), next)
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(next))
  } catch {
    // storage unavailable: records stay in memory for this session
  }
  listeners.forEach((listener) => listener())
}

export function updateLocalTxStatus(address: string, hash: Hex, status: LocalTxStatus): void {
  const existing = readLocalTxs(address).find((tx) => tx.hash === hash)
  if (existing) upsertLocalTx(address, { ...existing, status })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLocalTxs(address: string | undefined): LocalTx[] {
  return useSyncExternalStore(
    subscribe,
    () => (address ? readLocalTxs(address) : EMPTY),
    () => EMPTY,
  )
}
