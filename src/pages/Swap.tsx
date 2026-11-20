import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { ArrowLeftRight } from 'lucide-react'
import { ConnectGate } from '@/components/ConnectGate'
import { TxDialog } from '@/components/TxDialog'
import { Banner, Button, Card, PageHeader } from '@/components/ui'
import { useTxFlow } from '@/hooks/useTxFlow'
import { useWalletUsdc } from '@/hooks/useChainData'
import { AppError, classifyError } from '@/lib/errors'
import { getArcClient } from '@/lib/rpc'
import { buildSwapApprovePlan, buildSwapPlan } from '@/lib/swapPlan'
import { SWAP_PROVIDER, type SwapProvider, type SwapRequest, type SwapToken } from '@/swap-config'
import { Amount } from '@/onchain-money'

const MAX_SLIPPAGE_BPS = 100
const SLIPPAGE_OPTIONS = [10, 50, 100] as const

function NotConfigured() {
  return (
    <div className="space-y-5">
      <Banner tone="warn" title="Swap liquidity is not configured">
        Arvexa does not show prices or run swaps until a verified Arc Mainnet provider is registered. No quotes, rates or results are simulated.
      </Banner>
      <Card className="space-y-4 opacity-80" aria-disabled>
        <div className="rounded-2xl border border-line bg-surface-muted p-4">
          <p className="text-xs text-muted">You pay</p>
          <div className="mt-1 flex items-center justify-between">
            <span className="display text-3xl font-semibold text-subtle">0.00</span>
            <span className="rounded-full bg-surface px-3 py-1 text-sm font-semibold">USDC</span>
          </div>
        </div>
        <div className="flex justify-center">
          <span className="flex size-9 items-center justify-center rounded-full border border-line bg-surface-muted">
            <ArrowLeftRight className="size-4 rotate-90" aria-hidden />
          </span>
        </div>
        <div className="rounded-2xl border border-line bg-surface-muted p-4">
          <p className="text-xs text-muted">You receive</p>
          <div className="mt-1 flex items-center justify-between">
            <span className="display text-3xl font-semibold text-subtle">—</span>
            <span className="rounded-full bg-surface px-3 py-1 text-sm text-muted">No token</span>
          </div>
        </div>
        <Button className="w-full" disabled>
          Swap unavailable
        </Button>
      </Card>
      <Card>
        <h2 className="display text-lg font-semibold">How to enable swaps</h2>
        <p className="mt-1 text-sm text-muted">
          Register a verified provider in <span className="mono text-xs">src/swap-config.ts</span> (the SWAP_PROVIDERS list). A provider supplies its token list, a live quote
          function and a transaction builder. Verify its router address and routes on Arc Mainnet before adding it.
        </p>
      </Card>
    </div>
  )
}

function useTokenBalance(owner: Address, token: SwapToken) {
  return useQuery({
    queryKey: ['arvexa', 'token-balance', owner, token.address],
    staleTime: 30_000,
    queryFn: () => getArcClient().readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  })
}

