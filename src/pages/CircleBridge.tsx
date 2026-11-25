import { useMemo, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { Address } from 'viem'
import { NETWORK_NAME, explorerTxUrl } from '@/chain'
import { canCheckArrival, findUnsettledDuplicate, isResumable, recoveryAdvice, transferStore, type TransferRecord } from '@/circle/cctp'
import { CIRCLE_CONFIG, type TransferSpeed } from '@/circle/config'
import { useBridgeFlow, useChainUsdcBalance, useTransferQuote } from '@/circle/hooks'
import { chainKey, type EvmChain } from '@/circle/sdk'
import { useCctpChains } from '@/circle/status'
import { ExternalTx, FeeRows, StepList } from '@/circle/ui'
import { ConnectGate } from '@/components/ConnectGate'
import { AmountInput } from '@/components/Inputs'
import { Banner, Button, Card, PageHeader, Row, Skeleton, cx } from '@/components/ui'
import { classifyError } from '@/lib/errors'
import { formatTimestamp, shortAddress } from '@/lib/format'
import { checkAmount } from '@/lib/validate'
import { formatUsdc } from '@/onchain-money'

const SPEEDS: ReadonlyArray<{ id: TransferSpeed; label: string; time: string }> = [
  { id: 'FAST', label: 'Fast', time: 'about 20 seconds' },
  { id: 'SLOW', label: 'Standard', time: 'about 15 to 19 minutes' },
]

interface CardActions {
  onResume: (record: TransferRecord) => void
  onRecheck: (record: TransferRecord) => void
  onDismiss: (record: TransferRecord) => void
  busy: boolean
  runningId: string | undefined
}

function badge(record: TransferRecord, interrupted: boolean): { label: string; className: string } {
  if (record.state === 'success') return { label: 'Complete', className: 'bg-accent-soft text-accent-hover' }
  if (record.state === 'confirming') return { label: 'Confirming on Arc', className: 'bg-surface-muted text-ink-2' }
  if (record.state === 'unconfirmed') return { label: 'Not confirmed yet', className: 'bg-surface-muted text-warn' }
  if (record.state === 'error') return { label: 'Stopped', className: 'text-danger' }
  return interrupted ? { label: 'Interrupted', className: 'text-danger' } : { label: 'In progress', className: 'bg-surface-muted text-ink-2' }
}

function TransferCard({ record, onResume, onRecheck, onDismiss, busy, runningId }: CardActions & { record: TransferRecord }) {
  const interrupted = record.state === 'pending' && runningId !== record.id
  const advice = recoveryAdvice(record, interrupted)
  const tag = badge(record, interrupted)
  const settled = record.state === 'success' || interrupted || record.state === 'error' || record.state === 'unconfirmed'
  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg font-semibold">
            {record.amount} USDC from {record.sourceName}
          </h2>
          <p className="text-xs text-muted">{formatTimestamp(Math.floor(record.createdAt / 1000))}</p>
        </div>
        <span className={cx('rounded-full px-2.5 py-1 text-[11px] font-semibold', tag.className)}>{tag.label}</span>
      </div>
      <StepList record={record} />
      {record.state === 'success' && record.mintHash && (
        <Banner tone="success" title="USDC minted on Arc">
          <span className="block">
            Received {record.received} USDC at your address. Arc Mainnet shows the mint transaction: <ExternalTx url={explorerTxUrl(record.mintHash)} hash={record.mintHash} />
          </span>
          {record.received !== undefined && record.received !== record.amount && <span className="mt-1 block text-xs">The difference from {record.amount} USDC is the Circle fee.</span>}
        </Banner>
      )}
      {advice && (
        <Banner
          tone={advice.tone}
          title={advice.title}
          action={
            settled ? (
              <div className="flex flex-wrap gap-2">
                {isResumable(record) && !interrupted && (
                  <Button variant="secondary" className="min-h-10" disabled={busy} onClick={() => onResume(record)}>
                    Resume transfer
                  </Button>
                )}
                {canCheckArrival(record) && (
                  <Button variant="secondary" className="min-h-10" disabled={busy} loading={runningId === record.id} onClick={() => onRecheck(record)}>
                    Check Arc for the mint
                  </Button>
                )}
                {!burnedOrActive(record) && (
                  <Button variant="ghost" className="min-h-10" disabled={busy} onClick={() => onDismiss(record)}>
                    Dismiss
                  </Button>
                )}
              </div>
            ) : undefined
          }
        >
          {advice.body}
        </Banner>
      )}
    </Card>
  )
}

