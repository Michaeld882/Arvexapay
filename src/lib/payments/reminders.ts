import { getAddress, isAddress, type Address } from 'viem'
import { createOwnerStore } from '@/lib/ownerStore'
import { checkAmount, checkRecipient } from '@/lib/validate'
import { formatUsdc } from '@/onchain-money'

/**
 * Recurring payment reminders. They only remind: nothing is ever sent by itself. When a payment is due the app shows
 * it, and paying opens the normal Send review where you confirm in your wallet.
 */
export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const
export type Frequency = (typeof FREQUENCIES)[number]
export const FREQUENCY_LABEL: Record<Frequency, string> = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' }

export interface Reminder {
  id: string
  name: string
  /** Raw 6-decimal USDC, when the amount is known. */
  amount?: string
  frequency: Frequency
  /** Local calendar date, YYYY-MM-DD. */
  nextDue: string
  /** Who gets paid, so Pay now can open Send already filled in. */
  to?: Address
  createdAt: number
  lastPaid?: { hash: string; on: string }
}

export const REMINDER_NAME_MAX = 40
const EMPTY: Reminder[] = []
const DATE = /^\d{4}-\d{2}-\d{2}$/

function sanitize(raw: unknown): Reminder[] {
  if (!Array.isArray(raw)) return EMPTY
  const out: Reminder[] = []
  for (const entry of raw as Array<Partial<Reminder>>) {
    if (typeof entry?.id !== 'string' || typeof entry.name !== 'string' || !(FREQUENCIES as readonly string[]).includes(String(entry.frequency)) || !DATE.test(String(entry.nextDue))) continue
    out.push({
      id: entry.id,
      name: entry.name.slice(0, REMINDER_NAME_MAX),
      amount: /^\d+$/.test(String(entry.amount)) && BigInt(String(entry.amount)) > 0n ? String(entry.amount) : undefined,
      frequency: entry.frequency as Frequency,
      nextDue: String(entry.nextDue),
      to: entry.to && isAddress(entry.to) ? getAddress(entry.to) : undefined,
      createdAt: Number(entry.createdAt) || 0,
      lastPaid: entry.lastPaid && typeof entry.lastPaid.hash === 'string' && DATE.test(String(entry.lastPaid.on)) ? { hash: entry.lastPaid.hash, on: entry.lastPaid.on } : undefined,
    })
  }
  return out
}

const store = createOwnerStore<Reminder[]>('arvexa:reminders:v1', EMPTY, sanitize)
export const useReminders = (owner: string | undefined): Reminder[] => store.useOwner(owner)
export const readReminders = (owner: string): Reminder[] => store.read(owner)

