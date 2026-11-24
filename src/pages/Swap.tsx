import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { ArrowDownUp, ShieldCheck } from 'lucide-react'
import { ConnectGate } from '@/components/ConnectGate'
import { LastTxCard } from '@/components/LastTxCard'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, PageHeader, Skeleton, cx } from '@/components/ui'
import { useSpendableUsdc } from '@/hooks/useSpendable'
import { useTxFlow } from '@/hooks/useTxFlow'
import { AppError, classifyError } from '@/lib/errors'
import { formatUsdcDisplay } from '@/lib/format'
import { getArcClient } from '@/lib/rpc'
import { buildPermit2ApprovePlan, buildSwapApprovePlan, buildSwapPlan, permit2Abi } from '@/lib/swapPlan'
import { PRICE_IMPACT_BLOCK, PRICE_IMPACT_WARN, SLIPPAGE_DEFAULT_BPS, SLIPPAGE_MAX_BPS, SWAP_DEADLINE_SECONDS } from '@/lib/uniswap'
import { SWAP_PROVIDER, type SwapProvider, type SwapQuote, type SwapRequest, type SwapToken } from '@/swap-config'
import { USDC } from '@/chain'
import { Amount } from '@/onchain-money'

const SLIPPAGE_OPTIONS = [10, SLIPPAGE_DEFAULT_BPS, SLIPPAGE_MAX_BPS] as const
const DEBOUNCE_MS = 450

const fmt = (raw: bigint, token: SwapToken) => Amount.fromRaw(raw, token.decimals).toFixed(Math.min(token.decimals, 6))
const percent = (fraction: number) => `${(fraction * 100).toFixed(2)}%`

