import { getAddress, isAddressEqual, type Address } from 'viem'
import { createOwnerStore } from '@/lib/ownerStore'
import { formatUsdc } from '@/onchain-money'
import { createRequest, newRequestId, statusOf, type PaymentRequest, type RequestStatus } from '@/lib/payments/requests'
import { checkAmount, checkRecipient } from '@/lib/validate'

export interface SplitParticipant {
  id: string
  name: string
  address?: Address
  /** Raw 6-decimal USDC base units. */
  amount: string
  requestId: string
}

export interface Split {
  id: string
  title: string
  /** The full bill, raw 6-decimal USDC. */
  total: string
  /** The part you cover yourself. It is not requested from anyone. */
  myShare: string
  createdAt: number
  participants: SplitParticipant[]
}

export const SPLIT_TITLE_MAX = 40
export const PARTICIPANT_NAME_MAX = 24
export const MAX_PARTICIPANTS = 20
const EMPTY: Split[] = []

function sanitize(raw: unknown): Split[] {
  if (!Array.isArray(raw)) return EMPTY
  const out: Split[] = []
  for (const entry of raw as Array<Partial<Split>>) {
    if (typeof entry?.id !== 'string' || typeof entry.title !== 'string' || !/^\d+$/.test(String(entry.total)) || !Array.isArray(entry.participants)) continue
    const participants: SplitParticipant[] = []
    for (const person of entry.participants as Array<Partial<SplitParticipant>>) {
      if (typeof person?.id !== 'string' || typeof person.name !== 'string' || typeof person.requestId !== 'string' || !/^\d+$/.test(String(person.amount))) continue
      const checked = person.address ? checkRecipient(person.address, { blockVault: false }) : undefined
      participants.push({ id: person.id, name: person.name.slice(0, PARTICIPANT_NAME_MAX), address: checked?.ok ? checked.address : undefined, amount: String(person.amount), requestId: person.requestId })
    }
    out.push({ id: entry.id, title: entry.title.slice(0, SPLIT_TITLE_MAX), total: String(entry.total), myShare: /^\d+$/.test(String(entry.myShare)) ? String(entry.myShare) : '0', createdAt: Number(entry.createdAt) || 0, participants })
  }
  return out
}

const store = createOwnerStore<Split[]>('arvexa:splits:v1', EMPTY, sanitize)
export const useSplits = (owner: string | undefined): Split[] => store.useOwner(owner)
export const readSplits = (owner: string): Split[] => store.read(owner)

/** Divides `total` into `count` parts that add up exactly. Any leftover base unit goes to the first people. */
export function splitEqually(total: bigint, count: number): bigint[] {
  if (count <= 0) return []
  const share = total / BigInt(count)
  const extra = Number(total % BigInt(count))
  return Array.from({ length: count }, (_, index) => share + (index < extra ? 1n : 0n))
}

export interface SplitInput {
  title: string
  total: string
  /** Decimal USDC you cover yourself; empty means 0. */
  myShare: string
  participants: Array<{ name: string; address: string; amount: string }>
}

export type SplitCheck =
  | { ok: true; total: bigint; myShare: bigint; people: Array<{ name: string; address?: Address; amount: bigint }> }
  | { ok: false; message: string; field: 'title' | 'total' | 'myShare' | 'participants' }

