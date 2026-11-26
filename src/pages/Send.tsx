import { useId, useMemo, useState } from 'react'
import { isAddressEqual, type Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { ContactPicker } from '@/components/Contacts'
import { DisabledHint } from '@/components/DisabledHint'
import { AmountInput, RecipientInput } from '@/components/Inputs'
import { CategoryChips } from '@/components/TxMetaEditor'
import { TxDialog } from '@/components/TxDialog'
import { LastTxCard } from '@/components/LastTxCard'
import { Banner, Button, Card, PageHeader } from '@/components/ui'
import { useSpendableUsdc } from '@/hooks/useSpendable'
import { useTxFlow } from '@/hooks/useTxFlow'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { buildSendPlan, withMeta } from '@/lib/plan'
import { completeReminder } from '@/lib/payments/reminders'
import { NOTE_MAX, cleanNote, type Category } from '@/lib/txMeta'
import { checkAmount, checkRecipient } from '@/lib/validate'

/** A scanned QR or shared link opens Send as /send?to=0x...&amount=1 . Only values that pass the normal checks are used. */
function prefillFromLink(): { to: string; amount: string; note: string; reminder?: string } {
  const params = new URLSearchParams(window.location.search)
  const to = checkRecipient(params.get('to') ?? '')
  const amount = checkAmount(params.get('amount') ?? '')
  const reminder = params.get('reminder')
  return { to: to.ok ? to.address : '', amount: amount.ok ? (params.get('amount') ?? '') : '', note: cleanNote(params.get('note') ?? '') ?? '', reminder: reminder && /^[\w-]{1,40}$/.test(reminder) ? reminder : undefined }
}

function SendForm({ address }: { address: Address }) {
  const [prefill] = useState(prefillFromLink)
  const [recipient, setRecipient] = useState(prefill.to)
  const [amount, setAmount] = useState(prefill.amount)
  const [note, setNote] = useState(prefill.note)
  const [category, setCategory] = useState<Category | undefined>()
  const noteId = useId()
  const { balance, spendable, feeUsdc } = useSpendableUsdc(address)
  const flow = useTxFlow({
    onSuccess: (_plan, hash) => {
      // A payment made from a reminder is only counted once it is confirmed onchain.
      if (prefill.reminder) completeReminder(address, prefill.reminder, hash)
      setRecipient('')
      setAmount('')
      setNote('')
      setCategory(undefined)
    },
  })

  const to = useMemo(() => checkRecipient(recipient), [recipient])
  const value = useMemo(() => checkAmount(amount), [amount])

  const recipientError = recipient && !to.ok ? to.message : null
  const insufficient = value.ok && balance.data !== undefined && value.raw > balance.data
  const leavesNoFee = value.ok && !insufficient && spendable !== undefined && value.raw > spendable
  const amountError = amount && !value.ok
    ? value.message
    : insufficient
      ? 'Amount is higher than your USDC balance.'
      : leavesNoFee
        ? `That leaves too little to pay the network fee (about ${formatUsdcDisplay(feeUsdc ?? 0n)} USDC). You can send up to ${formatUsdcDisplay(spendable ?? 0n)} USDC.`
        : null
  const ready = to.ok && value.ok && !insufficient && !leavesNoFee && balance.data !== undefined
  const reason = flowReason()
  const toSelf = to.ok && isAddressEqual(to.address, address)

  function flowReason(): string | null {
    if (ready) return null
    if (flow.isBusy) return 'A transaction is in progress.'
    if (!to.ok) return recipientError ? null : 'Enter a recipient address to continue.'
    if (!value.ok) return amountError ? null : 'Enter an amount to continue.'
    if (balance.isError) return null
    return amountError ? null : 'Waiting for your balance to load.'
  }

  const review = () => {
    if (!to.ok || !value.ok || flow.isBusy) return
    flow.open(withMeta(buildSendPlan(address, to.address, value.raw), { note: cleanNote(note), category }))
  }

  return (
    <>
      <Card className="space-y-5">
        <RecipientInput value={recipient} onChange={setRecipient} error={recipientError} disabled={flow.isBusy} />
        <ContactPicker owner={address} recipient={recipient} onPick={setRecipient} />
        <AmountInput
          value={amount}
          onChange={setAmount}
          balance={balance.data}
          balanceLabel="Wallet balance"
          balanceLoading={balance.isPending}
          balanceUnavailable={balance.isError}
          spendable={spendable}
          disabled={flow.isBusy}
          error={amountError}
        />
        <div className="space-y-3">
          <div>
            <label htmlFor={noteId} className="mb-2 block text-sm font-semibold text-ink-2">
              Note <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id={noteId}
              value={note}
              maxLength={NOTE_MAX}
              disabled={flow.isBusy}
              autoComplete="off"
              placeholder="Lunch payment, Internet bill…"
              onChange={(event) => setNote(event.target.value)}
              className="min-h-12 w-full rounded-2xl border border-line bg-surface-muted px-4 text-sm text-ink outline-none transition-colors placeholder:text-subtle focus:border-line-strong disabled:opacity-60"
            />
            <p className="mt-1.5 text-[11px] text-muted">Saved on this device with the transaction hash. It is not sent onchain.</p>
          </div>
          <CategoryChips value={category} onChange={setCategory} disabled={flow.isBusy} />
        </div>
        {balance.isError && (
          <Banner
            tone="danger"
            title="Balance unavailable"
            action={
              <Button variant="secondary" className="min-h-10" loading={balance.isFetching} onClick={() => void balance.refetch()}>
                Try again
              </Button>
            }
          >
            {classifyError(balance.error).message} Sending is disabled until your balance can be checked.
          </Banner>
        )}
        {toSelf && <Banner tone="info">This is your own address. The USDC will go back to you, minus the network fee.</Banner>}
        <Button className="w-full" disabled={!ready || flow.isBusy} onClick={review}>
          Review send
        </Button>
        <DisabledHint reason={reason} />
        <p className="text-center text-xs text-muted">Blockchain transfers are irreversible. Double-check the address before you confirm.</p>
      </Card>
      <LastTxCard tx={flow.lastConfirmed} />
      <TxDialog flow={flow} walletUsdc={balance.data} />
    </>
  )
}

export default function Send() {
  return (
    <>
      <PageHeader title="Send" subtitle="Send USDC to any address on Arc Mainnet. You review everything before your wallet is asked to sign." />
      <ConnectGate>{(address) => <SendForm address={address} />}</ConnectGate>
    </>
  )
}
