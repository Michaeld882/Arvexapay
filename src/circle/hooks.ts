import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { createPublicClient, erc20Abi, fallback, http, type Address, type EIP1193Provider } from 'viem'
import { recheckTransfer, retryTransfer, runTransfer, transferStore, newTransferRecord, estimateTransfer, type TransferRecord } from '@/circle/cctp'
import { CIRCLE_CONFIG, type TransferSpeed } from '@/circle/config'
import { describeCircleError } from '@/circle/errors'
import { transferLock } from '@/circle/locks'
import { getGatewayBalance } from '@/circle/gateway'
import { createWalletAdapter, switchWalletChain, chainKey, type CctpChains, type EvmChain, type WalletAdapter } from '@/circle/sdk'

/** Warns before the tab is closed while a signed, fund-moving operation is running. */
export function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}

export function useDebounced<T>(value: T, delay = 500): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Builds a Circle adapter from the connected wallet's own provider. The wallet signs everything; no key is held. */
export function useWalletAdapter() {
  const { connector } = useAccount()
  return useCallback(
    async (known: readonly EvmChain[]): Promise<{ adapter: WalletAdapter; provider: EIP1193Provider }> => {
      if (!connector) throw new Error('Connect a wallet first.')
      const provider = (await connector.getProvider()) as EIP1193Provider
      return { adapter: await createWalletAdapter(provider, known), provider }
    },
    [connector],
  )
}

/** USDC held by a wallet on another chain, read from that chain's public RPC endpoints. */
export function useChainUsdcBalance(chain: EvmChain | undefined, owner: Address | undefined) {
  return useQuery({
    queryKey: ['circle', 'chain-usdc', chain ? chainKey(chain) : undefined, owner],
    enabled: Boolean(chain?.usdcAddress && owner),
    staleTime: 15_000,
    refetchInterval: 60_000,
    queryFn: () => {
      const target = chain as EvmChain
      const client = createPublicClient({ transport: fallback(target.rpcEndpoints.map((url) => http(url, { timeout: 10_000 }))) })
      return client.readContract({ address: target.usdcAddress as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] })
    },
  })
}

export function useGatewayBalance(owner: Address | undefined) {
  return useQuery({
    queryKey: ['circle', 'gateway-balance', owner],
    enabled: Boolean(owner) && CIRCLE_CONFIG.gatewayEnabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: () => getGatewayBalance(owner as Address),
  })
}

export interface RouteInput {
  source: EvmChain | undefined
  amount: string
  recipient: Address | undefined
  speed: TransferSpeed
  useForwarder: boolean
  /** Only quote when the amount is valid and affordable, so the quote never runs on junk input. */
  ready: boolean
}

/** Circle's real fee quote for the chosen route. Nothing is signed. */
export function useTransferQuote(chains: CctpChains | undefined, input: RouteInput) {
  const getAdapter = useWalletAdapter()
  const debouncedAmount = useDebounced(input.amount)
  return useQuery({
    queryKey: ['circle', 'cctp-quote', input.source ? chainKey(input.source) : undefined, debouncedAmount, input.recipient, input.speed, input.useForwarder],
    enabled: Boolean(chains && input.source && input.recipient && input.ready && debouncedAmount === input.amount),
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const { adapter } = await getAdapter([chains!.destination, ...chains!.sources])
      return estimateTransfer({ adapter, source: input.source!, amount: debouncedAmount, recipient: input.recipient!, speed: input.speed, useForwarder: input.useForwarder })
    },
  })
}

/**
 * Runs and resumes CCTP transfers. A module-level lock allows one operation at a time, even across page changes, and
 * every update is saved so an interrupted transfer can be resumed after a reload.
 */
export function useBridgeFlow(chains: CctpChains | undefined, owner: Address | undefined) {
  const getAdapter = useWalletAdapter()
  const queryClient = useQueryClient()
  const busyId = transferLock.useActive()
  const [startError, setStartError] = useState<string | undefined>()

  const refreshBalances = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['arvexa', 'usdc-balance'] })
    void queryClient.invalidateQueries({ queryKey: ['circle', 'chain-usdc'] })
    void queryClient.invalidateQueries({ queryKey: ['arvexa', 'activity'] })
  }, [queryClient])

  const execute = useCallback(
    async (record: TransferRecord, mode: 'start' | 'resume') => {
      if (!chains || !owner) return
      if (!transferLock.tryAcquire(record.id)) return
      setStartError(undefined)
      const known = [chains.destination, ...chains.sources]
      const onUpdate = (next: TransferRecord) => transferStore.upsert(owner, next)
      try {
        const source = chains.sources.find((chain) => chainKey(chain) === record.sourceChain)
        if (!source) throw new Error('This source chain is no longer supported by Circle.')
        const { provider } = await getAdapter(known)
        // The burn happens on the source chain, so the wallet must be there before the adapter is built. Resuming a
        // forwarded transfer needs no switch because Circle submits the mint.
        if (mode === 'start' || !record.useForwarder) await switchWalletChain(provider, mode === 'start' ? source : chains.destination, known)
        const { adapter } = await getAdapter(known)
        onUpdate(record)
        await (mode === 'start' ? runTransfer({ record, source, adapter, onUpdate }) : retryTransfer({ record, adapter, onUpdate }))
        // Return the wallet to Arc, where the rest of Arvexa works. A refusal here is harmless.
        await switchWalletChain(provider, chains.destination, known).catch(() => undefined)
        refreshBalances()
      } catch (err) {
        const message = describeCircleError(err)
        setStartError(message)
        if (mode === 'start') onUpdate({ ...record, state: 'error', error: message, steps: record.steps.map((step) => (step.state === 'active' ? { ...step, state: 'error' } : step)) })
      } finally {
        transferLock.release(record.id)
      }
    },
    [chains, owner, getAdapter, refreshBalances],
  )

  const start = useCallback(
    (input: { source: EvmChain; amount: string; recipient: Address; speed: TransferSpeed; useForwarder: boolean }) => {
      if (!owner) return
      return execute(newTransferRecord({ owner, ...input }), 'start')
    },
    [owner, execute],
  )

  const resume = useCallback((record: TransferRecord) => execute(record, 'resume'), [execute])

  /** Read-only: look for the mint on Arc again. Needs no wallet. */
  const recheck = useCallback(
    async (record: TransferRecord) => {
      if (!owner || !transferLock.tryAcquire(record.id)) return
      try {
        const next = await recheckTransfer({ record, onUpdate: (updated) => transferStore.upsert(owner, updated) })
        if (next.state === 'success') refreshBalances()
      } finally {
        transferLock.release(record.id)
      }
    },
    [owner, refreshBalances],
  )

  const dismiss = useCallback((record: TransferRecord) => owner && transferStore.remove(owner, record.id), [owner])

  useLeaveWarning(busyId !== undefined)

  return { start, resume, recheck, dismiss, busyId, isBusy: busyId !== undefined, startError, clearError: () => setStartError(undefined) }
}