/** Checks a bill before it is saved: every share is valid and the shares add up to exactly the total. */
export function checkSplit(owner: string, input: SplitInput): SplitCheck {
  const title = input.title.replace(/\s+/g, ' ').trim()
  if (title === '') return { ok: false, field: 'title', message: 'Name the bill, for example "Dinner".' }
  if (title.length > SPLIT_TITLE_MAX) return { ok: false, field: 'title', message: `Use ${SPLIT_TITLE_MAX} characters or fewer.` }
  const total = checkAmount(input.total)
  if (!total.ok) return { ok: false, field: 'total', message: total.message }
  let myShare = 0n
  if (input.myShare.trim() !== '') {
    const mine = checkAmount(input.myShare)
    if (!mine.ok) return { ok: false, field: 'myShare', message: `Your share: ${mine.message}` }
    myShare = mine.raw
  }
  if (input.participants.length === 0) return { ok: false, field: 'participants', message: 'Add at least one person who owes a share.' }
  if (input.participants.length > MAX_PARTICIPANTS) return { ok: false, field: 'participants', message: `A bill can have up to ${MAX_PARTICIPANTS} people.` }
  const people: Array<{ name: string; address?: Address; amount: bigint }> = []
  const names = new Set<string>()
  for (const [index, person] of input.participants.entries()) {
    const name = person.name.replace(/\s+/g, ' ').trim()
    if (name === '') return { ok: false, field: 'participants', message: `Person ${index + 1} needs a name.` }
    if (name.length > PARTICIPANT_NAME_MAX) return { ok: false, field: 'participants', message: `${name.slice(0, 12)}…: use ${PARTICIPANT_NAME_MAX} characters or fewer.` }
    if (names.has(name.toLowerCase())) return { ok: false, field: 'participants', message: `Two people are called "${name}". Use different names.` }
    names.add(name.toLowerCase())
    const amount = checkAmount(person.amount)
    if (!amount.ok) return { ok: false, field: 'participants', message: `${name}: ${amount.message}` }
    let address: Address | undefined
    if (person.address.trim() !== '') {
      const to = checkRecipient(person.address, { blockVault: false })
      if (!to.ok) return { ok: false, field: 'participants', message: `${name}: ${to.message}` }
      if (isAddressEqual(to.address, getAddress(owner))) return { ok: false, field: 'participants', message: `${name}: that is your own address.` }
      address = to.address
    }
    people.push({ name, address, amount: amount.raw })
  }
  const sum = people.reduce((acc, person) => acc + person.amount, 0n) + myShare
  if (sum !== total.raw) {
    const diff = sum > total.raw ? sum - total.raw : total.raw - sum
    return { ok: false, field: 'participants', message: `The shares ${sum > total.raw ? 'are over' : 'are short of'} the total by ${diff} base units. They must add up exactly.` }
  }
  return { ok: true, total: total.raw, myShare, people }
}

export function createSplit(owner: Address, input: SplitInput, head?: bigint): { ok: true; split: Split } | Extract<SplitCheck, { ok: false }> {
  const check = checkSplit(owner, input)
  if (!check.ok) return check
  const splitId = newRequestId()
  const title = input.title.replace(/\s+/g, ' ').trim()
  const participants: SplitParticipant[] = []
  for (const person of check.people) {
    const made = createRequest(owner, 'split', { amount: formatUsdc(person.amount), description: `${title} (${person.name})`, expiresInDays: 30 }, head, {
      splitId,
      participantName: person.name,
      payer: person.address,
    })
    if (!made.ok) return { ok: false, field: 'participants', message: made.message }
    participants.push({ id: newRequestId(), name: person.name, address: person.address, amount: person.amount.toString(), requestId: made.request.id })
  }
  const split: Split = { id: splitId, title, total: check.total.toString(), myShare: check.myShare.toString(), createdAt: Math.floor(Date.now() / 1000), participants }
  store.write(owner, [split, ...readSplits(owner)])
  return { ok: true, split }
}

export interface SplitRow {
  participant: SplitParticipant
  request?: PaymentRequest
  status: RequestStatus
}

export interface SplitProgress {
  rows: SplitRow[]
  paidCount: number
  /** What the people owe in total (the bill minus your own share). */
  expected: bigint
  paid: bigint
  /** What is still to collect. Never negative. */
  remaining: bigint
  /** True only when every person's payment has been verified onchain. */
  completed: boolean
}

export function splitProgress(split: Split, requests: readonly PaymentRequest[], nowSeconds: number): SplitProgress {
  const rows: SplitRow[] = split.participants.map((participant) => {
    const request = requests.find((candidate) => candidate.id === participant.requestId)
    return { participant, request, status: request ? statusOf(request, nowSeconds) : 'cancelled' }
  })
  const expected = split.participants.reduce((sum, person) => sum + BigInt(person.amount), 0n)
  const paid = rows.reduce((sum, row) => (row.status === 'paid' ? sum + BigInt(row.participant.amount) : sum), 0n)
  const paidCount = rows.filter((row) => row.status === 'paid').length
  return { rows, paidCount, expected, paid, remaining: expected > paid ? expected - paid : 0n, completed: rows.length > 0 && paidCount === rows.length }
}

export function removeSplit(owner: string, id: string): void {
  store.write(
    owner,
    readSplits(owner).filter((split) => split.id !== id),
  )
}
