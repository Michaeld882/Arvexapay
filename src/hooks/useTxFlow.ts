import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSendTransaction, useWriteContract } from 'wagmi'
import { getAccount } from 'wagmi/actions'
import { useQueryClient } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { config } from '@/config'
import { ARC_CHAIN_ID } from '@/chain'
import { AppError, classifyError } from '@/lib/errors'
import type { TxPlan } from '@/lib/plan'
import { waitForReceipt } from '@/lib/rpc'
import { updateLocalTxStatus, upsertLocalTx } from '@/lib/txLog'

/**
 * idle      nothing in progress
 * review    confirmation screen (nothing has been signed yet)
 * signing   waiting for the wallet signature
 * confirming submitted; waiting for the receipt
 * stalled   submitted, but the receipt could not be read (RPC trouble). It may still succeed.
 * success   receipt succeeded AND the expected onchain events were verified
 * failed    reverted, or mined without the expected events (error.kind tells which)
 */
export type FlowPhase = 'idle' | 'review' | 'signing' | 'confirming' | 'stalled' | 'success' | 'failed'

export interface FlowState {
  phase: FlowPhase
  plan: TxPlan | null
  hash?: Hex
  error?: AppError
  /** What the verified receipt logs showed, when the plan reports it (shown in place of the generic success text). */
  resultText?: string
}

/** The most recent confirmed transaction, kept after the dialog closes so the hash and explorer link stay reachable. */
export interface LastConfirmedTx {
  hash: Hex
  title: string
  resultText: string
}

const IDLE: FlowState = { phase: 'idle', plan: null }

interface TxFlowOptions {
  /** Called once after a transaction is confirmed and its onchain events are verified. */
  onSuccess?: (plan: TxPlan) => void
}

export function useTxFlow(options: TxFlowOptions = {}) {
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()
  const queryClient = useQueryClient()
  const [state, setState] = useState<FlowState>(IDLE)
  const [lastConfirmed, setLastConfirmed] = useState<LastConfirmedTx | null>(null)
  const planRef = useRef<TxPlan | null>(null)
  const hashRef = useRef<Hex | undefined>(undefined)
  // Synchronous lock: blocks double clicks and duplicate submissions before React re-renders.
  const lock = useRef(false)
  const onSuccessRef = useRef(options.onSuccess)
  useEffect(() => {
    onSuccessRef.current = options.onSuccess
  })

  const open = useCallback((plan: TxPlan) => {
    if (lock.current) return
    planRef.current = plan
    hashRef.current = undefined
    setState({ phase: 'review', plan })
  }, [])

  const reset = useCallback(() => {
    if (lock.current) return
    planRef.current = null
    hashRef.current = undefined
    setState(IDLE)
  }, [])

  const finalize = useCallback(
    async (hash: Hex, plan: TxPlan, owner: string) => {
      setState({ phase: 'confirming', plan, hash })
      const receipt = await waitForReceipt(hash)
      const finalHash = receipt.transactionHash
      if (receipt.status !== 'success') {
        updateLocalTxStatus(owner, hash, 'failed')
        throw new AppError('reverted', `Transaction ${finalHash} reverted (status ${receipt.status})`)
      }
      let resultText: string | undefined
      try {
        const result = plan.verify(receipt)
        resultText = typeof result === 'string' ? result : undefined
      } catch (err) {
        updateLocalTxStatus(owner, hash, 'unverified')
        throw err
      }
      updateLocalTxStatus(owner, hash, 'success')
      setState({ phase: 'success', plan, hash: finalHash, resultText })
      setLastConfirmed({ hash: finalHash, title: plan.title, resultText: resultText ?? plan.successText })
      onSuccessRef.current?.(plan)
      void queryClient.invalidateQueries({ queryKey: ['arvexa'] })
    },
    [queryClient],
  )

  const handleError = useCallback((err: unknown, plan: TxPlan) => {
    const app = classifyError(err)
    console.debug('[arvexa:tx]', app.kind, app.detail)
    const hash = hashRef.current
    if (!hash) {
      // Nothing was submitted, so it is safe to let the user adjust and retry.
      setState({ phase: 'review', plan, error: app })
      return
    }
    const stalled = app.kind === 'rpc_timeout' || app.kind === 'rpc_unavailable' || app.kind === 'rpc_rate_limited'
    setState({ phase: stalled ? 'stalled' : 'failed', plan, hash, error: app })
  }, [])

  const submit = useCallback(async () => {
    const plan = planRef.current
    if (!plan || lock.current) return
    lock.current = true
    try {
      if (!address) throw new AppError('wallet_unavailable', 'No connected account')
      if (getAccount(config).chainId !== ARC_CHAIN_ID) throw new AppError('wrong_network')
      setState({ phase: 'signing', plan })
      const { call } = plan
      const hash =
        call.type === 'contract'
          ? await writeContractAsync({
              address: call.address,
              abi: call.abi,
              functionName: call.functionName,
              args: call.args,
              chainId: ARC_CHAIN_ID,
            })
          : await sendTransactionAsync({ to: call.to, data: call.data, value: call.value, chainId: ARC_CHAIN_ID })
      hashRef.current = hash
      upsertLocalTx(address, {
        hash,
        kind: plan.kind,
        amount: plan.amount.toString(),
        to: plan.to,
        status: 'pending',
        createdAt: Math.floor(Date.now() / 1000),
      })
      await finalize(hash, plan, address)
    } catch (err) {
      handleError(err, plan)
    } finally {
      lock.current = false
    }
  }, [address, finalize, handleError, sendTransactionAsync, writeContractAsync])

  /** Re-checks a submitted transaction. It never sends anything again. */
  const recheck = useCallback(async () => {
    const plan = planRef.current
    const hash = hashRef.current
    if (!plan || !hash || !address || lock.current) return
    lock.current = true
    try {
      await finalize(hash, plan, address)
    } catch (err) {
      handleError(err, plan)
    } finally {
      lock.current = false
    }
  }, [address, finalize, handleError])

  return {
    state,
    lastConfirmed,
    isBusy: state.phase === 'signing' || state.phase === 'confirming',
    open,
    submit,
    recheck,
    reset,
  }
}
