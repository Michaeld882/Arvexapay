import { useId, useState } from 'react'
import { BookUser, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import type { Address } from 'viem'
import { toast } from 'sonner'
import { Button, Card, CopyButton, cx } from '@/components/ui'
import { Link } from '@/lib/router'
import { MAX_CONTACTS, NAME_MAX, addContact, checkContact, contactFor, removeContact, updateContact, useContacts, type Contact } from '@/lib/contacts'
import { shortAddress } from '@/lib/format'
import { sendLink } from '@/lib/paymentQr'
import { checkRecipient } from '@/lib/validate'

const TINTS = ['#2cf5a6', '#22d3ee', '#4f8cff', '#a855f7', '#e879f9']
const tintFor = (address: string) => TINTS[parseInt(address.slice(2, 6), 16) % TINTS.length]

function Avatar({ contact, size = 'size-10' }: { contact: Pick<Contact, 'name' | 'address'>; size?: string }) {
  const tint = tintFor(contact.address)
  return (
    <span
      aria-hidden
      className={cx('flex shrink-0 items-center justify-center rounded-xl text-sm font-bold', size)}
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 16%, transparent)`, boxShadow: `0 0 16px -6px ${tint}` }}
    >
      {contact.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

const fieldClass = (error: boolean) =>
  cx('min-h-11 w-full rounded-xl border bg-surface-muted px-3 text-sm text-ink outline-none transition-colors placeholder:text-subtle', error ? 'border-danger' : 'border-line focus:border-line-strong')

interface FormProps {
  owner: string
  /** Edit an existing contact, or add a new one (optionally with the address already filled in). */
  editing?: Contact
  initialAddress?: string
  onDone: () => void
}

/** Add or edit one saved address. The address must pass the same checks as a Send recipient before it is saved. */
export function ContactForm({ owner, editing, initialAddress = '', onDone }: FormProps) {
  const [name, setName] = useState(editing?.name ?? '')
  const [address, setAddress] = useState(editing?.address ?? initialAddress)
  const [label, setLabel] = useState(editing?.label ?? '')
  const [touched, setTouched] = useState(false)
  const labelId = useId()
  const nameId = useId()
  const addressId = useId()
  const check = checkContact(owner, { name, address, label }, editing?.id)
  const nameError = touched && !check.ok && check.field === 'name' ? check.message : null
  const addressError = (touched || address !== '') && !check.ok && check.field === 'address' ? check.message : null

  const save = () => {
    setTouched(true)
    const result = editing ? updateContact(owner, editing.id, { name, address, label }) : addContact(owner, { name, address, label })
    if (!result.ok) return
    if ('saved' in result && !result.saved) toast.warning('Saved for this session only. Your browser did not allow saving to this device.')
    else toast.success(editing ? 'Address updated' : 'Address saved')
    onDone()
  }

  return (
    <form
      className="space-y-3 rounded-2xl border border-line bg-surface-muted p-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <div>
        <label htmlFor={nameId} className="mb-1.5 block text-xs font-semibold text-ink-2">
          Name
        </label>
        <input id={nameId} value={name} maxLength={NAME_MAX} placeholder="Brother, Client, Work…" autoComplete="off" onChange={(event) => setName(event.target.value)} className={fieldClass(Boolean(nameError))} aria-invalid={Boolean(nameError)} />
        {nameError && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {nameError}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={addressId} className="mb-1.5 block text-xs font-semibold text-ink-2">
          Wallet address
        </label>
        <input
          id={addressId}
          value={address}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="0x…"
          onChange={(event) => setAddress(event.target.value.trim())}
          className={cx(fieldClass(Boolean(addressError)), 'mono text-xs')}
          aria-invalid={Boolean(addressError)}
        />
        {addressError && (
          <p role="alert" className="mt-1.5 text-xs text-danger">
            {addressError}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={labelId} className="mb-1.5 block text-xs font-semibold text-ink-2">
          Label <span className="font-normal text-muted">(optional)</span>
        </label>
        <input id={labelId} value={label} maxLength={NAME_MAX} placeholder="Landlord, Supplier…" autoComplete="off" onChange={(event) => setLabel(event.target.value)} className={fieldClass(false)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" className="min-h-10" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" className="min-h-10" disabled={!check.ok}>
          {editing ? 'Save changes' : 'Save address'}
        </Button>
      </div>
    </form>
  )
}

function ContactRow({ owner, contact, onEdit }: { owner: string; contact: Contact; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="slide-in -mx-2 rounded-2xl px-2 py-3 transition-colors hover:bg-accent-soft">
      <div className="flex items-center gap-3">
        <Avatar contact={contact} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">
            {contact.name}
            {contact.label && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-hover">{contact.label}</span>}
          </p>
          <p className="mono text-xs text-muted" title={contact.address}>
            {shortAddress(contact.address)}
          </p>
        </div>
        <Link
          to={sendLink(contact.address)}
          aria-label={`Send to ${contact.name}`}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-accent-soft px-3 text-xs font-semibold text-accent-hover transition-transform active:scale-95"
        >
          <Send className="size-3.5" aria-hidden />
          Send
        </Link>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[52px]">
        <CopyButton value={contact.address} label="Copy" className="min-h-9 px-3 text-xs" />
        <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={onEdit} aria-label={`Edit ${contact.name}`}>
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
        {confirming ? (
          <>
            <Button
              variant="danger"
              className="min-h-9 px-3 text-xs"
              onClick={() => {
                removeContact(owner, contact.id)
                toast.success(`${contact.name} removed`)
              }}
              aria-label={`Confirm delete ${contact.name}`}
            >
              Delete
            </Button>
            <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => setConfirming(true)} aria-label={`Delete ${contact.name}`}>
            <Trash2 className="size-3.5" aria-hidden />
            Delete
          </Button>
        )}
      </div>
    </li>
  )
}

/** Saved addresses: add, name, edit, delete, copy and send. Kept in this browser, per connected wallet. */
export function ContactsCard({ owner }: { owner: Address }) {
  const contacts = useContacts(owner)
  const [mode, setMode] = useState<{ type: 'idle' } | { type: 'add' } | { type: 'edit'; id: string }>({ type: 'idle' })
  const editing = mode.type === 'edit' ? contacts.find((contact) => contact.id === mode.id) : undefined
  const idle = () => setMode({ type: 'idle' })

  return (
    <Card className="rise lift-lg space-y-1">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="display flex items-center gap-2 text-lg font-semibold">
          <BookUser className="size-5 text-accent-hover" aria-hidden />
          Saved addresses
        </h2>
        {mode.type === 'idle' && contacts.length < MAX_CONTACTS && (
          <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => setMode({ type: 'add' })}>
            <Plus className="size-3.5" aria-hidden />
            Add address
          </Button>
        )}
      </div>
      {mode.type === 'add' && <ContactForm owner={owner} onDone={idle} />}
      {mode.type === 'edit' && editing && <ContactForm key={editing.id} owner={owner} editing={editing} onDone={idle} />}
      {contacts.length === 0 && mode.type === 'idle' ? (
        <div className="py-5 text-center text-sm text-muted">
          <p className="font-semibold text-ink">No saved addresses yet</p>
          <p className="mt-1">Save the people you pay often, then pick them in one tap when you send.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {contacts.map((contact) => (
            <ContactRow key={contact.id} owner={owner} contact={contact} onEdit={() => setMode({ type: 'edit', id: contact.id })} />
          ))}
        </ul>
      )}
      <p className="pt-2 text-[11px] text-muted">Saved on this device only, for this wallet. Never sent anywhere.</p>
    </Card>
  )
}

/** Under the Send recipient field: pick a saved address, see who an address belongs to, or save a new one. */
export function ContactPicker({ owner, recipient, onPick }: { owner: Address; recipient: string; onPick: (address: Address) => void }) {
  const contacts = useContacts(owner)
  const [saving, setSaving] = useState(false)
  const typed = checkRecipient(recipient)
  const match = typed.ok ? contactFor(contacts, typed.address) : undefined
  const canSave = typed.ok && !match && contacts.length < MAX_CONTACTS

  if (contacts.length === 0 && !canSave) return null
  return (
    <div className="space-y-2.5">
      {contacts.length > 0 && (
        <div role="group" aria-label="Saved addresses" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {contacts.map((contact) => {
            const selected = match?.id === contact.id
            const tint = tintFor(contact.address)
            return (
              <button
                key={contact.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(contact.address)}
                className={cx('flex min-h-11 shrink-0 items-center gap-2 rounded-full border py-1 pl-1.5 pr-3.5 text-sm font-semibold transition-all duration-200 active:scale-95', selected ? 'border-transparent text-ink' : 'border-line bg-surface-muted text-ink-2 hover:border-line-strong')}
                style={selected ? { background: `color-mix(in srgb, ${tint} 18%, transparent)`, boxShadow: `0 0 16px -4px ${tint}` } : undefined}
              >
                <Avatar contact={contact} size="size-8" />
                {contact.name}
              </button>
            )
          })}
        </div>
      )}
      {match && <p className="text-xs text-muted">Saved as <strong className="font-semibold text-ink-2">{match.name}</strong></p>}
      {canSave && !saving && (
        <button type="button" onClick={() => setSaving(true)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg text-xs font-semibold text-accent-hover hover:underline">
          <Plus className="size-3.5" aria-hidden />
          Save this address
        </button>
      )}
      {canSave && saving && typed.ok && (
        <ContactForm
          owner={owner}
          initialAddress={typed.address}
          onDone={() => {
            setSaving(false)
          }}
        />
      )}
    </div>
  )
}
