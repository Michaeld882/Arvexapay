import { getAddress, isAddress, isAddressEqual, type Address } from 'viem'
import { createOwnerStore } from '@/lib/ownerStore'
import { checkRecipient } from '@/lib/validate'

/** A saved wallet address with a name. Stored in this browser only, separately for each connected wallet. */
export interface Contact {
  id: string
  name: string
  address: Address
  /** Optional short tag such as "Landlord" or "Client". */
  label?: string
  createdAt: number
}

export const MAX_CONTACTS = 50
export const NAME_MAX = 24

const EMPTY: Contact[] = []

function sanitize(raw: unknown): Contact[] {
  if (!Array.isArray(raw)) return EMPTY
  const out: Contact[] = []
  for (const entry of raw as Array<Partial<Contact>>) {
    if (typeof entry?.id !== 'string' || typeof entry.name !== 'string' || typeof entry.address !== 'string' || !isAddress(entry.address)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, NAME_MAX) : undefined
    out.push({ id: entry.id, name: entry.name.slice(0, NAME_MAX), address: getAddress(entry.address), label, createdAt: Number(entry.createdAt) || 0 })
  }
  return out
}

const store = createOwnerStore<Contact[]>('arvexa:contacts:v1', EMPTY, sanitize)

export const useContacts = (owner: string | undefined): Contact[] => store.useOwner(owner)
export const readContacts = (owner: string): Contact[] => store.read(owner)

export type ContactCheck = { ok: true; name: string; address: Address; label?: string } | { ok: false; field: 'name' | 'address'; message: string }

/** Validates a name and address before saving. The address must pass the same checks as a Send recipient. */
export function checkContact(owner: string, input: { name: string; address: string; label?: string }, editingId?: string): ContactCheck {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (name === '') return { ok: false, field: 'name', message: 'Give this address a name.' }
  if (name.length > NAME_MAX) return { ok: false, field: 'name', message: `Use ${NAME_MAX} characters or fewer.` }
  const to = checkRecipient(input.address)
  if (!to.ok) return { ok: false, field: 'address', message: to.message }
  if (isAddressEqual(to.address, owner as Address)) return { ok: false, field: 'address', message: 'That is your own address.' }
  const others = readContacts(owner).filter((contact) => contact.id !== editingId)
  if (others.some((contact) => isAddressEqual(contact.address, to.address))) return { ok: false, field: 'address', message: 'This address is already saved.' }
  if (others.some((contact) => contact.name.toLowerCase() === name.toLowerCase())) return { ok: false, field: 'name', message: 'You already have an address with this name.' }
  const label = (input.label ?? '').trim().replace(/\s+/g, ' ')
  if (label.length > NAME_MAX) return { ok: false, field: 'name', message: `Use ${NAME_MAX} characters or fewer for the label.` }
  return { ok: true, name, address: to.address, label: label === '' ? undefined : label }
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(16).slice(2)}`)

export function addContact(owner: string, input: { name: string; address: string; label?: string }): ContactCheck | { ok: true; name: string; address: Address; saved: boolean } {
  const check = checkContact(owner, input)
  if (!check.ok) return check
  const existing = readContacts(owner)
  if (existing.length >= MAX_CONTACTS) return { ok: false, field: 'name', message: `You can save up to ${MAX_CONTACTS} addresses.` }
  const saved = store.write(owner, [...existing, { id: newId(), name: check.name, address: check.address, label: check.label, createdAt: Date.now() }])
  return { ...check, saved }
}

export function updateContact(owner: string, id: string, input: { name: string; address: string; label?: string }): ContactCheck {
  const check = checkContact(owner, input, id)
  if (!check.ok) return check
  store.write(
    owner,
    readContacts(owner).map((contact) => (contact.id === id ? { ...contact, name: check.name, address: check.address, label: check.label } : contact)),
  )
  return check
}

export function removeContact(owner: string, id: string): void {
  store.write(
    owner,
    readContacts(owner).filter((contact) => contact.id !== id),
  )
}

export function contactFor(contacts: readonly Contact[], address: string | undefined): Contact | undefined {
  if (!address || !isAddress(address)) return undefined
  return contacts.find((contact) => isAddressEqual(contact.address, address))
}
