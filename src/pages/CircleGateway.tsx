import { useCallback, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { CIRCLE_CONFIG } from '@/circle/config'
import { describeCircleError } from '@/circle/errors'
import { gatewayLock } from '@/circle/locks'
import { estimateDeposit, estimateSpend, gatewayStore, recheckGatewayRecord, runDeposit, runSpend, type GatewayRecord } from '@/circle/gateway'
import { GuardianStatus, Pill } from '@/components/GuardianStatus'
import { gatewayChainReads, gatewayFingerprint, gatewayGuardianPhase, runGatewayPreflight, syncGatewaySubmission, type GatewayPreflightInput } from '@/guardian/gateway'
import { findInFlightDuplicate } from '@/guardian/lock'
import type { GuardianReport, GuardianView } from '@/guardian/types'
import { Check, Clock, ShieldCheck } from 'lucide-react'
import { useChainUsdcBalance, useDebounced, useGatewayBalance, useLeaveWarning, useWalletAdapter } from '@/circle/hooks'
import { chainKey, feeLabel, switchWalletChain, type EvmChain, type WalletAdapter } from '@/circle/sdk'
import { useGatewayChains } from '@/circle/status'
import { ExternalTx, FeeRows } from '@/circle/ui'
import { ConnectGate } from '@/components/ConnectGate'
import { AmountInput } from '@/components/Inputs'
import { Banner, Button, Card, PageHeader, Row, Skeleton, cx } from '@/components/ui'
import { VAULT_LABEL } from '@/components/VaultStatus'
import { useBalances } from '@/hooks/useBalances'
import { useVault } from '@/hooks/useVault'
import { classifyError } from '@/lib/errors'
import { formatTimestamp, formatUsdcDisplay } from '@/lib/format'
import { checkAmount } from '@/lib/validate'
import { formatUsdc, parseUsdc } from '@/onchain-money'

type Mode = 'deposit' | 'spend'

function toRaw(value: string | undefined): bigint | undefined {
  if (!value) return 0n
  try {
    return parseUsdc(value)
  } catch {
    return undefined
  }
}

/** Three separate places USDC can be. They are shown side by side and never added together. */
function BalanceCard({ address }: { address: Address }) {
  const gateway = useGatewayBalance(address)
  const balances = useBalances(address)
  const { vault } = useVault()
  const total = toRaw(gateway.data?.total)
  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Gateway balance</p>
          <p className="mt-1 text-xs text-muted">USDC held in Circle Gateway, usable on any supported chain.</p>
        </div>
        <button
          type="button"
          onClick={() => void gateway.refetch()}
          disabled={gateway.isFetching}
          aria-label="Refresh Gateway balance"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-2 hover:text-ink disabled:opacity-60"
        >
          <RefreshCw className={cx('size-3.5', gateway.isFetching && 'animate-spin')} aria-hidden />
        </button>
      </div>
      {gateway.isPending ? (
        <Skeleton className="h-11 w-48" />
      ) : gateway.isError ? (
        <Banner tone="danger" title="Could not load the Gateway balance" action={<Button variant="secondary" className="min-h-10" onClick={() => void gateway.refetch()}>Try again</Button>}>
          {classifyError(gateway.error).message} No balance is shown until it loads.
        </Banner>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span data-testid="gateway-balance" className="display text-4xl font-semibold tabular-nums">{total === undefined ? gateway.data.total : formatUsdcDisplay(total)}</span>
            <span className="text-lg font-medium text-subtle">USDC in Gateway</span>
          </p>
          {gateway.data.pending && <p className="text-sm text-warn">{gateway.data.pending} USDC pending. A top up counts after its source chain finalizes.</p>}
          {gateway.data.chains.length === 0 ? (
            <p className="text-sm text-muted">Nothing has been topped up in Gateway yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-2xl border border-line bg-surface-muted px-3.5" aria-label="Gateway balance by chain">
              {gateway.data.chains.map((item) => (
                <li key={item.chain} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="text-muted">{item.chain.replace(/_/g, ' ')}</span>
                  <span className="font-medium tabular-nums">{item.confirmed} USDC</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="rounded-2xl border border-dashed border-line px-3.5 py-1">
        <p className="pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">Not in Gateway</p>
        <dl className="divide-y divide-line">
          <Row label="Wallet USDC on Arc">{balances.walletRaw === undefined ? '—' : `${formatUsdcDisplay(balances.walletRaw)} USDC`}</Row>
          <Row label="Arvexa vault">
            {balances.vaultReady ? (balances.vaultRaw === undefined ? '—' : `${formatUsdcDisplay(balances.vaultRaw)} USDC`) : <span className="text-muted">{VAULT_LABEL[vault.state]}</span>}
          </Row>
        </dl>
      </div>
    </Card>
  )
}

function useGatewayAction() {
  const getAdapter = useWalletAdapter()
  const queryClient = useQueryClient()
  const busy = gatewayLock.useActive() !== undefined
  const [error, setError] = useState<string | undefined>()
  const [guardian, setGuardian] = useState<GuardianView>({ status: 'idle' })
  useLeaveWarning(busy)
  const run = useCallback(
    async (known: readonly EvmChain[], switchTo: EvmChain | undefined, action: (adapter: WalletAdapter) => Promise<GatewayRecord>, back: EvmChain, guard?: (adapter: WalletAdapter) => Promise<GuardianReport>) => {
      if (!gatewayLock.tryAcquire('operation')) return
      setError(undefined)
      try {
        const { provider, adapter: quoting } = await getAdapter(known)
        if (guard) {
          // Check the request before anything is signed. A blocked request never reaches the wallet.
          setGuardian({ status: 'checking' })
          const report = await guard(quoting)
          setGuardian({ status: 'done', report })
          if (report.verdict === 'blocked') {
            setError(report.reason ?? 'This request did not pass the safety checks. Nothing was sent.')
            return
          }
        }
        // Deposits happen on the source chain: switch first, then build the adapter for that chain.
        if (switchTo) await switchWalletChain(provider, switchTo, known)
        const { adapter } = await getAdapter(known)
        const record = await action(adapter)
        await switchWalletChain(provider, back, known).catch(() => undefined)
        if (record.state === 'success') {
          void queryClient.invalidateQueries({ queryKey: ['circle', 'gateway-balance'] })
          void queryClient.invalidateQueries({ queryKey: ['arvexa', 'usdc-balance'] })
          void queryClient.invalidateQueries({ queryKey: ['circle', 'chain-usdc'] })
        }
      } catch (err) {
        setError(describeCircleError(err))
      } finally {
        gatewayLock.release('operation')
      }
    },
    [getAdapter, queryClient],
  )
  return { run, busy, error, guardian, clearGuardian: () => setGuardian({ status: 'idle' }) }
}

const STATUS_TEXT: Record<GatewayRecord['kind'], Record<GatewayRecord['state'], { title: string; body: (r: GatewayRecord) => string }>> = {
  deposit: {
    pending: { title: 'Top up in progress', body: (r) => (r.txHash ? `Submitted on ${r.chainName}. Waiting for it to be confirmed on the chain.` : `Approve the request in your wallet. Keep this tab open until it finishes.`) },
    unconfirmed: { title: 'Top up not confirmed yet', body: (r) => r.error ?? 'Check again in a moment.' },
    success: { title: 'Top up confirmed', body: (r) => `Your ${r.amount} USDC is confirmed on ${r.chainName}. It joins your Gateway balance after that chain finalizes, and shows as pending until then.` },
    error: { title: 'Top up stopped', body: (r) => `${r.error ?? 'The top up did not complete.'} No success was assumed.` },
  },
  spend: {
    pending: { title: 'Spend in progress', body: (r) => (r.txHash ? 'Circle submitted the mint. Reading Arc to confirm it.' : 'Sign the request in your wallet. Circle then mints USDC on Arc. Keep this tab open.') },
    unconfirmed: { title: 'Mint not confirmed on Arc yet', body: (r) => r.error ?? 'Check again in a moment.' },
    success: { title: 'USDC minted on Arc', body: (r) => `${r.amount} USDC left your Gateway balance and Arc Mainnet shows the mint to your wallet.` },
    error: { title: 'Spend stopped', body: (r) => `${r.error ?? 'The spend did not complete.'} No success was assumed.` },
  },
}

/** Monitoring while the request is in flight; Verified only after the chain read-back (the deposit receipt, or the Arc mint). */
function GatewayGuardianPill({ record }: { record: GatewayRecord }) {
  const phase = gatewayGuardianPhase(record)
  if (phase === 'VERIFIED') return <Pill tone="good" icon={ShieldCheck}>Verified</Pill>
  if (phase === 'CONFIRMED') return <Pill tone="info" icon={Check}>Confirmed, result not verified</Pill>
  if (phase === 'PENDING' || phase === 'SUBMITTED') return <Pill tone="info" icon={Clock}>Monitoring</Pill>
  return null
}

function OperationStatus({ record, onRecheck, disabled }: { record: GatewayRecord; onRecheck: (record: GatewayRecord) => void; disabled: boolean }) {
  const text = STATUS_TEXT[record.kind][record.state]
  const tone = record.state === 'success' ? 'success' : record.state === 'error' ? 'danger' : record.state === 'unconfirmed' ? 'warn' : 'info'
  return (
    <Banner
      tone={tone}
      title={text.title}
      action={
        record.state === 'unconfirmed' ? (
          <Button variant="secondary" className="min-h-10" disabled={disabled} onClick={() => onRecheck(record)}>Check again</Button>
        ) : undefined
      }
    >
      <span className="mb-2 block">
        <GatewayGuardianPill record={record} />
      </span>
      <span className="flex items-start gap-2">
        {record.state === 'pending' && <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />}
        <span>
          {text.body(record)}
          {record.txHash && (
            <>
              {' '}
              <ExternalTx url={record.explorerUrl} hash={record.txHash} />
            </>
          )}
        </span>
      </span>
    </Banner>
  )
}

function Actions({ address, arc, chains, onRecord }: { address: Address; arc: EvmChain; chains: EvmChain[]; onRecord: (record: GatewayRecord) => void }) {
  const [mode, setMode] = useState<Mode>('deposit')
  const [chainId, setChainId] = useState('')
  const [amount, setAmount] = useState('')
  const action = useGatewayAction()
  const getAdapter = useWalletAdapter()
  const gateway = useGatewayBalance(address)
  const chain = chains.find((item) => chainKey(item) === chainId) ?? chains.find((item) => chainKey(item) === 'Ethereum') ?? chains[0]
  const sourceBalance = useChainUsdcBalance(mode === 'deposit' ? chain : undefined, address)

  const value = useMemo(() => checkAmount(amount), [amount])
  const available = mode === 'deposit' ? sourceBalance.data : toRaw(gateway.data?.total)
  const insufficient = value.ok && available !== undefined && value.raw > available
  const amountError = amount && !value.ok ? value.message : insufficient ? (mode === 'deposit' ? `Amount is higher than your USDC on ${chain.name}.` : 'Amount is higher than your Gateway balance.') : null
  const ready = value.ok && !insufficient && available !== undefined
  const amountText = value.ok ? formatUsdc(value.raw) : ''
  const debounced = useDebounced(amountText)
  const reason = action.busy ? undefined : ready ? undefined : available === undefined ? 'Waiting for the balance to load.' : amountError ?? 'Enter an amount.'

  const quote = useQuery({
    queryKey: ['circle', 'gateway-quote', mode, chainKey(chain), debounced, address],
    enabled: ready && debounced === amountText && amountText !== '',
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const { adapter } = await getAdapter(chains)
      const fees = mode === 'deposit' ? await estimateDeposit(adapter, chain, debounced) : await estimateSpend(adapter, address, debounced)
      return fees.map((fee) => ({ label: feeLabel(fee.type), token: fee.token, amount: fee.amount }))
    },
  })

  const preflightInput = useMemo<GatewayPreflightInput>(
    () => ({ kind: mode, owner: address, chain: mode === 'deposit' ? chain : undefined, arc, chains, amount: debounced, recipient: address }),
    [mode, address, chain, arc, chains, debounced],
  )
  const preview = useQuery({
    queryKey: ['circle', 'gateway-guardian', mode, chainKey(chain), debounced, address],
    enabled: ready && debounced === amountText && amountText !== '',
    staleTime: 20_000,
    retry: false,
    queryFn: async (): Promise<GuardianReport> => {
      const { adapter } = await getAdapter(chains)
      return runGatewayPreflight(preflightInput, gatewayChainReads({ kind: mode, adapter, chain: preflightInput.chain, amount: debounced, recipient: address, owner: address }))
    },
  })
  const guardianView: GuardianView = preview.data ? { status: 'done', report: preview.data } : ready && (preview.isFetching || preview.isPending) && amountText ? { status: 'checking' } : action.guardian
  const guardianBlocked = preview.data?.verdict === 'blocked' && !preview.data.rpcFailure

  const submit = () => {
    if (!ready || action.busy || guardianBlocked) return
    const input: GatewayPreflightInput = { ...preflightInput, amount: amountText }
    const guard = async (adapter: WalletAdapter): Promise<GuardianReport> => {
      // An identical request that is still in flight blocks a second one, including after a reload.
      const earlier = findInFlightDuplicate(address, gatewayFingerprint({ owner: address, kind: mode, chainKey: input.chain ? chainKey(input.chain) : undefined, amount: amountText }))
      if (earlier) return { verdict: 'blocked', checks: [], simulated: false, reason: 'An identical request is already running or waiting for your wallet. Wait for it to finish instead of sending it again.', rpcFailure: false, duplicateOf: earlier.hash, checkedAt: Date.now() }
      return runGatewayPreflight(input, gatewayChainReads({ kind: mode, adapter, chain: input.chain, amount: amountText, recipient: address, owner: address, fresh: true }))
    }
    if (mode === 'deposit') void action.run(chains, chain, (adapter) => runDeposit({ owner: address, adapter, chain, amount: amountText, onUpdate: onRecord }), arc, guard)
    else void action.run(chains, undefined, (adapter) => runSpend({ owner: address, adapter, recipient: address, amount: amountText, onUpdate: onRecord }), arc, guard)
  }

  return (
    <Card className="space-y-5">
      <div role="radiogroup" aria-label="Gateway action" className="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface-muted p-1">
        {([['deposit', 'Top Up Gateway'], ['spend', 'Spend to Arc']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            disabled={action.busy}
            onClick={() => { setMode(id); setAmount('') }}
            className={cx('min-h-10 rounded-xl text-sm font-semibold transition-colors duration-200 disabled:opacity-45', mode === id ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:bg-surface')}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'deposit' ? (
        <div>
          <label htmlFor="gw-chain" className="mb-2 block text-sm font-semibold text-ink-2">Top up from</label>
          <select id="gw-chain" value={chainKey(chain)} disabled={action.busy} onChange={(event) => setChainId(event.target.value)} className="min-h-12 w-full rounded-2xl border border-line bg-surface-muted px-3 text-sm font-semibold text-ink outline-none focus:border-line-strong disabled:opacity-60">
            {chains.map((item) => (
              <option key={chainKey(item)} value={chainKey(item)}>{item.name}</option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">Moves USDC from your wallet on {chain.name} into your Gateway balance.</p>
        </div>
      ) : (
        <p className="text-sm text-muted">Moves USDC out of your Gateway balance and mints it to your wallet on Arc. Circle submits the mint, so you do not need gas on Arc.</p>
      )}
      <AmountInput
        value={amount}
        onChange={setAmount}
        balance={available}
        balanceLabel={mode === 'deposit' ? `${chain.name} wallet balance` : 'Gateway balance'}
        balanceLoading={mode === 'deposit' ? sourceBalance.isPending : gateway.isPending}
        balanceUnavailable={mode === 'deposit' ? sourceBalance.isError : gateway.isError}
        disabled={action.busy}
        error={amountError}
      />
      <dl className="divide-y divide-line">
        <Row label="Action">{mode === 'deposit' ? `Top up from ${chain.name}` : 'Spend to Arc Mainnet'}</Row>
        <Row label="Amount">{amountText ? `${amountText} USDC` : '—'}</Row>
        <FeeRows lines={quote.data} loading={ready && quote.isFetching} error={quote.isError ? 'Circle could not quote this right now. The fee is shown when the request runs.' : undefined} />
      </dl>
      <Banner tone="warn" title="Real USDC moves">
        {mode === 'deposit' ? 'This sends USDC to Circle Gateway on the chosen chain. It counts in your unified balance after that chain finalizes.' : 'This burns USDC from your Gateway balance and mints it on Arc Mainnet. It cannot be undone.'}
      </Banner>
      {amountText && guardianView.status !== 'idle' && !action.busy && <GuardianStatus view={guardianView} flowPhase="review" hasHash={false} onRecheck={() => void preview.refetch()} />}
      {action.error && <Banner tone="danger" title="Request stopped">{action.error} Nothing was assumed to have succeeded.</Banner>}
      <Button className="w-full" disabled={!ready || action.busy || guardianBlocked} loading={action.busy} onClick={submit}>
        {action.busy ? 'Waiting for wallet and Circle' : mode === 'deposit' ? 'Top Up Gateway' : 'Spend to Arc'}
      </Button>
      {reason && <p className="text-center text-xs text-muted">{reason}</p>}
    </Card>
  )
}

function History({ records, onRecheck, disabled }: { records: GatewayRecord[]; onRecheck: (record: GatewayRecord) => void; disabled: boolean }) {
  if (records.length === 0) return null
  return (
    <Card>
      <h2 className="display mb-1 text-lg font-semibold">Gateway activity</h2>
      <ul className="divide-y divide-line">
        {records.map((record) => (
          <li key={record.id} className="flex items-start justify-between gap-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-semibold">
                {record.kind === 'deposit' ? `Top up from ${record.chainName}` : 'Spend to Arc'}: {record.amount} USDC
              </p>
              <p className="text-xs text-muted">{formatTimestamp(Math.floor(record.createdAt / 1000))}</p>
              {record.error && record.state !== 'success' && <p className={cx('mt-1 text-xs [overflow-wrap:anywhere]', record.state === 'error' ? 'text-danger' : 'text-warn')}>{record.error}</p>}
            </div>
            <div className="shrink-0 space-y-1 text-right">
              <p className={cx('text-xs font-semibold', record.state === 'error' && 'text-danger', record.state === 'unconfirmed' && 'text-warn', record.state === 'success' && 'text-accent-hover')}>
                {record.state === 'pending' ? 'In progress' : record.state === 'unconfirmed' ? 'Not confirmed yet' : record.state === 'success' ? (record.kind === 'deposit' ? 'Confirmed onchain' : 'Confirmed on Arc') : 'Failed'}
              </p>
              {record.txHash && <ExternalTx url={record.explorerUrl} hash={record.txHash} />}
              {record.state === 'unconfirmed' && (
                <button type="button" disabled={disabled} onClick={() => onRecheck(record)} className="block min-h-8 w-full text-xs font-semibold text-accent-hover hover:underline disabled:opacity-50">
                  Check again
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function GatewayContent({ address }: { address: Address }) {
  const chains = useGatewayChains()
  const queryClient = useQueryClient()
  const records = gatewayStore.useRecords(address)
  const [currentId, setCurrentId] = useState<string | undefined>()
  const [checking, setChecking] = useState(false)
  const current = records.find((record) => record.id === currentId)
  const history = records.filter((record) => record.id !== currentId)

  const onRecord = useCallback(
    (record: GatewayRecord) => {
      setCurrentId(record.id)
      gatewayStore.upsert(address, record)
      // The Guardian registry follows the record.
      syncGatewaySubmission(address, record)
    },
    [address],
  )
  const recheck = useCallback(
    async (record: GatewayRecord) => {
      if (!gatewayLock.tryAcquire(`check-${record.id}`)) return
      setChecking(true)
      try {
        const next = await recheckGatewayRecord(record, (updated) => gatewayStore.upsert(address, updated))
        if (next.state === 'success') void queryClient.invalidateQueries({ queryKey: ['circle', 'gateway-balance'] })
      } finally {
        setChecking(false)
        gatewayLock.release(`check-${record.id}`)
      }
    },
    [address, queryClient],
  )

  return (
    <div className="space-y-5">
      <BalanceCard address={address} />
      {current && <OperationStatus record={current} onRecheck={(record) => void recheck(record)} disabled={checking} />}
      {chains.isPending ? (
        <Card className="space-y-3" aria-busy><Skeleton className="h-6 w-40" /><Skeleton className="h-24 w-full" /></Card>
      ) : chains.isError || !chains.data ? (
        <Banner tone="danger" title="Could not load Gateway chains" action={<Button variant="secondary" className="min-h-10" onClick={() => void chains.refetch()}>Try again</Button>}>
          {chains.error ? classifyError(chains.error).message : 'No chains are available.'}
        </Banner>
      ) : (
        <Actions address={address} arc={chains.data.arc} chains={chains.data.chains} onRecord={onRecord} />
      )}
      <History records={history} onRecheck={(record) => void recheck(record)} disabled={checking} />
    </div>
  )
}

export default function CircleGateway() {
  return (
    <>
      <PageHeader title="Gateway" subtitle="One unified USDC balance with Circle Gateway. Top up on any supported chain, then spend it on Arc without bridging step by step." />
      {CIRCLE_CONFIG.gatewayEnabled ? (
        <ConnectGate allowWrongNetwork>{(address) => <GatewayContent address={address} />}</ConnectGate>
      ) : (
        <Banner tone="warn" title="Gateway is turned off">Set VITE_CIRCLE_GATEWAY_ENABLED to true to enable it.</Banner>
      )}
    </>
  )
}
