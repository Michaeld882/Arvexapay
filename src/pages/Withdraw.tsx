import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { AmountInput, RecipientInput } from '@/components/Inputs'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, PageHeader } from '@/components/ui'
import { VaultGate } from '@/components/VaultStatus'
import { useVaultBalance, useWalletUsdc } from '@/hooks/useChainData'
import { useTxFlow } from '@/hooks/useTxFlow'
import { useVault } from '@/hooks/useVault'
import { classifyError } from '@/lib/errors'
import { buildWithdrawPlan } from '@/lib/plan'
import { checkAmount, checkRecipient } from '@/lib/validate'

function WithdrawForm({ address }: { address: Address }) {
  const { isReady } = useVault()
  const [recipient, setRecipient] = useState<string>(address)
  const [amount, setAmount] = useState('')
  const vaultBalance = useVaultBalance(address, isReady)
  const walletUsdc = useWalletUsdc(address)
  const flow = useTxFlow({ onSuccess: () => setAmount('') })

  const to = useMemo(() => checkRecipient(recipient), [recipient])
  const value = useMemo(() => checkAmount(amount), [amount])

  const insufficient = value.ok && vaultBalance.data !== undefined && value.raw > vaultBalance.data
  const recipientError = recipient && !to.ok ? to.message : null
  const amountError = amount && !value.ok ? value.message : insufficient ? 'Amount is higher than your vault balance.' : null
  const ready = isReady && to.ok && value.ok && !insufficient && vaultBalance.data !== undefined

  const review = () => {
    if (!to.ok || !value.ok || flow.isBusy) return
    flow.open(buildWithdrawPlan(address, to.address, value.raw))
  }

  return (
    <>
      <div className="space-y-4">
        <VaultGate />
        <Card className="space-y-5">
          <RecipientInput label="Withdraw to" value={recipient} onChange={setRecipient} error={recipientError} disabled={flow.isBusy || !isReady} />
          <AmountInput
            value={amount}
            onChange={setAmount}
            balance={isReady ? vaultBalance.data : undefined}
            balanceLabel="Vault balance"
            balanceLoading={isReady && vaultBalance.isPending}
            balanceUnavailable={!isReady || vaultBalance.isError}
            disabled={flow.isBusy || !isReady}
            error={amountError}
          />
          {isReady && vaultBalance.isError && (
            <Banner
              tone="danger"
              title="Vault balance unavailable"
              action={
                <Button variant="secondary" className="min-h-10" loading={vaultBalance.isFetching} onClick={() => void vaultBalance.refetch()}>
                  Try again
                </Button>
              }
            >
              {classifyError(vaultBalance.error).message}
            </Banner>
          )}
          {isReady && vaultBalance.data === 0n && <Banner tone="info">Your vault balance is empty. Deposit USDC first to withdraw it.</Banner>}
          <Button className="w-full" disabled={!ready || flow.isBusy} onClick={review}>
            Review withdrawal
          </Button>
          <p className="text-center text-xs text-muted">Withdrawals only ever pay out your own vault balance. Nobody else can move it.</p>
        </Card>
      </div>
      <TxDialog flow={flow} walletUsdc={walletUsdc.data} />
    </>
  )
}

export default function Withdraw() {
  return (
    <>
      <PageHeader title="Withdraw" subtitle="Move USDC from your Arvexa vault to any address. Withdrawals stay available even if deposits are paused." />
      <ConnectGate>{(address) => <WithdrawForm address={address} />}</ConnectGate>
    </>
  )
}