/** A transfer whose burn happened (or may have) is kept on screen so its hashes are never lost. */
function burnedOrActive(record: TransferRecord): boolean {
  return record.steps.some((step) => step.name === 'burn' && (step.state === 'success' || Boolean(step.txHash))) || record.state === 'confirming'
}

function BridgeForm({ address }: { address: Address }) {
  const chains = useCctpChains()
  const [sourceId, setSourceId] = useState('')
  const [amount, setAmount] = useState('')
  const [speed, setSpeed] = useState<TransferSpeed>(CIRCLE_CONFIG.transferSpeed)
  const [forwarderChoice, setForwarderChoice] = useState<boolean | undefined>()
  const records = transferStore.useRecords(address)
  const flow = useBridgeFlow(chains.data, address)

  const sources = chains.data?.sources
  const source: EvmChain | undefined = useMemo(
    () => sources?.find((chain) => chainKey(chain) === sourceId) ?? sources?.find((chain) => chainKey(chain) === 'Ethereum') ?? sources?.[0],
    [sources, sourceId],
  )
  const forwarderAvailable = Boolean(chains.data?.destination.cctp?.forwarderSupported.destination)
  const useForwarder = forwarderAvailable && (forwarderChoice ?? CIRCLE_CONFIG.useForwarder)

  const balance = useChainUsdcBalance(source, address)
  const value = useMemo(() => checkAmount(amount), [amount])
  const insufficient = value.ok && balance.data !== undefined && value.raw > balance.data
  const amountError = amount && !value.ok ? value.message : insufficient ? `Amount is higher than your USDC balance on ${source?.name}.` : null
  const ready = value.ok && !insufficient && balance.data !== undefined && Boolean(source)
  const amountText = value.ok ? formatUsdc(value.raw) : ''
  // The same transfer must never burn twice: an earlier burn of this amount that has not settled blocks a new one.
  const duplicate = value.ok && source ? findUnsettledDuplicate(records, { sourceChain: chainKey(source), amount: amountText }) : undefined
  const canStart = ready && !duplicate
  const reason = flow.isBusy
    ? 'A transfer is running. Keep this tab open until it finishes.'
    : !amount
      ? 'Enter an amount to bridge.'
      : balance.isPending
        ? `Loading your USDC balance on ${source?.name ?? 'the source chain'}.`
        : balance.isError
          ? `Your USDC balance on ${source?.name ?? 'the source chain'} could not be read, so bridging is paused. Try again in a moment.`
          : duplicate
            ? `A ${amountText} USDC transfer from ${source?.name} was already burned and has not finished. Resume it, check Arc for the mint, or wait for it to settle before starting another.`
            : null

  const quote = useTransferQuote(chains.data, { source, amount: amountText, recipient: address, speed, useForwarder, ready })
  const quoteLines = quote.data ? [...quote.data.fees, ...quote.data.gas] : undefined
  const large = value.ok && Number(amountText) > CIRCLE_CONFIG.largeTransferUsdc
  const active = records.find((record) => record.id === flow.busyId)
  const speedTime = SPEEDS.find((item) => item.id === speed)?.time

  if (chains.isPending) return <Card className="space-y-3" aria-busy><Skeleton className="h-6 w-40" /><Skeleton className="h-24 w-full" /></Card>
  if (chains.isError || !chains.data || !source) {
    return (
      <Banner tone="danger" title="Could not load Circle CCTP routes" action={<Button variant="secondary" className="min-h-10" loading={chains.isFetching} onClick={() => void chains.refetch()}>Try again</Button>}>
        {chains.error ? classifyError(chains.error).message : 'No source chains are available.'}
      </Banner>
    )
  }

  const bridge = () => {
    if (!canStart || flow.isBusy || !value.ok) return
    void flow.start({ source, amount: amountText, recipient: address, speed, useForwarder })
  }

  return (
    <div className="space-y-5">
      <Card className="space-y-5">
        <div>
          <label htmlFor="cctp-source" className="mb-2 block text-sm font-semibold text-ink-2">From</label>
          <select
            id="cctp-source"
            value={chainKey(source)}
            disabled={flow.isBusy}
            onChange={(event) => setSourceId(event.target.value)}
            className="min-h-12 w-full rounded-2xl border border-line bg-surface-muted px-3 text-sm font-semibold text-ink outline-none focus:border-line-strong disabled:opacity-60"
          >
            {chains.data.sources.map((chain) => (
              <option key={chainKey(chain)} value={chainKey(chain)}>
                {chain.name}
              </option>
            ))}
          </select>
        </div>
        <AmountInput
          value={amount}
          onChange={setAmount}
          balance={balance.data}
          balanceLabel={`${source.name} balance`}
          balanceLoading={balance.isPending}
          balanceUnavailable={balance.isError}
          disabled={flow.isBusy}
          error={amountError}
        />
        <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          <ArrowDown className="size-4" />
          <span className="h-px flex-1 bg-line" />
        </div>
        <div className="rounded-2xl border border-line bg-surface-muted p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">To</p>
          <p className="mt-1 text-sm font-semibold">{NETWORK_NAME} (USDC, minted natively)</p>
          <p className="mono mt-1 text-xs text-muted">{shortAddress(address, 10, 6)} (your wallet)</p>
        </div>
        <div role="radiogroup" aria-label="Transfer speed" className="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface-muted p-1">
          {SPEEDS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={speed === item.id}
              disabled={flow.isBusy}
              onClick={() => setSpeed(item.id)}
              className={cx('min-h-10 rounded-xl text-sm font-semibold transition-colors duration-200 disabled:opacity-45', speed === item.id ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:bg-surface')}
            >
              {item.label}
            </button>
          ))}
        </div>
        {forwarderAvailable && (
          <label className="flex min-h-11 items-start gap-3 text-sm text-ink-2">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={useForwarder} disabled={flow.isBusy} onChange={(event) => setForwarderChoice(event.target.checked)} />
            <span>Let Circle submit the mint on Arc. You do not need USDC for gas on Arc, and Circle adds a small forwarding fee.</span>
          </label>
        )}
        <dl className="divide-y divide-line">
          <Row label="Route">{source.name} to {NETWORK_NAME}</Row>
          <Row label="Amount">{amountText ? `${amountText} USDC` : '—'}</Row>
          <Row label="Arrival">{speedTime}</Row>
          <FeeRows lines={quoteLines} loading={ready && quote.isFetching} error={quote.isError ? 'Circle could not quote this route right now. You can still bridge; the fee is shown as the steps run.' : undefined} />
        </dl>
        <Banner tone="warn" title="Real USDC moves">
          This burns USDC on {source.name} and mints it on Arc Mainnet. It cannot be undone.
          {!useForwarder && ' You also need a little USDC on Arc to pay gas for the mint.'}
        </Banner>
        {large && <Banner tone="warn" title="Large transfer">This is more than {CIRCLE_CONFIG.largeTransferUsdc} USDC. Check the chains and amount, then consider a small test transfer first.</Banner>}
        {flow.startError && !active && <Banner tone="danger" title="Could not start the transfer">{flow.startError}</Banner>}
        <Button className="w-full" disabled={!canStart || flow.isBusy} loading={flow.isBusy} onClick={bridge}>
          {flow.isBusy ? 'Transfer in progress' : amountText ? `Bridge ${amountText} USDC to Arc` : 'Enter an amount'}
        </Button>
        <p className="text-center text-xs text-muted" aria-live="polite">{reason ?? `Your wallet will ask you to switch to ${source.name}, approve USDC, and sign the burn.`}</p>
      </Card>

      {records.map((record) => (
        <TransferCard
          key={record.id}
          record={record}
          onResume={(item) => void flow.resume(item)}
          onRecheck={(item) => void flow.recheck(item)}
          onDismiss={(item) => void flow.dismiss(item)}
          busy={flow.isBusy}
          runningId={flow.busyId}
        />
      ))}
    </div>
  )
}

export default function CircleBridge() {
  return (
    <>
      <PageHeader title="Bridge USDC to Arc" subtitle="Native Circle CCTP transfers. USDC is burned on the source chain and minted on Arc. There is no liquidity pool." />
      {CIRCLE_CONFIG.cctpEnabled ? (
        <ConnectGate allowWrongNetwork>{(address) => <BridgeForm address={address} />}</ConnectGate>
      ) : (
        <Banner tone="warn" title="CCTP is turned off">Set VITE_CIRCLE_CCTP_ENABLED to true to enable it.</Banner>
      )}
    </>
  )
}
