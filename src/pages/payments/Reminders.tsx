import { useState } from 'react'
import { Bell, Pencil, SkipForward, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { ContactPicker } from '@/components/Contacts'
import { Empty, Field, MODULES, ModuleHero, inputClass } from '@/components/payments/kit'
import { sanitizeAmount } from '@/components/Inputs'
import { Banner, Button, Card, cx } from '@/components/ui'
import { useNow } from '@/hooks/useNow'
import { formatUsdcDisplay, shortAddress } from '@/lib/format'
import { FREQUENCIES, FREQUENCY_LABEL, completeReminder, dueLabel, dueState, localDate, payReminderPath, removeReminder, saveReminder, useReminders, type Frequency, type Reminder } from '@/lib/payments/reminders'
import { navigate } from '@/lib/router'
import { formatUsdc } from '@/onchain-money'
import { DUE_COLOR } from '@/lib/payments/reminders'

function ReminderForm({ owner, editing, onDone }: { owner: Address; editing?: Reminder; onDone: () => void }) {
  const [name, setName] = useState(editing?.name ?? '')
  const [amount, setAmount] = useState(editing?.amount ? formatUsdc(BigInt(editing.amount)) : '')
  const [frequency, setFrequency] = useState<Frequency>(editing?.frequency ?? 'monthly')
  const [nextDue, setNextDue] = useState(editing?.nextDue ?? localDate())
  const [to, setTo] = useState(editing?.to ?? '')
  const [error, setError] = useState<{ field: string; message: string } | null>(null)
  const err = (field: string) => (error?.field === field ? error.message : null)

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const result = saveReminder(owner, { name, amount, frequency, nextDue, to }, editing?.id)
    if (!result.ok) return setError({ field: result.field, message: result.message })
    toast.success(editing ? 'Reminder updated' : 'Reminder saved')
    setError(null)
    if (!editing) {
      setName('')
      setAmount('')
      setTo('')
    }
    onDone()
  }

  return (
    <Card>
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={err('name')}>
            {({ id, invalid }) => <input id={id} value={name} maxLength={40} aria-invalid={invalid} autoComplete="off" placeholder="Rent, Internet, Subscription…" onChange={(event) => setName(event.target.value)} className={inputClass} />}
          </Field>
          <Field label="Amount (USDC)" optional error={err('amount')}>
            {({ id, invalid }) => <input id={id} inputMode="decimal" value={amount} aria-invalid={invalid} autoComplete="off" placeholder="0.00" onChange={(event) => setAmount(sanitizeAmount(event.target.value))} className={inputClass} />}
          </Field>
          <Field label="Repeats">
            {({ id }) => (
              <select id={id} value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)} className={inputClass}>
                {FREQUENCIES.map((option) => (
                  <option key={option} value={option}>
                    {FREQUENCY_LABEL[option]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Next payment date" error={err('nextDue')}>
            {({ id, invalid }) => <input id={id} type="date" value={nextDue} aria-invalid={invalid} onChange={(event) => setNextDue(event.target.value)} className={inputClass} />}
          </Field>
        </div>
        <Field label="Pay to (wallet address)" optional error={err('to')} hint="With an address, Pay now opens Send already filled in.">
          {({ id, invalid }) => <input id={id} value={to} spellCheck={false} aria-invalid={invalid} autoComplete="off" placeholder="0x…" onChange={(event) => setTo(event.target.value.trim())} className={cx(inputClass, 'mono text-xs')} />}
        </Field>
        <ContactPicker owner={owner} recipient={to} onPick={setTo} />
        <div className="flex gap-2">
          {editing && (
            <Button variant="secondary" className="flex-1" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button type="submit" className="flex-[2]">
            {editing ? 'Save changes' : 'Save reminder'}
          </Button>
        </div>
        <p className="text-center text-[11px] text-muted">Reminders never send money. When one is due you review the payment and confirm it in your wallet.</p>
      </form>
    </Card>
  )
}

function ReminderRow({ owner, reminder, today, onEdit }: { owner: Address; reminder: Reminder; today: string; onEdit: () => void }) {
  const state = dueState(reminder, today)
  const color = DUE_COLOR[state.state]
  return (
    <li className="rounded-2xl border border-line bg-surface-muted/60 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{reminder.name}</p>
          <p className="text-xs text-muted">
            {FREQUENCY_LABEL[reminder.frequency]} · next {reminder.nextDue}
            {reminder.to ? ` · to ${shortAddress(reminder.to)}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums">{reminder.amount ? `${formatUsdcDisplay(BigInt(reminder.amount))} USDC` : 'Amount varies'}</p>
          <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
            {dueLabel(state)}
          </span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="min-h-10" disabled={!reminder.to} onClick={() => navigate(payReminderPath(reminder))}>
          <Bell className="size-4" aria-hidden />
          Pay now
        </Button>
        <Button variant="secondary" className="min-h-10" onClick={() => completeReminder(owner, reminder.id, undefined, today)}>
          <SkipForward className="size-4" aria-hidden />
          Skip this time
        </Button>
        <Button variant="secondary" className="min-h-10" onClick={onEdit} aria-label={`Edit ${reminder.name}`}>
          <Pencil className="size-4" aria-hidden />
        </Button>
        <Button variant="secondary" className="min-h-10 text-danger" onClick={() => removeReminder(owner, reminder.id)} aria-label={`Delete ${reminder.name}`}>
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </div>
      {!reminder.to && <p className="mt-2 text-[11px] text-muted">Edit this reminder and add an address to use Pay now.</p>}
      {reminder.lastPaid && <p className="mt-2 text-[11px] text-success">Last paid {reminder.lastPaid.on} (confirmed onchain)</p>}
    </li>
  )
}

function RemindersContent({ owner }: { owner: Address }) {
  const reminders = useReminders(owner)
  const today = localDate(new Date(useNow(60_000)))
  const [editingId, setEditingId] = useState<string | null>(null)
  const sorted = [...reminders].sort((a, b) => a.nextDue.localeCompare(b.nextDue))
  const editing = sorted.find((reminder) => reminder.id === editingId)
  const overdue = sorted.filter((reminder) => dueState(reminder, today).state === 'overdue').length
  return (
    <div className="space-y-5">
      <ModuleHero module={MODULES.reminders} />
      {overdue > 0 && (
        <Banner tone="warn" title={`${overdue} ${overdue === 1 ? 'payment is' : 'payments are'} overdue`}>
          Review each one below. Nothing is paid until you confirm it in your wallet.
        </Banner>
      )}
      <ReminderForm key={editing?.id ?? 'new'} owner={owner} editing={editing} onDone={() => setEditingId(null)} />
      <Card className="!p-4 sm:!p-5">
        <h2 className="display mb-3 text-lg font-semibold">Upcoming payments</h2>
        {sorted.length === 0 ? (
          <Empty module={MODULES.reminders} title="No reminders yet">
            Add rent, internet or a subscription. You will see it on your dashboard as it comes due.
          </Empty>
        ) : (
          <ul className="space-y-2.5">
            {sorted.map((reminder) => (
              <ReminderRow key={reminder.id} owner={owner} reminder={reminder} today={today} onEdit={() => setEditingId(reminder.id)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export default function Reminders() {
  return <ConnectGate allowWrongNetwork>{(address) => <RemindersContent owner={address} />}</ConnectGate>
}
