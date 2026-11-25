import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { NETWORK_LABEL, USDC } from '@/chain'
import { ActivityList } from '@/components/ActivityList'
import { ConnectGate } from '@/components/ConnectGate'
import { DisabledHint } from '@/components/DisabledHint'
import { AmountInput } from '@/components/Inputs'
import { LastTxCard } from '@/components/LastTxCard'
import { AddressCard, NetworkInfo } from '@/components/NetworkInfo'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, CopyButton, PageHeader, Skeleton } from '@/components/ui'
import { VaultGate } from '@/components/VaultStatus'
import { useActivity } from '@/hooks/useActivity'
import { useVaultAllowance, useWalletUsdc } from '@/hooks/useChainData'
import { useSpendableUsdc } from '@/hooks/useSpendable'
import { useTxFlow } from '@/hooks/useTxFlow'
import { useVault } from '@/hooks/useVault'
import { useWallet } from '@/hooks/useWallet'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { getArcClient } from '@/lib/rpc'
import { SWAP_TOKENS } from '@/lib/uniswap'
import { buildApprovePlan, buildDepositPlan } from '@/lib/plan'
import { checkAmount } from '@/lib/validate'

function AssetRow({ owner, symbol, name, address, decimals }: { owner: Address; symbol: string; name: string; address: Address; decimals: number }) {
  const isUsdc = address === USDC.address
  // USDC shares the wallet balance query used everywhere else, so it is read once, not twice.
  const usdcBalance = useWalletUsdc(isUsdc ? owner : undefined)
  const otherBalance = useQuery({
    queryKey: ['arvexa', 'token-balance', owner, address],
    enabled: !isUsdc,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: () => getArcClient().readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  })
  const balance = isUsdc ? usdcBalance : otherBalance
  return (
    <li className="rounded-2xl border border-line bg-surface-muted p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{symbol}</p>
          <p className="text-xs text-muted">{name} · {decimals} decimals</p>
        </div>
        <div className="text-right">
          {balance.isPending ? (
            <Skeleton className="ml-auto h-5 w-20" />
          ) : balance.isError ? (
            <span className="text-xs text-muted">Balance unavailable</span>
          ) : (
            <p className="text-sm font-semibold tabular-nums">{formatUsdcDisplay(balance.data)} {symbol}</p>
          )}
          <p className="text-[11px] text-subtle">{isUsdc ? 'Vault, Send, activity' : 'Held in wallet, swap only'}</p>
        </div>
      </div>
    </li>
  )
}

function SupportedAssets({ address }: { address: Address }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">Supported assets on {NETWORK_LABEL}</h3>
      <ul className="mt-2 space-y-2">
        {SWAP_TOKENS.map((token) => (
          <AssetRow key={token.address} owner={address} symbol={token.symbol} name={token.name} address={token.address} decimals={token.decimals} />
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Only USDC can go into the Arvexa vault and appear in Activity. EURC can be held in your wallet and swapped. Do not send any other token to this address.</p>
    </div>
  )
}

function FundWallet({ address }: { address: Address }) {
  const { vault } = useVault()
  const activity = useActivity(address)
  const incoming = activity.items.filter((item) => item.kind === 'receive').slice(0, 5)
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="display text-lg font-semibold">{vault.state === 'missing' ? 'Fund your wallet' : '1. Fund your wallet'}</h2>
        <p className="mt-1 text-sm text-muted">Send USDC on {NETWORK_LABEL} to your address below, from an exchange or another wallet.</p>
      </div>
      <AddressCard address={address} />
      <SupportedAssets address={address} />
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
  const { isReady, isPaused, configured, vault } = useVault()
  const { isReady: walletReady } = useWallet()
  const [amount, setAmount] = useState('')
  const { balance: walletUsdc, spendable, feeUsdc } = useSpendableUsdc(address)
  const allowance = useVaultAllowance(address, configured)
  const flow = useTxFlow({
    onSuccess: (plan) => {
      if (plan.kind === 'deposit') setAmount('')
    },
  })
  const value = useMemo(() => checkAmount(amount), [amount])

  const insufficient = value.ok && walletUsdc.data !== undefined && value.raw > walletUsdc.data
  const leavesNoFee = value.ok && !insufficient && spendable !== undefined && value.raw > spendable
  const amountError = amount && !value.ok
    ? value.message
    : insufficient
      ? 'Amount is higher than your wallet USDC balance.'
      : leavesNoFee
        ? `That leaves too little to pay the network fee (about ${formatUsdcDisplay(feeUsdc ?? 0n)} USDC). You can deposit up to ${formatUsdcDisplay(spendable ?? 0n)} USDC.`
        : null
  const needsApproval = value.ok && allowance.data !== undefined && allowance.data < value.raw
  const ready = walletReady && isReady && !isPaused && value.ok && !insufficient && !leavesNoFee && walletUsdc.data !== undefined && allowance.data !== undefined

  const reason = ready
    ? null
    : flow.isBusy
      ? 'A transaction is in progress.'
      : !walletReady
        ? 'Switch your wallet to Arc Mainnet to deposit.'
        : !isReady
          ? 'The Arvexa vault contract is not verified yet, so vault deposits are disabled.'
          : isPaused
            ? 'Deposits are paused by the contract owner.'
            : !value.ok
              ? amountError
                ? null
                : 'Enter an amount to continue.'
              : amountError
                ? null
                : walletUsdc.data === undefined || allowance.data === undefined
                  ? 'Reading your balance and approval.'
                  : null

  const review = () => {
    if (!value.ok || flow.isBusy) return
    flow.open(needsApproval ? buildApprovePlan(address, value.raw) : buildDepositPlan(address, value.raw))
  }

  // No vault contract configured: there is nothing to deposit into, so the vault section is not shown at all.
  if (vault.state === 'missing') return null

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
          spendable={spendable}
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
        <DisabledHint reason={reason} />
      </Card>
      <LastTxCard tx={flow.lastConfirmed} />
      <TxDialog flow={flow} walletUsdc={walletUsdc.data} />
    </>
  )
}

export default function Deposit() {
  const { vault } = useVault()
  return (
    <>
      <PageHeader title="Deposit" subtitle={vault.state === 'missing' ? 'Get USDC into your wallet on Arc Mainnet.' : 'Get USDC into your wallet, then optionally into your Arvexa vault.'} />
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
