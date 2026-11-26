import type { Hex } from 'viem'
import type { Expectation } from '@/guardian/expect'

/**
 * The universal transaction lock and the submission registry.
 *
 * Lock: one wallet request per account at a time, and never the same transaction twice, across every screen. It is
 * taken synchronously, before any await, so a double click or a re-render cannot start a second submission.
 *
 * Registry: a small record, kept in this browser, of each transaction the app handed to a wallet. It holds real
 * hashes only. After a reload it stops the app from creating the same transaction again while the first is still in
 * flight, and it is the list the recovery code reads.
 */

export interface TxLock {
  tryAcquire(owner: string, fingerprint: string): { ok: true; release: () => void } | { ok: false; reason: 'busy' | 'duplicate' }
  isHeld(owner: string): boolean
  /** Drops every held lock. For tests and for a full sign-out; a normal flow releases its own lock. */
  reset(): void
}

export function createTxLock(): TxLock {
  const byOwner = new Map<string, string>()
  return {
    tryAcquire(owner, fingerprint) {
      const key = owner.toLowerCase()
      const held = byOwner.get(key)
      if (held !== undefined) return { ok: false, reason: held === fingerprint ? 'duplicate' : 'busy' }
      byOwner.set(key, fingerprint)
      let released = false
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          if (byOwner.get(key) === fingerprint) byOwner.delete(key)
        },
      }
    },
    isHeld: (owner) => byOwner.has(owner.toLowerCase()),
    reset: () => byOwner.clear(),
  }
}

/** The one lock used by every guarded flow. */
export const txLock: TxLock = createTxLock()

/**
 * CONFIRMED  the chain confirmed the transaction (a successful receipt). Nothing more is claimed.
 * VERIFIED   the expected result (amount, recipient, events) was found in the receipt or at the destination.
 * UNVERIFIED the transaction confirmed, but the expected result was NOT found in it.
 */
export type SubmissionState = 'SIGNING' | 'SUBMITTED' | 'PENDING' | 'CONFIRMED' | 'VERIFIED' | 'UNVERIFIED' | 'FAILED'

export interface Submission {
  id: string
  fingerprint: string
  kind: string
  title: string
  state: SubmissionState
  /** Set only once the wallet returned a real hash. */
  hash?: Hex
  /** What the receipt must contain for this to count as VERIFIED, kept so a reload can check it without the old screen. */
  expect?: Expectation[]
  createdAt: number
  updatedAt: number
}

const MAX_RECORDS = 30
/** A wallet prompt that was never answered is forgotten after this long. */
export const SIGNING_WINDOW_MS = 2 * 60_000
/** A submitted transaction blocks an identical one for this long unless the chain shows it finished. */
export const IN_FLIGHT_WINDOW_MS = 30 * 60_000

const storageKey = (owner: string) => `arvexa:guardian:v1:${owner.toLowerCase()}`

export function readSubmissions(owner: string): Submission[] {
  try {
    const raw = window.localStorage.getItem(storageKey(owner))
    const data: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(data) ? (data as Submission[]).filter((item) => typeof item?.id === 'string' && typeof item.fingerprint === 'string') : []
  } catch {
    return []
  }
}

function write(owner: string, items: Submission[]): void {
  try {
    window.localStorage.setItem(storageKey(owner), JSON.stringify(items.slice(0, MAX_RECORDS)))
  } catch {
    // storage unavailable: the in-memory lock still protects this session
  }
}

export function beginSubmission(owner: string, input: { fingerprint: string; kind: string; title: string; id?: string; expect?: Expectation[] }, now = Date.now()): Submission {
  const { id, ...rest } = input
  const item: Submission = { id: id ?? `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ...rest, state: 'SIGNING', createdAt: now, updatedAt: now }
  write(owner, [item, ...readSubmissions(owner)])
  return item
}

export function updateSubmission(owner: string, id: string, patch: Partial<Pick<Submission, 'state' | 'hash'>>, now = Date.now()): void {
  const items = readSubmissions(owner)
  if (!items.some((item) => item.id === id)) return
  write(owner, items.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: now } : item)))
}

/** Forget a submission that never produced a hash (the wallet was rejected, or the request failed before sending). */
export function dropSubmission(owner: string, id: string): void {
  write(owner, readSubmissions(owner).filter((item) => item.id !== id))
}

/** Submissions that may still be in flight: handed to a wallet or submitted, and not yet settled. */
export function inFlight(owner: string, now = Date.now()): Submission[] {
  return readSubmissions(owner).filter((item) => {
    if (item.state === 'SIGNING') return now - item.updatedAt < SIGNING_WINDOW_MS
    if (item.state === 'SUBMITTED' || item.state === 'PENDING') return now - item.updatedAt < IN_FLIGHT_WINDOW_MS
    return false
  })
}

export function findInFlightDuplicate(owner: string, fingerprint: string, now = Date.now()): Submission | undefined {
  return inFlight(owner, now).find((item) => item.fingerprint === fingerprint)
}
