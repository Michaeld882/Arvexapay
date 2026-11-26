import { createOwnerStore } from '@/lib/ownerStore'

/**
 * Notes and categories you attach to transactions. They live only in this browser, keyed by the real transaction hash.
 * Nothing here is written to the blockchain, and a note never changes the transaction that is sent.
 */
export const CATEGORIES = ['Food', 'Bills', 'Shopping', 'Business', 'Friends', 'Travel', 'Other'] as const
export type Category = (typeof CATEGORIES)[number]

export const NOTE_MAX = 80
export const MAX_META = 500

export interface TxMeta {
  note?: string
  category?: Category
}

interface StoredMeta extends TxMeta {
  updatedAt: number
}

type MetaMap = Record<string, StoredMeta>
const EMPTY: MetaMap = {}

export const isCategory = (value: unknown): value is Category => typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)

export function cleanNote(input: string | undefined): string | undefined {
  const note = (input ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX)
  return note === '' ? undefined : note
}

function sanitize(raw: unknown): MetaMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY
  const out: MetaMap = {}
  for (const [hash, value] of Object.entries(raw as Record<string, Partial<StoredMeta>>)) {
    if (!/^0x[0-9a-f]{64}$/.test(hash) || typeof value !== 'object' || value === null) continue
    const note = typeof value.note === 'string' ? cleanNote(value.note) : undefined
    // "Work" was an earlier category name; it is now "Business".
    const category = isCategory(value.category) ? value.category : (value.category as unknown) === 'Work' ? 'Business' : undefined
    if (note || category) out[hash] = { note, category, updatedAt: Number(value.updatedAt) || 0 }
  }
  return out
}

const store = createOwnerStore<MetaMap>('arvexa:txmeta:v1', EMPTY, sanitize)

export const useTxMetas = (owner: string | undefined): MetaMap => store.useOwner(owner)
export const readTxMeta = (owner: string, hash: string): TxMeta | undefined => store.read(owner)[hash.toLowerCase()]

/** Saves (or clears, when both fields are empty) the note and category for one transaction hash. */
export function setTxMeta(owner: string, hash: string, meta: TxMeta): void {
  const key = hash.toLowerCase()
  const note = cleanNote(meta.note)
  const category = isCategory(meta.category) ? meta.category : undefined
  const next: MetaMap = { ...store.read(owner) }
  if (!note && !category) delete next[key]
  else next[key] = { note, category, updatedAt: Date.now() }
  const keys = Object.keys(next)
  if (keys.length > MAX_META) {
    keys.sort((a, b) => next[a].updatedAt - next[b].updatedAt)
    for (const stale of keys.slice(0, keys.length - MAX_META)) delete next[stale]
  }
  store.write(owner, next)
}
