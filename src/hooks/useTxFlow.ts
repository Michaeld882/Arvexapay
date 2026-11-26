import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { setTxMeta } from '@/lib/txMeta'
import { fingerprintOf } from '@/guardian/checks'
import { expectationsFor } from '@/guardian/expect'
import { beginSubmission, dropSubmission, txLock, updateSubmission } from '@/guardian/lock'
import { runPreflight } from '@/guardian/preflight'
import type { GuardianReport, GuardianView } from '@/guardian/types'

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

/** What the screens read: the flow state plus what the Guardian found before signing. */
export interface FlowView extends FlowState {
  guardian: GuardianView
}

const IDLE: FlowState = { phase: 'idle', plan: null }
const NO_GUARDIAN: GuardianView = { status: 'idle' }

/** A report for a check that could not run at all. It blocks signing and says why. */
function crashedReport(err: unknown): GuardianReport {
  const app = classifyError(err)
  return { verdict: 'blocked', checks: [], simulated: false, reason: 'The safety checks could not run, so nothing was sent. Try again.', technical: app.detail, rpcFailure: true, checkedAt: Date.now() }
}

interface TxFlowOptions {
  /** Called once after a transaction is confirmed and its onchain events are verified. */
  onSuccess?: (plan: TxPlan, hash: Hex) => void
}

export function useTxFlow(options: TxFlowOptions = {}) {
  const { address, chainId: walletChainId } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()
  const queryClient = useQueryClient()
  const [state, setState] = useState<FlowState>(IDLE)
  const [lastConfirmed, setLastConfirmed] = useState<LastConfirmedTx | null>(null)
  const [guardian, setGuardian] = useState<GuardianView>(NO_GUARDIAN)
  const submissionRef = useRef<string | undefined>(undefined)
  const checkSeq = useRef(0)
  const planRef = useRef<TxPlan | null>(null)
  const hashRef = useRef<Hex | undefined>(undefined)
  // Synchronous lock: blocks double clicks and duplicate submissions before React re-renders.
  const lock = useRef(false)
  const onSuccessRef = useRef(options.onSuccess)
  useEffect(() => {
    onSuccessRef.current = options.onSuccess
  })

  /** Reads the chain and simulates the exact transaction. Sends nothing, opens no wallet prompt. */
  const check = useCallback(
    async (plan: TxPlan, fresh = false): Promise<GuardianReport> => {
      const seq = ++checkSeq.current
      setGuardian({ status: 'checking' })
      let report: GuardianReport
      try {
        report = await runPreflight({ plan, account: address, walletChainId: getAccount(config).chainId, fresh })
      } catch (err) {
        report = crashedReport(err)
      }
      if (seq === checkSeq.current && planRef.current === plan) setGuardian({ status: 'done', report })
      return report
    },
    [address],
  )

  const open = useCallback(
    (plan: TxPlan) => {
      if (lock.current) return
      planRef.current = plan
      hashRef.current = undefined
      submissionRef.current = undefined
      setState({ phase: 'review', plan })
      void check(plan)
    },
    [check],
  )

  const reset = useCallback(() => {
    if (lock.current) return
    planRef.current = null
    hashRef.current = undefined
    submissionRef.current = undefined
    checkSeq.current += 1
    setGuardian(NO_GUARDIAN)
    setState(IDLE)
  }, [])

  /** Run the checks again, for example after switching network or when the network was unreachable. */
  const recheckGuardian = useCallback(() => {
    const plan = planRef.current
    if (!plan || lock.current || hashRef.current) return
    void check(plan, true)
  }, [check])

  // The wallet changed network while the review screen was open: the earlier answer no longer applies.
  const lastChain = useRef(walletChainId)
  useEffect(() => {
    if (lastChain.current === walletChainId) return
    lastChain.current = walletChainId
    recheckGuardian()
  }, [walletChainId, recheckGuardian])

  const finalize = useCallback(
    async (hash: Hex, plan: TxPlan, owner: string) => {
      setState({ phase: 'confirming', plan, hash })
      if (submissionRef.current) updateSubmission(owner, submissionRef.current, { state: 'PENDING', hash })
      const receipt = await waitForReceipt(hash)
      const finalHash = receipt.transactionHash
      const settleSubmission = (state: 'CONFIRMED' | 'VERIFIED' | 'FAILED') => submissionRef.current && updateSubmission(owner, submissionRef.current, { state })
      if (receipt.status !== 'success') {
        settleSubmission('FAILED')
        updateLocalTxStatus(owner, hash, 'failed')
        throw new AppError('reverted', `Transaction ${finalHash} reverted (status ${receipt.status})`)
      }
      let resultText: string | undefined
      try {
        const result = plan.verify(receipt)
        resultText = typeof result === 'string' ? result : undefined
      } catch (err) {
        settleSubmission('CONFIRMED')
        updateLocalTxStatus(owner, hash, 'unverified')
        throw err
      }
      settleSubmission('VERIFIED')
      updateLocalTxStatus(owner, hash, 'success')
      setState({ phase: 'success', plan, hash: finalHash, resultText })
      setLastConfirmed({ hash: finalHash, title: plan.title, resultText: resultText ?? plan.successText })
      onSuccessRef.current?.(plan, finalHash)
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
    // Taken before any await: a double click, a re-render or a second screen cannot start a second submission.
    lock.current = true
    let release: (() => void) | undefined
    try {
      if (!address) throw new AppError('wallet_unavailable', 'No connected account')
      if (getAccount(config).chainId !== ARC_CHAIN_ID) throw new AppError('wrong_network')
      const acquired = txLock.tryAcquire(address, fingerprintOf(address, plan))
      if (!acquired.ok) {
        const message = acquired.reason === 'duplicate' ? 'This exact transaction is already being sent. Wait for it to finish.' : 'Another transaction from this wallet is waiting for your wallet. Finish or reject it first.'
        setGuardian({ status: 'done', report: { verdict: 'blocked', checks: [], simulated: false, reason: message, rpcFailure: false, checkedAt: Date.now() } })
        return
      }
      release = acquired.release
      // The last look before the wallet opens: fresh reads, and the exact call simulated against the chain right now.
      const report = await check(plan, true)
      if (planRef.current !== plan || report.verdict === 'blocked') return
      setState({ phase: 'signing', plan })
      const submission = beginSubmission(address, { fingerprint: fingerprintOf(address, plan), kind: plan.kind, title: plan.title, expect: expectationsFor(address, plan) })
      submissionRef.current = submission.id
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
      updateSubmission(address, submission.id, { state: 'SUBMITTED', hash })
      upsertLocalTx(address, {
        hash,
        kind: plan.kind,
        amount: plan.amount.toString(),
        to: plan.to,
        status: 'pending',
        createdAt: Math.floor(Date.now() / 1000),
      })
      // The note and category are kept in this browser against the real hash. They are not part of the transaction.
      if (plan.meta) setTxMeta(address, hash, plan.meta)
      await finalize(hash, plan, address)
    } catch (err) {
      // No hash means the wallet never submitted anything (rejected, or failed before sending): forget the attempt.
      if (!hashRef.current && address && submissionRef.current) dropSubmission(address, submissionRef.current)
      handleError(err, plan)
    } finally {
      release?.()
      lock.current = false
    }
  }, [address, check, finalize, handleError, sendTransactionAsync, writeContractAsync])

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

  const view = useMemo<FlowView>(() => ({ ...state, guardian }), [state, guardian])

  return {
    state: view,
    recheckGuardian,
    lastConfirmed,
    isBusy: state.phase === 'signing' || state.phase === 'confirming',
    open,
    submit,
    recheck,
    reset,
  }
}
