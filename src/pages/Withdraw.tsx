import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { ConnectGate } from '@/components/ConnectGate'
import { DisabledHint } from '@/components/DisabledHint'
import { AmountInput, RecipientInput } from '@/components/Inputs'
import { LastTxCard } from '@/components/LastTxCard'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, PageHeader, cx } from '@/components/ui'
import { VaultGate } from '@/components/VaultStatus'
import { useVaultBalance } from '@/hooks/useChainData'
import { useSpendableUsdc } from '@/hooks/useSpendable'
import { useTxFlow } from '@/hooks/useTxFlow'
import { useVault } from '@/hooks/useVault'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { WALLET_WITHDRAW_LABELS, buildSendPlan, buildWithdrawPlan } from '@/lib/plan'
import { checkAmount, checkRecipient } from '@/lib/validate'

type Source = 'wallet' | 'vault'

const SOURCES: ReadonlyArray<{ id: Source; label: string }> = [
  { id: 'wallet', label: 'Wallet USDC' },
  { id: 'vault', label: 'Arvexa vault' },
]

function WithdrawForm({ address }: { address: Address }) {
  const { isReady, configured, vault } = useVault()
  // With no vault contract configured there is nothing to choose: show the wallet withdrawal on its own.
  const showVault = vault.state !== 'missing'
  const [chosen, setChosen] = useState<Source | null>(null)
  // Wallet withdrawals work on any network-verified wallet; the vault needs a verified contract.
  const source: Source = chosen ?? (isReady ? 'vault' : 'wallet')
  const fromVault = source === 'vault'

  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const { balance: wallet, spendable, feeUsdc } = useSpendableUsdc(address)
  const vaultBalance = useVaultBalance(address, configured)
  const flow = useTxFlow({ onSuccess: () => setAmount('') })

  const to = useMemo(() => checkRecipient(recipient), [recipient])
  const value = useMemo(() => checkAmount(amount), [amount])

  const available = fromVault ? vaultBalance.data : wallet.data
  const insufficient = value.ok && available !== undefined && value.raw > available
  const leavesNoFee = !fromVault && value.ok && !insufficient && spendable !== undefined && value.raw > spendable
  const recipientError = recipient && !to.ok ? to.message : null
  const amountError = amount && !value.ok
    ? value.message
    : insufficient
      ? fromVault
        ? 'Amount is higher than your vault balance.'
        : 'Amount is higher than your wallet USDC balance.'
      : leavesNoFee
        ? `That leaves too little to pay the network fee (about ${formatUsdcDisplay(feeUsdc ?? 0n)} USDC). You can withdraw up to ${formatUsdcDisplay(spendable ?? 0n)} USDC.`
        : null
  const ready = to.ok && value.ok && !insufficient && !leavesNoFee && available !== undefined && (!fromVault || isReady)

  const reason = ready
    ? null
    : flow.isBusy
      ? 'A transaction is in progress.'
      : fromVault && !isReady
        ? 'The Arvexa vault contract is not verified, so vault withdrawals are disabled. You can still withdraw from your wallet.'
        : !to.ok
          ? recipientError
            ? null
            : 'Enter a recipient address to continue.'
          : !value.ok
            ? amountError
              ? null
              : 'Enter an amount to continue.'
            : available === undefined && !(fromVault ? vaultBalance.isError : wallet.isError)
              ? 'Waiting for your balance to load.'
              : null

  const review = () => {
    if (!to.ok || !value.ok || flow.isBusy) return
    flow.open(fromVault ? buildWithdrawPlan(address, to.address, value.raw) : buildSendPlan(address, to.address, value.raw, WALLET_WITHDRAW_LABELS))
  }

  const balanceError = fromVault ? isReady && vaultBalance.isError : wallet.isError
  const retry = fromVault ? vaultBalance : wallet

  return (
    <>
      <div className="space-y-4">
        {showVault && (
        <div role="radiogroup" aria-label="Withdraw from" className="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface-muted p-1">
          {SOURCES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={source === id}
              disabled={flow.isBusy || (id === 'vault' && !isReady)}
              onClick={() => setChosen(id)}
              className={cx(
                'min-h-10 rounded-xl text-sm font-semibold transition-[background-color,color,transform] duration-200 active:scale-[0.97] disabled:opacity-45',
                source === id ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:bg-surface',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        )}
        {showVault && (fromVault || !isReady) && <VaultGate />}
        <Card className="space-y-5">
          <RecipientInput label="Withdraw to" value={recipient} onChange={setRecipient} error={recipientError} disabled={flow.isBusy} />
          <AmountInput
            value={amount}
            onChange={setAmount}
            balance={available}
            balanceLabel={fromVault ? 'Vault balance' : 'Wallet balance'}
            balanceLoading={fromVault ? isReady && vaultBalance.isPending : wallet.isPending}
            balanceUnavailable={fromVault ? !isReady || vaultBalance.isError : wallet.isError}
            spendable={fromVault ? undefined : spendable}
            disabled={flow.isBusy || (fromVault && !isReady)}
            error={amountError}
          />
          {balanceError && (
            <Banner
              tone="danger"
              title="Balance unavailable"
              action={
                <Button variant="secondary" className="min-h-10" loading={retry.isFetching} onClick={() => void retry.refetch()}>
                  Try again
                </Button>
              }
            >
              {classifyError(retry.error).message} Withdrawing is disabled until your balance can be checked.
            </Banner>
          )}
          {fromVault && isReady && vaultBalance.data === 0n && <Banner tone="info">Your vault balance is empty. Deposit USDC first to withdraw it.</Banner>}
          <Button className="w-full" disabled={!ready || flow.isBusy} onClick={review}>
            Review withdrawal
          </Button>
          <DisabledHint reason={reason} />
          <p className="text-center text-xs text-muted">
            {fromVault
              ? 'Vault withdrawals only ever pay out your own vault balance. Nobody else can move it.'
              : 'Transfers are irreversible. Double-check the address, and only use Arc Mainnet addresses.'}
          </p>
        </Card>
      </div>
      <LastTxCard tx={flow.lastConfirmed} />
      <TxDialog flow={flow} walletUsdc={wallet.data} />
    </>
  )
}

export default function Withdraw() {
  const { vault } = useVault()
  return (
    <>
      <PageHeader
        title="Withdraw"
        subtitle={`Send USDC out to any address${vault.state === 'missing' ? '' : ', from your wallet or your Arvexa vault'}. You review everything before your wallet is asked to sign.`}
      />
      <ConnectGate>{(address) => <WithdrawForm address={address} />}</ConnectGate>
    </>
  )
}
