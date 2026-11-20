import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { NETWORK_LABEL, USDC } from '@/chain'
import { ActivityList } from '@/components/ActivityList'
import { ConnectGate } from '@/components/ConnectGate'
import { AmountInput } from '@/components/Inputs'
import { AddressCard, NetworkInfo } from '@/components/NetworkInfo'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, CopyButton, PageHeader, Skeleton } from '@/components/ui'
import { VaultGate } from '@/components/VaultStatus'
import { useActivity } from '@/hooks/useActivity'
import { useVaultAllowance, useWalletUsdc } from '@/hooks/useChainData'
import { useTxFlow } from '@/hooks/useTxFlow'
import { useVault } from '@/hooks/useVault'
import { useWallet } from '@/hooks/useWallet'
import { classifyError } from '@/lib/errors'
import { buildApprovePlan, buildDepositPlan } from '@/lib/plan'
import { checkAmount } from '@/lib/validate'

function FundWallet({ address }: { address: Address }) {
  const activity = useActivity(address)
  const incoming = activity.items.filter((item) => item.kind === 'receive').slice(0, 5)
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="display text-lg font-semibold">1. Fund your wallet</h2>
        <p className="mt-1 text-sm text-muted">Send USDC on {NETWORK_LABEL} to your address below, from an exchange or another wallet.</p>
      </div>
      <AddressCard address={address} />
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-2">
        <li>Choose USDC as the asset and {NETWORK_LABEL} as the network.</li>
        <li>Paste or scan the address above and double-check it.</li>
        <li>Send. Your balance updates once the transfer is confirmed onchain.</li>
      </ol>
      <div className="rounded-2xl border border-line bg-surface-muted p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">USDC token</p>
        <p className="mono mt-1.5 text-xs [overflow-wrap:anywhere]">{USDC.address}</p>
        <div className="mt-2.5">
          <CopyButton value={USDC.address} label="Copy token address" className="min-h-10" />
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer select-none font-semibold text-ink-2">Network details</summary>
        <div className="mt-2">
          <NetworkInfo />
        </div>
      </details>
      <div>
        <h3 className="text-sm font-semibold text-ink">Incoming USDC detected onchain</h3>
        {activity.isLoading ? (
          <Skeleton className="mt-2 h-12 w-full" />
        ) : activity.isError ? (
          <p className="mt-2 text-sm text-muted">{classifyError(activity.error).message}</p>
        ) : incoming.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No incoming transfers found in the scanned blocks. A deposit only appears here after it is confirmed onchain.</p>
        ) : (
          <ActivityList items={incoming} compact />
        )}
      </div>
    </Card>
  )
}

function VaultDeposit({ address }: { address: Address }) {
  const { isReady, isPaused } = useVault()
  const { isReady: walletReady } = useWallet()
  const [amount, setAmount] = useState('')
  const walletUsdc = useWalletUsdc(address)
  const allowance = useVaultAllowance(address, isReady)
  const flow = useTxFlow({
    onSuccess: (plan) => {
      if (plan.kind === 'deposit') setAmount('')
    },
  })
  const value = useMemo(() => checkAmount(amount), [amount])

  const insufficient = value.ok && walletUsdc.data !== undefined && value.raw > walletUsdc.data
  const amountError = amount && !value.ok ? value.message : insufficient ? 'Amount is higher than your wallet USDC balance.' : null
  const needsApproval = value.ok && allowance.data !== undefined && allowance.data < value.raw
  const ready = walletReady && isReady && !isPaused && value.ok && !insufficient && walletUsdc.data !== undefined && allowance.data !== undefined

  const review = () => {
    if (!value.ok || flow.isBusy) return
    flow.open(needsApproval ? buildApprovePlan(address, value.raw) : buildDepositPlan(address, value.raw))
  }

  return (
    <>
      <Card className="space-y-5">
        <div>
          <h2 className="display text-lg font-semibold">2. Add to your Arvexa vault</h2>
          <p className="mt-1 text-sm text-muted">Optional. Move USDC from your wallet into your personal vault balance. Only you can withdraw it.</p>
        </div>
        <VaultGate />
        {isPaused && <Banner tone="warn" title="Deposits are paused">The contract owner has paused new deposits. You can still withdraw.</Banner>}
        <AmountInput
          value={amount}
          onChange={setAmount}
          balance={walletUsdc.data}
          balanceLabel="Wallet balance"
          balanceLoading={walletUsdc.isPending}
          balanceUnavailable={walletUsdc.isError}
          disabled={flow.isBusy || !isReady || isPaused || !walletReady}
          error={amountError}
        />
        {isReady && allowance.isError && (
          <Banner tone="danger" title="Could not read your approval" action={<Button variant="secondary" className="min-h-10" onClick={() => void allowance.refetch()}>Try again</Button>}>
            {classifyError(allowance.error).message}
          </Banner>
        )}
        {needsApproval && <Banner tone="info">Step 1 of 2: approve exactly this amount for Arvexa. Then review and confirm the deposit.</Banner>}
        <Button className="w-full" disabled={!ready || flow.isBusy} onClick={review}>
          {needsApproval ? 'Review approval' : 'Review deposit'}
        </Button>
      </Card>
      <TxDialog flow={flow} walletUsdc={walletUsdc.data} />
    </>
  )
}

export default function Deposit() {
  return (
    <>
      <PageHeader title="Deposit" subtitle="Get USDC into your wallet, then optionally into your Arvexa vault." />
      <div className="space-y-5">
        <ConnectGate allowWrongNetwork>
          {(address) => (
            <>
              <FundWallet address={address} />
              <VaultDeposit address={address} />
            </>
          )}
        </ConnectGate>
      </div>
    </>
  )
}
