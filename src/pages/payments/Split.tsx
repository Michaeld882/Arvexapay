import { useMemo, useState } from 'react'
import { Plus, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { Empty, Field, MODULES, ModuleHero, ShareRow, StatusBadge, SyncStatus, inputClass, useShareBase } from '@/components/payments/kit'
import { VerifyByHash } from '@/components/payments/RequestsEngine'
import { sanitizeAmount } from '@/components/Inputs'
import { Banner, Button, Card, cx } from '@/components/ui'
import { usePaymentSync } from '@/hooks/usePayments'
import { useNow } from '@/hooks/useNow'
import { formatUsdcDisplay } from '@/lib/format'
import { linkForRequest, payLinkPath } from '@/lib/payments/links'
import { useMerchantName } from '@/lib/payments/receipts'
import { removeRequest, useRequests } from '@/lib/payments/requests'
import { MAX_PARTICIPANTS, checkSplit, createSplit, removeSplit, splitEqually, splitProgress, useSplits, type Split } from '@/lib/payments/splits'
import { getArcClient } from '@/lib/rpc'
import { checkAmount } from '@/lib/validate'
import { formatUsdc } from '@/onchain-money'

interface Person {
  key: number
  name: string
  address: string
  amount: string
}

let nextKey = 1
const blank = (): Person => ({ key: nextKey++, name: '', address: '', amount: '' })

function SplitForm({ owner }: { owner: Address }) {
  const [title, setTitle] = useState('')
  const [total, setTotal] = useState('')
  const [includeMe, setIncludeMe] = useState(true)
  const [myShare, setMyShare] = useState('')
  const [people, setPeople] = useState<Person[]>(() => [blank(), blank()])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const totalCheck = useMemo(() => checkAmount(total), [total])
  const raw = (value: string) => {
    const parsed = checkAmount(value)
    return parsed.ok ? parsed.raw : 0n
  }
  const mine = includeMe ? raw(myShare) : 0n
  const assigned = people.reduce((sum, person) => sum + raw(person.amount), 0n) + mine
  const difference = totalCheck.ok ? totalCheck.raw - assigned : 0n

  const splitEvenly = () => {
    if (!totalCheck.ok) return
    const count = people.length + (includeMe ? 1 : 0)
    const shares = splitEqually(totalCheck.raw, count)
    if (includeMe) setMyShare(formatUsdc(shares[0]))
    setPeople((current) => current.map((person, index) => ({ ...person, amount: formatUsdc(shares[index + (includeMe ? 1 : 0)]) })))
    setError(null)
  }
  const update = (key: number, change: Partial<Person>) => setPeople((current) => current.map((person) => (person.key === key ? { ...person, ...change } : person)))

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const input = { title, total, myShare: includeMe ? myShare : '', participants: people.map(({ name, address, amount }) => ({ name, address, amount })) }
    const check = checkSplit(owner, input)
    if (!check.ok) return setError(check.message)
    setSaving(true)
    let head: bigint | undefined
    try {
      head = await getArcClient().getBlockNumber()
    } catch {
      head = undefined
    }
    const result = createSplit(owner, input, head)
    setSaving(false)
    if (!result.ok) return setError(result.message)
    setError(null)
    setTitle('')
    setTotal('')
    setMyShare('')
    setPeople([blank(), blank()])
    toast.success('Bill created. Share each person their link.')
  }

  return (
    <Card>
      <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bill name">{({ id }) => <input id={id} value={title} maxLength={40} autoComplete="off" placeholder="Dinner, trip, rent…" onChange={(event) => setTitle(event.target.value)} className={inputClass} />}</Field>
          <Field label="Total amount (USDC)">{({ id }) => <input id={id} inputMode="decimal" value={total} autoComplete="off" placeholder="0.00" onChange={(event) => setTotal(sanitizeAmount(event.target.value))} className={cx(inputClass, 'display text-lg font-semibold tabular-nums')} />}</Field>
        </div>

        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border border-line bg-surface-muted px-4 text-sm">
          <input type="checkbox" checked={includeMe} onChange={(event) => setIncludeMe(event.target.checked)} className="size-4 accent-[var(--accent)]" />
          <span>I am one of the people sharing this bill</span>
        </label>
        {includeMe && (
          <Field label="My share (USDC)" hint="You cover this part yourself. It is not requested from anyone.">
            {({ id }) => <input id={id} inputMode="decimal" value={myShare} autoComplete="off" placeholder="0.00" onChange={(event) => setMyShare(sanitizeAmount(event.target.value))} className={inputClass} />}
          </Field>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-ink-2">People who owe a share</p>
            <Button variant="secondary" className="min-h-9 text-xs" disabled={!totalCheck.ok || people.length === 0} onClick={splitEvenly}>
              Split equally
            </Button>
          </div>
          {people.map((person, index) => (
            <div key={person.key} className="space-y-2 rounded-2xl border border-line bg-surface-muted/60 p-3">
              <div className="flex gap-2">
                <input aria-label={`Person ${index + 1} name`} value={person.name} maxLength={24} autoComplete="off" placeholder={`Person ${index + 1}`} onChange={(event) => update(person.key, { name: event.target.value })} className={cx(inputClass, 'min-h-11')} />
                <input aria-label={`Person ${index + 1} amount`} inputMode="decimal" value={person.amount} autoComplete="off" placeholder="0.00" onChange={(event) => update(person.key, { amount: sanitizeAmount(event.target.value) })} className={cx(inputClass, 'min-h-11 w-32 shrink-0 tabular-nums')} />
                <button type="button" aria-label={`Remove person ${index + 1}`} disabled={people.length <= 1} onClick={() => setPeople((current) => current.filter((candidate) => candidate.key !== person.key))} className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl text-subtle transition-colors hover:text-danger disabled:opacity-40">
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
              <input aria-label={`Person ${index + 1} wallet address`} value={person.address} spellCheck={false} autoComplete="off" placeholder="Wallet address (optional, only they can then settle it)" onChange={(event) => update(person.key, { address: event.target.value.trim() })} className={cx(inputClass, 'mono min-h-10 text-xs')} />
            </div>
          ))}
          <Button variant="secondary" className="min-h-10" disabled={people.length >= MAX_PARTICIPANTS} onClick={() => setPeople((current) => [...current, blank()])}>
            <UserPlus className="size-4" aria-hidden />
            Add person
          </Button>
        </div>

        <dl className="grid grid-cols-3 gap-2 text-center" aria-label="Bill summary">
          {[
            ['Total', totalCheck.ok ? formatUsdcDisplay(totalCheck.raw) : '—'],
            ['Assigned', formatUsdcDisplay(assigned)],
            [difference < 0n ? 'Over by' : 'Left to assign', totalCheck.ok ? formatUsdcDisplay(difference < 0n ? -difference : difference) : '—'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-line bg-surface-muted p-2.5">
              <dt className="text-[11px] text-muted">{label}</dt>
              <dd className={cx('display font-semibold tabular-nums', label === 'Over by' && 'text-danger', label === 'Left to assign' && difference === 0n && totalCheck.ok && 'text-success')}>{value}</dd>
            </div>
          ))}
        </dl>

        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" className="w-full" loading={saving} disabled={!totalCheck.ok || title.trim() === ''}>
          <Plus className="size-4" aria-hidden />
          Create bill and requests
        </Button>
        <p className="text-center text-[11px] text-muted">Each person gets their own payment link. Their share turns Paid only when their USDC payment is found on Arc.</p>
      </form>
    </Card>
  )
}

function SplitCard({ owner, split, now }: { owner: Address; split: Split; now: number }) {
  const requests = useRequests(owner)
  const base = useShareBase()
  const merchant = useMerchantName(owner)
  const progress = useMemo(() => splitProgress(split, requests, now), [split, requests, now])
  const percent = progress.expected === 0n ? 0 : Number((progress.paid * 100n) / progress.expected)
  const [verify, setVerify] = useState<string | null>(null)

  const remove = () => {
    for (const person of split.participants) removeRequest(owner, person.requestId)
    removeSplit(owner, split.id)
  }

  return (
    <li className="rounded-2xl border border-line bg-surface-muted/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{split.title}</p>
          <p className="text-xs text-muted">
            Bill {formatUsdcDisplay(BigInt(split.total))} USDC{BigInt(split.myShare) > 0n ? ` · your share ${formatUsdcDisplay(BigInt(split.myShare))}` : ''}
          </p>
        </div>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-semibold', progress.completed ? 'text-success' : 'text-warn')} style={{ background: `color-mix(in srgb, ${progress.completed ? 'var(--success)' : 'var(--warn)'} 14%, transparent)` }}>
          {progress.completed ? 'Completed' : `${progress.paidCount} of ${progress.rows.length} paid`}
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Collected">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${percent}%`, background: 'linear-gradient(90deg, #a855f7, #e879f9)' }} />
      </div>
      <p className="mt-1.5 text-xs text-muted tabular-nums">
        Collected {formatUsdcDisplay(progress.paid)} of {formatUsdcDisplay(progress.expected)} USDC · Remaining {formatUsdcDisplay(progress.remaining)}
      </p>

      <ul className="mt-3 space-y-2">
        {progress.rows.map(({ participant, request, status }) => (
          <li key={participant.id} className="rounded-2xl border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{participant.name}</p>
                <p className="text-xs tabular-nums text-muted">{formatUsdcDisplay(BigInt(participant.amount))} USDC</p>
              </div>
              <StatusBadge status={status} />
            </div>
            {request && status !== 'paid' && status !== 'cancelled' && (
              <div className="mt-2.5 space-y-2">
                <ShareRow url={base ? `${base}${payLinkPath(linkForRequest(request, merchant))}` : undefined} title={`${split.title}: your share`} text={`${merchant ?? 'Your share'} for ${split.title}: ${formatUsdcDisplay(BigInt(participant.amount))} USDC`} />
                <button type="button" aria-expanded={verify === participant.id} onClick={() => setVerify((current) => (current === participant.id ? null : participant.id))} className="text-xs font-semibold text-accent-hover hover:underline">
                  Already paid? Verify with a transaction hash
                </button>
                {verify === participant.id && <VerifyByHash owner={owner} request={request} />}
              </div>
            )}
            {request?.paid && <p className="mt-2 text-xs text-success">Verified on Arc · {request.paid.hash.slice(0, 10)}…</p>}
          </li>
        ))}
      </ul>
      <Button variant="secondary" className="mt-3 min-h-10 text-danger" onClick={remove}>
        <Trash2 className="size-4" aria-hidden />
        Delete bill
      </Button>
    </li>
  )
}

function SplitContent({ owner }: { owner: Address }) {
  const splits = useSplits(owner)
  const sync = usePaymentSync(owner)
  const now = Math.floor(useNow(30_000) / 1000)
  return (
    <div className="space-y-5">
      <ModuleHero module={MODULES.split} />
      <SplitForm owner={owner} />
      <SyncStatus sync={sync} />
      <Card className="!p-4 sm:!p-5">
        <h2 className="display mb-3 text-lg font-semibold">Your bills</h2>
        {splits.length === 0 ? (
          <Empty module={MODULES.split} title="No bills yet">
            Create a bill, add the people who owe a share, and watch each share turn Paid as the real USDC arrives.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {splits.map((split) => (
              <SplitCard key={split.id} owner={owner} split={split} now={now} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export default function SplitPage() {
  return <ConnectGate allowWrongNetwork>{(address) => <SplitContent owner={address} />}</ConnectGate>
}