function ConfiguredSwap({ address, provider }: { address: Address; provider: SwapProvider }) {
  const [tokenIn, setTokenIn] = useState<SwapToken>(provider.tokens[0])
  const [tokenOut, setTokenOut] = useState<SwapToken>(provider.tokens[1] ?? provider.tokens[0])
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState<number>(50)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const flow = useTxFlow()
  const walletUsdc = useWalletUsdc(address)
  const balance = useTokenBalance(address, tokenIn)

  const parsed = useMemo(() => {
    try {
      const value = Amount.parse(amount || '0', tokenIn.decimals)
      return value.isPositive() ? value.raw : undefined
    } catch {
      return undefined
    }
  }, [amount, tokenIn.decimals])

  const sameToken = tokenIn.address === tokenOut.address
  const request: SwapRequest | undefined =
    parsed !== undefined && !sameToken ? { tokenIn, tokenOut, amountIn: parsed, recipient: address, slippageBps: Math.min(slippageBps, MAX_SLIPPAGE_BPS) } : undefined

  const quote = useQuery({
    queryKey: ['arvexa', 'swap-quote', provider.id, tokenIn.address, tokenOut.address, parsed?.toString(), slippageBps],
    enabled: Boolean(request),
    staleTime: 10_000,
    queryFn: async () => {
      try {
        return await provider.quote(request as SwapRequest)
      } catch (err) {
        if (classifyError(err).kind.startsWith('rpc_')) throw err
        throw new AppError('swap_unavailable', classifyError(err).detail)
      }
    },
  })

  const insufficient = parsed !== undefined && balance.data !== undefined && parsed > balance.data
  const canReview = Boolean(request && quote.data && !insufficient && !building && !flow.isBusy)

  const review = async () => {
    if (!request || !quote.data) return
    setBuildError(null)
    setBuilding(true)
    try {
      if (quote.data.deadline <= Math.floor(Date.now() / 1000)) {
        await quote.refetch()
        throw new AppError('swap_unavailable', 'Quote expired. A fresh quote was requested.')
      }
      const tx = await provider.buildTransaction(request, quote.data)
      if (tx.spender) {
        const allowance = await getArcClient().readContract({
          address: tokenIn.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, tx.spender],
        })
        if (allowance < request.amountIn) {
          flow.open(buildSwapApprovePlan(address, request, tx.spender))
          return
        }
      }
      flow.open(buildSwapPlan(request, quote.data, tx))
    } catch (err) {
      setBuildError(classifyError(err).message)
    } finally {
      setBuilding(false)
    }
  }

  const tokenSelect = (value: SwapToken, onChange: (token: SwapToken) => void, label: string) => (
    <select
      aria-label={label}
      value={value.address}
      onChange={(event) => onChange(provider.tokens.find((token) => token.address === event.target.value) ?? value)}
      className="min-h-11 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-ink"
    >
      {provider.tokens.map((token) => (
        <option key={token.address} value={token.address}>
          {token.symbol}
        </option>
      ))}
    </select>
  )

  return (
    <>
      <Card className="space-y-4">
        <div className="rounded-2xl border border-line bg-surface-muted p-4">
          <label htmlFor="swap-amount" className="text-xs text-muted">You pay</label>
          <div className="mt-1 flex items-center justify-between gap-3">
            <input
              id="swap-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
              className="display w-full min-w-0 bg-transparent text-3xl font-semibold tabular-nums outline-none placeholder:text-subtle"
            />
            {tokenSelect(tokenIn, setTokenIn, 'Pay token')}
          </div>
          {insufficient && <p role="alert" className="mt-2 text-sm text-danger">Amount is higher than your balance.</p>}
        </div>
        <div className="rounded-2xl border border-line bg-surface-muted p-4">
          <p className="text-xs text-muted">You receive (estimate from provider)</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="display text-3xl font-semibold tabular-nums">
              {quote.data ? Amount.fromRaw(quote.data.amountOut, tokenOut.decimals).toFixed(Math.min(tokenOut.decimals, 6)) : '—'}
            </span>
            {tokenSelect(tokenOut, setTokenOut, 'Receive token')}
          </div>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">Max slippage</span>
          <div className="flex gap-1.5" role="group" aria-label="Max slippage">
            {SLIPPAGE_OPTIONS.map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setSlippageBps(bps)}
                aria-pressed={slippageBps === bps}
                className={`min-h-9 rounded-full border px-3 text-xs font-semibold ${slippageBps === bps ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-muted text-ink-2'}`}
              >
                {(bps / 100).toFixed(1)}%
              </button>
            ))}
          </div>
        </div>
        {sameToken && <Banner tone="warn">Choose two different tokens.</Banner>}
        {quote.isError && <Banner tone="danger" title="No route available">{classifyError(quote.error).message}</Banner>}
        {buildError && <Banner tone="danger">{buildError}</Banner>}
        <Button className="w-full" disabled={!canReview} loading={building || quote.isFetching} onClick={() => void review()}>
          Review swap
        </Button>
      </Card>
      <TxDialog flow={flow} walletUsdc={walletUsdc.data} />
    </>
  )
}

export default function Swap() {
  return (
    <>
      <PageHeader title="Swap" subtitle="Swap tokens on Arc Mainnet through a verified liquidity provider." />
      {SWAP_PROVIDER ? (
        <ConnectGate>{(address) => <ConfiguredSwap address={address} provider={SWAP_PROVIDER as SwapProvider} />}</ConnectGate>
      ) : (
        <NotConfigured />
      )}
    </>
  )
}
