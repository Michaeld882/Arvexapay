import { useMemo, useState } from 'react'
import { isAddressEqual, type Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { AmountInput, RecipientInput } from '@/components/Inputs'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, PageHeader } from '@/components/ui'
import { useWalletUsdc } from '@/hooks/useChainData'
import { useTxFlow } from '@/hooks/useTxFlow'
import { classifyError } from '@/lib/errors'
import { buildSendPlan } from '@/lib/plan'
import { checkAmount, checkRecipient } from '@/lib/validate'

function SendForm({ address }: { address: Address }) {
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const balance = useWalletUsdc(address)
  const flow = useTxFlow({
    onSuccess: () => {
      setRecipient('')
      setAmount('')
    },
  })

  const to = useMemo(() => checkRecipient(recipient), [recipient])
  const value = useMemo(() => checkAmount(amount), [amount])

  const recipientError = recipient && !to.ok ? to.message : null
  const insufficient = value.ok && balance.data !== undefined && value.raw > balance.data
  const amountError = amount && !value.ok ? value.message : insufficient ? 'Amount is higher than your USDC balance.' : null
  const ready = to.ok && value.ok && !insufficient && balance.data !== undefined
  const toSelf = to.ok && isAddressEqual(to.address, address)

  const review = () => {
    if (!to.ok || !value.ok || flow.isBusy) return
    flow.open(buildSendPlan(address, to.address, value.raw))
  }

  return (
    <>
      <Card className="space-y-5">
        <RecipientInput value={recipient} onChange={setRecipient} error={recipientError} disabled={flow.isBusy} />
        <AmountInput
          value={amount}
          onChange={setAmount}
          balance={balance.data}
          balanceLabel="Wallet balance"
          balanceLoading={balance.isPending}
          balanceUnavailable={balance.isError}
          disabled={flow.isBusy}
          error={amountError}
        />
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
        <p className="text-center text-xs text-muted">Blockchain transfers are irreversible. Double-check the address before you confirm.</p>
      </Card>
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