function parseAmountText(text: string, decimals: number): bigint | undefined {
  try {
    const value = Amount.parse(text || '0', decimals)
    return value.isPositive() ? value.raw : undefined
  } catch {
    return undefined
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

function NotConfigured({ reason, onRetry, retrying }: { reason?: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div className="space-y-5">
      <Banner
        tone="warn"
        title="Swap liquidity is not configured"
        action={
          onRetry && (
            <Button variant="secondary" className="min-h-10" loading={retrying} onClick={onRetry}>
              Check again
            </Button>
          )
        }
      >
        {reason ?? 'Arvexa does not show prices or run swaps until a verified Arc Mainnet provider is registered.'} No quotes, rates or results are simulated.
      </Banner>
      <Card className="space-y-4 opacity-80" aria-disabled>
        <div className="rounded-2xl border border-line bg-surface-muted p-4">
          <p className="text-xs text-muted">You pay</p>
          <div className="mt-1 flex items-center justify-between">
            <span className="display text-3xl font-semibold text-subtle">0.00</span>
            <span className="rounded-full bg-surface px-3 py-1 text-sm font-semibold">USDC</span>
          </div>
        </div>
        <Button className="w-full" disabled>
          Swap unavailable
        </Button>
      </Card>
    </div>
  )
}

function useTokenBalance(owner: Address, token: SwapToken) {
  return useQuery({
    queryKey: ['arvexa', 'token-balance', owner, token.address],
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: () => getArcClient().readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  })
}

function SwapForm({ address, provider }: { address: Address; provider: SwapProvider }) {
  const queryClient = useQueryClient()
  const [tokenIn, setTokenIn] = useState<SwapToken>(provider.tokens[0])
  const [tokenOut, setTokenOut] = useState<SwapToken>(provider.tokens[1] ?? provider.tokens[0])
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState<number>(SLIPPAGE_DEFAULT_BPS)
  const [accepted, setAccepted] = useState(false)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const flow = useTxFlow({ onSuccess: (plan) => plan.kind === 'swap' && setAmount('') })
  const usdc = useSpendableUsdc(address)
  const balance = useTokenBalance(address, tokenIn)
  const settled = useDebounced(amount, DEBOUNCE_MS)
  const inIsUsdc = tokenIn.address === USDC.address

  const parsedNow = useMemo(() => parseAmountText(amount, tokenIn.decimals), [amount, tokenIn.decimals])
  const parsedSettled = useMemo(() => parseAmountText(settled, tokenIn.decimals), [settled, tokenIn.decimals])

  const sameToken = tokenIn.address === tokenOut.address
  const makeRequest = (amountIn: bigint): SwapRequest => ({ tokenIn, tokenOut, amountIn, recipient: address, slippageBps })
  const request = parsedSettled !== undefined && !sameToken ? makeRequest(parsedSettled) : undefined

  const quote = useQuery({
    queryKey: ['arvexa', 'swap-quote', provider.id, tokenIn.address, tokenOut.address, parsedSettled?.toString(), slippageBps],
    enabled: Boolean(request),
    staleTime: 15_000,
    gcTime: 60_000,
    queryFn: async (): Promise<SwapQuote> => {
      try {
        return await provider.quote(request as SwapRequest)
      } catch (err) {
        const app = classifyError(err)
        if (app.kind.startsWith('rpc_') || app.kind === 'swap_unavailable' || app.kind === 'token_not_configured') throw err
        throw new AppError('swap_unavailable', app.detail)
      }
    },
  })

  const quoteIsCurrent = parsedNow !== undefined && parsedNow === parsedSettled && Boolean(quote.data) && !quote.isError
  const maxIn = inIsUsdc ? usdc.spendable : balance.data
  const insufficient = parsedNow !== undefined && balance.data !== undefined && parsedNow > balance.data
  const leavesNoFee = inIsUsdc && parsedNow !== undefined && !insufficient && usdc.spendable !== undefined && parsedNow > usdc.spendable
  const impact = quote.data?.priceImpact ?? 0
  const needsAccept = impact > PRICE_IMPACT_BLOCK
  const canReview = quoteIsCurrent && !insufficient && !leavesNoFee && (!needsAccept || accepted) && !building && !flow.isBusy

  const flip = () => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAccepted(false)
  }
  const pick = (which: 'in' | 'out', token: SwapToken) => {
    setAccepted(false)
    if (which === 'in') {
      if (token.address === tokenOut.address) setTokenOut(tokenIn)
      setTokenIn(token)
    } else {
      if (token.address === tokenIn.address) setTokenIn(tokenOut)
      setTokenOut(token)
    }
  }

  const review = async () => {
    if (parsedNow === undefined || sameToken) return
    setBuildError(null)
    setBuilding(true)
    try {
      const req = makeRequest(parsedNow)
      // Quote again right before submitting: never trade on a stale number.
      const fresh = await provider.quote(req)
      queryClient.setQueryData(['arvexa', 'swap-quote', provider.id, tokenIn.address, tokenOut.address, parsedNow.toString(), slippageBps], fresh)
      if ((fresh.priceImpact ?? 0) > PRICE_IMPACT_BLOCK && !accepted) throw new AppError('swap_unavailable', 'Price impact is above the safety limit. Accept the loss to continue.')
      const client = getArcClient()
      const { permit2, router } = provider.approval
      if (permit2) {
        const erc20Allowance = await client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: 'allowance', args: [address, permit2] })
        if (erc20Allowance < req.amountIn) {
          flow.open(buildSwapApprovePlan(address, req, permit2))
          return
        }
        const [permitAmount, permitExpiry] = await client.readContract({ address: permit2, abi: permit2Abi, functionName: 'allowance', args: [address, tokenIn.address, router] })
        const now = Math.floor(Date.now() / 1000)
        if (permitAmount < req.amountIn || permitExpiry <= now + 600) {
          flow.open(buildPermit2ApprovePlan(address, req, permit2, router, now + 1800))
          return
        }
      }
      const tx = await provider.buildTransaction(req, fresh)
      flow.open(buildSwapPlan(req, fresh, tx))
    } catch (err) {
      setBuildError(classifyError(err).message)
    } finally {
      setBuilding(false)
    }
  }

  const tokenSelect = (value: SwapToken, which: 'in' | 'out', label: string) => (
    <select
      aria-label={label}
      value={value.address}
      disabled={flow.isBusy}
      onChange={(event) => pick(which, provider.tokens.find((token) => token.address === event.target.value) ?? value)}
      className="min-h-11 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-ink"
    >
      {provider.tokens.map((token) => (
        <option key={token.address} value={token.address}>
          {token.symbol}
        </option>
      ))}
    </select>
  )

  const rate =
    quote.data && parsedSettled
      ? Number(quote.data.amountOut) / 10 ** tokenOut.decimals / (Number(parsedSettled) / 10 ** tokenIn.decimals)
      : undefined

  return (
    <>
      <div className="space-y-4">
        <Banner tone="info" title="Real swaps on Arc Mainnet">
          Swaps run on Arc Mainnet through Uniswap pools and move real funds. Your first swap of a token needs up to two one-time approvals for exactly the amount you swap.
        </Banner>
        <Card className="space-y-3">
          <div className="rounded-2xl border border-line bg-surface-muted p-4">
            <label htmlFor="swap-amount" className="text-xs text-muted">
              You pay
            </label>
            <div className="mt-1 flex items-center justify-between gap-3">
              <input
                id="swap-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amount}
                disabled={flow.isBusy}
                onChange={(event) => {
                  setAmount(event.target.value.replace(/[^0-9.]/g, ''))
                  setAccepted(false)
                }}
                className="display w-full min-w-0 bg-transparent text-3xl font-semibold tabular-nums outline-none placeholder:text-subtle disabled:opacity-60"
              />
              {tokenSelect(tokenIn, 'in', 'Pay token')}
            </div>
            <div className="mt-2 flex min-h-5 items-center justify-between text-xs text-muted">
              {balance.isPending ? (
                <Skeleton className="h-4 w-32" />
              ) : balance.isError ? (
                <span>Balance unavailable</span>
              ) : (
                <span className="tabular-nums">
                  Balance: {fmt(balance.data ?? 0n, tokenIn)} {tokenIn.symbol}
                </span>
              )}
              <button
                type="button"
                disabled={flow.isBusy || maxIn === undefined || maxIn === 0n}
                onClick={() => maxIn !== undefined && setAmount(Amount.fromRaw(maxIn, tokenIn.decimals).toFixed(tokenIn.decimals).replace(/\.?0+$/, ''))}
                className="min-h-8 rounded-lg px-2 font-semibold text-accent-hover transition-colors hover:bg-surface disabled:opacity-40"
              >
                Max
              </button>
            </div>
            {inIsUsdc && usdc.spendable !== undefined && <p className="mt-1 text-xs text-muted tabular-nums">Spendable after the network fee: {formatUsdcDisplay(usdc.spendable)} USDC</p>}
            {insufficient && (
              <p role="alert" className="mt-2 text-sm text-danger">
                Amount is higher than your {tokenIn.symbol} balance.
              </p>
            )}
            {leavesNoFee && (
              <p role="alert" className="mt-2 text-sm text-danger">
                That leaves too little USDC to pay the network fee. Use up to {formatUsdcDisplay(usdc.spendable ?? 0n)} USDC.
              </p>
            )}
          </div>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={flip}
              disabled={flow.isBusy}
              aria-label="Swap the two tokens"
              className="flex size-10 items-center justify-center rounded-full border border-line bg-surface-muted transition-[transform,border-color] duration-300 hover:rotate-180 hover:border-line-strong active:scale-90 disabled:opacity-50"
            >
              <ArrowDownUp className="size-4" aria-hidden />
            </button>
          </div>

          <div className="rounded-2xl border border-line bg-surface-muted p-4">
            <p className="text-xs text-muted">You receive (estimate from a live onchain quote)</p>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="display text-3xl font-semibold tabular-nums" aria-live="polite">
                {quote.isFetching && !quote.data ? <Skeleton className="h-9 w-32" /> : quote.data && parsedNow === parsedSettled ? fmt(quote.data.amountOut, tokenOut) : '—'}
              </span>
              {tokenSelect(tokenOut, 'out', 'Receive token')}
            </div>
          </div>

          {quote.isError && (
            <Banner tone="danger" title={classifyError(quote.error).kind === 'swap_unavailable' ? 'No route at this size' : 'Could not get a quote'}>
              {classifyError(quote.error).message}
            </Banner>
          )}

          {quoteIsCurrent && quote.data && (
            <dl className="rise divide-y divide-line rounded-2xl border border-line bg-surface-muted px-4 text-sm">
              {rate !== undefined && (
                <Detail label="Rate">
                  1 {tokenIn.symbol} = {rate.toFixed(4)} {tokenOut.symbol}
                </Detail>
              )}
              {quote.data.routeLabel && <Detail label="Route">{quote.data.routeLabel}</Detail>}
              {quote.data.feeFraction !== undefined && <Detail label="Pool fee">{percent(quote.data.feeFraction)}</Detail>}
              <Detail label="Price impact">
                <span className={cx(impact > PRICE_IMPACT_BLOCK ? 'text-danger' : impact > PRICE_IMPACT_WARN ? 'text-warn' : 'text-success')}>{percent(impact)}</span>
              </Detail>
              <Detail label={`Minimum received (${(slippageBps / 100).toFixed(1)}% slippage)`}>
                {fmt(quote.data.minAmountOut, tokenOut)} {tokenOut.symbol}
              </Detail>
              <Detail label="Deadline">{Number(SWAP_DEADLINE_SECONDS) / 60} minutes after you confirm</Detail>
            </dl>
          )}

          {quoteIsCurrent && impact > PRICE_IMPACT_WARN && (
            <Banner tone={needsAccept ? 'danger' : 'warn'} title={needsAccept ? `Very high price impact: ${percent(impact)}` : `High price impact: ${percent(impact)}`}>
              This size moves the pool price. A smaller amount usually gets a better rate.
              {needsAccept && (
                <label className="mt-2 flex items-start gap-2 text-ink">
                  <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
                  <span>I accept a loss of about {percent(impact)} on this swap.</span>
                </label>
              )}
            </Banner>
          )}

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Max slippage</span>
            <div className="flex gap-1.5" role="group" aria-label="Max slippage">
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => setSlippageBps(bps)}
                  aria-pressed={slippageBps === bps}
                  className={cx(
                    'min-h-9 rounded-full border px-3 text-xs font-semibold transition-[background-color,color,transform] duration-200 active:scale-95',
                    slippageBps === bps ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-muted text-ink-2',
                  )}
                >
                  {(bps / 100).toFixed(1)}%
                </button>
              ))}
            </div>
          </div>

          {buildError && <Banner tone="danger">{buildError}</Banner>}
          <Button className="w-full" disabled={!canReview} loading={building || (Boolean(request) && quote.isFetching && !quote.data)} onClick={() => void review()}>
            Review swap
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
            <ShieldCheck className="size-3.5" aria-hidden /> Quoted and simulated onchain before you sign. Slippage is capped at 1%.
          </p>
        </Card>
      </div>
      <LastTxCard tx={flow.lastConfirmed} />
      <TxDialog flow={flow} walletUsdc={usdc.balance.data} />
    </>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-ink">{children}</dd>
    </div>
  )
}

/** Re-checks every contract the provider uses against the live chain, then shows the form. */
function VerifiedSwap({ provider }: { provider: SwapProvider }) {
  const verification = useQuery({
    queryKey: ['arvexa', 'swap-verify', provider.id],
    staleTime: 10 * 60_000,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      await provider.verify()
      return true
    },
  })
  if (verification.isPending) {
    return (
      <Card className="space-y-3" aria-busy>
        <p className="text-sm text-muted">Verifying the swap contracts on Arc Mainnet…</p>
        <Skeleton className="h-24 w-full" />
      </Card>
    )
  }
  if (verification.isError) {
    const app = classifyError(verification.error)
    return <NotConfigured reason={`Verification failed: ${app.message}`} onRetry={() => void verification.refetch()} retrying={verification.isFetching} />
  }
  return <ConnectGate>{(address) => <SwapForm address={address} provider={provider} />}</ConnectGate>
}

export default function Swap() {
  return (
    <>
      <PageHeader title="Swap" subtitle="Swap USDC and EURC on Arc Mainnet at live onchain prices. You review the route, price impact and minimum received before signing." />
      {SWAP_PROVIDER ? <VerifiedSwap provider={SWAP_PROVIDER} /> : <NotConfigured />}
    </>
  )
}