const pad = (value: number) => String(value).padStart(2, '0')
const utc = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const fromUtc = (ms: number) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Today's date on the user's calendar, as YYYY-MM-DD. */
export const localDate = (now = new Date()): string => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const index = m - 1 + months
  const year = y + Math.floor(index / 12)
  const month = ((index % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return `${year}-${pad(month + 1)}-${pad(Math.min(d, lastDay))}`
}

/** The date after `date` for this frequency. Month ends are kept ("31 Jan" becomes "28 Feb"). */
export function advanceDate(date: string, frequency: Frequency): string {
  if (frequency === 'weekly') return fromUtc(utc(date) + 7 * 86_400_000)
  if (frequency === 'monthly') return addMonths(date, 1)
  if (frequency === 'quarterly') return addMonths(date, 3)
  return addMonths(date, 12)
}

/** Next due date after paying or skipping: always moves to a date after today, never stays in the past. */
export function nextAfter(reminder: Pick<Reminder, 'nextDue' | 'frequency'>, today: string): string {
  let next = advanceDate(reminder.nextDue, reminder.frequency)
  for (let guard = 0; next <= today && guard < 520; guard++) next = advanceDate(next, reminder.frequency)
  return next
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later'
export const UPCOMING_DAYS = 14

export function dueState(reminder: Pick<Reminder, 'nextDue'>, today: string): { state: DueState; days: number } {
  const days = Math.round((utc(reminder.nextDue) - utc(today)) / 86_400_000)
  return { state: days < 0 ? 'overdue' : days === 0 ? 'today' : days <= UPCOMING_DAYS ? 'soon' : 'later', days }
}

/** Reminders that are overdue, due today or due within two weeks, soonest first. */
export function upcoming(reminders: readonly Reminder[], today: string): Reminder[] {
  return reminders.filter((reminder) => dueState(reminder, today).state !== 'later').sort((a, b) => a.nextDue.localeCompare(b.nextDue))
}

export interface ReminderInput {
  name: string
  amount: string
  frequency: Frequency
  nextDue: string
  to: string
}

export type ReminderCheck =
  | { ok: true; name: string; amount?: bigint; frequency: Frequency; nextDue: string; to?: Address }
  | { ok: false; field: 'name' | 'amount' | 'nextDue' | 'to'; message: string }

export function checkReminder(input: ReminderInput): ReminderCheck {
  const name = input.name.replace(/\s+/g, ' ').trim()
  if (name === '') return { ok: false, field: 'name', message: 'Name the payment, for example "Rent".' }
  if (name.length > REMINDER_NAME_MAX) return { ok: false, field: 'name', message: `Use ${REMINDER_NAME_MAX} characters or fewer.` }
  let amount: bigint | undefined
  if (input.amount.trim() !== '') {
    const parsed = checkAmount(input.amount)
    if (!parsed.ok) return { ok: false, field: 'amount', message: parsed.message }
    amount = parsed.raw
  }
  if (!(FREQUENCIES as readonly string[]).includes(input.frequency)) return { ok: false, field: 'name', message: 'Choose how often it repeats.' }
  if (!DATE.test(input.nextDue) || Number.isNaN(utc(input.nextDue))) return { ok: false, field: 'nextDue', message: 'Choose the next payment date.' }
  let to: Address | undefined
  if (input.to.trim() !== '') {
    const recipient = checkRecipient(input.to)
    if (!recipient.ok) return { ok: false, field: 'to', message: recipient.message }
    to = recipient.address
  }
  return { ok: true, name, amount, frequency: input.frequency, nextDue: input.nextDue, to }
}

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function saveReminder(owner: string, input: ReminderInput, editingId?: string): ReminderCheck {
  const check = checkReminder(input)
  if (!check.ok) return check
  const existing = readReminders(owner)
  if (editingId) {
    store.write(
      owner,
      existing.map((reminder) => (reminder.id === editingId ? { ...reminder, name: check.name, amount: check.amount?.toString(), frequency: check.frequency, nextDue: check.nextDue, to: check.to } : reminder)),
    )
  } else {
    store.write(owner, [...existing, { id: newId(), name: check.name, amount: check.amount?.toString(), frequency: check.frequency, nextDue: check.nextDue, to: check.to, createdAt: Date.now() }])
  }
  return check
}

export function removeReminder(owner: string, id: string): void {
  store.write(
    owner,
    readReminders(owner).filter((reminder) => reminder.id !== id),
  )
}

/** Moves a reminder to its next date. Called after a payment is confirmed onchain, or when you skip a cycle. */
export function completeReminder(owner: string, id: string, hash: string | undefined, today = localDate()): void {
  store.write(
    owner,
    readReminders(owner).map((reminder) => (reminder.id === id ? { ...reminder, nextDue: nextAfter(reminder, today), lastPaid: hash ? { hash, on: today } : reminder.lastPaid } : reminder)),
  )
}

export const DUE_COLOR = { overdue: 'var(--danger)', today: 'var(--warn)', soon: '#4f8cff', later: 'var(--muted)' } as const

export function dueLabel(state: { state: DueState; days: number }): string {
  if (state.state === 'overdue') return `Overdue by ${-state.days} ${-state.days === 1 ? 'day' : 'days'}`
  if (state.state === 'today') return 'Due today'
  return `Due in ${state.days} ${state.days === 1 ? 'day' : 'days'}`
}

/** Opens Send with this reminder's payment filled in. You still review it and confirm in your wallet. */
export function payReminderPath(reminder: Reminder): string {
  const params = new URLSearchParams()
  if (reminder.to) params.set('to', reminder.to)
  if (reminder.amount) params.set('amount', formatUsdc(BigInt(reminder.amount)))
  params.set('note', reminder.name)
  params.set('reminder', reminder.id)
  return `/send?${params.toString()}`
}

