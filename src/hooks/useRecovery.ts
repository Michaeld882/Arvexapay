import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { recheckTransfer, transferStore } from '@/circle/cctp'
import { gatewayStore, recheckGatewayRecord } from '@/circle/gateway'
import { gatewayLock, transferLock } from '@/circle/locks'
import { syncCctpSubmission } from '@/guardian/cctp'
import { syncGatewaySubmission } from '@/guardian/gateway'
import { chainReads } from '@/guardian/preflight'
import { pendingSubmissions, recoverCctp, recoverGateway, recoverSubmissions, recoveryDelay, type RecoveredSubmission } from '@/guardian/recovery'
import type { Submission } from '@/guardian/lock'

const MAX_POLLS = 20
/** Owners already recovered in this page load. A reload runs it again; navigating inside the app does not. */
const recovered = new Set<string>()

/** What recovery has settled in this page load, per wallet. It is shown once and starts empty after the next reload. */
const settledThisLoad = new Map<string, Map<string, RecoveredSubmission>>()

export interface RecoveryView {
  pending: Submission[]
  settled: RecoveredSubmission[]
}

/**
 * Restores what was in flight when the page was reloaded, using read-only calls only: the receipt of a submitted
 * transaction, the Gateway read-back, and the Arc mint check. Nothing is signed or sent. Returns the transactions
 * that are still unresolved so the app can show them instead of letting the user start a duplicate.
 */
export function useRecovery(owner: Address | undefined): RecoveryView {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!owner) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = () => !cancelled && setVersion((value) => value + 1)
    const receipts = chainReads({ fresh: true })

    const settleDirect = async () => {
      const results = await recoverSubmissions(owner, { readReceipt: (hash) => receipts.readReceipt(hash) })
      const book = settledThisLoad.get(owner.toLowerCase()) ?? new Map<string, RecoveredSubmission>()
      for (const result of results) if (result.outcome !== 'pending' && result.outcome !== 'unknown') book.set(result.submission.id, result)
      settledThisLoad.set(owner.toLowerCase(), book)
      bump()
    }

    const first = async () => {
      await settleDirect()
      // Gateway and CCTP keep their own records. Each is read back once, one at a time, so a reload never causes a burst.
      await recoverGateway(gatewayStore.read(owner), {
        update: (record) => {
          gatewayStore.upsert(owner, record)
          syncGatewaySubmission(owner, record)
        },
        recheck: async (record) => {
          if (!gatewayLock.tryAcquire(`recover-${record.id}`)) return record
          try {
            const next = await recheckGatewayRecord(record, (updated) => gatewayStore.upsert(owner, updated))
            syncGatewaySubmission(owner, next)
            return next
          } finally {
            gatewayLock.release(`recover-${record.id}`)
          }
        },
      })
      await recoverCctp(transferStore.read(owner), {
        recheck: async (record) => {
          if (!transferLock.tryAcquire(record.id)) return record
          try {
            const next = await recheckTransfer({ record, onUpdate: (updated) => transferStore.upsert(owner, updated) })
            syncCctpSubmission(owner, next)
            return next
          } finally {
            transferLock.release(record.id)
          }
        },
      })
      bump()
    }

    const poll = (attempt: number) => {
      if (cancelled || attempt >= MAX_POLLS || pendingSubmissions(owner).every((item) => !item.hash)) return
      timer = setTimeout(() => {
        // A hidden tab does not poll; it picks up again when it is visible.
        const next = document.visibilityState === 'hidden' ? Promise.resolve() : settleDirect()
        void next.catch(() => undefined).then(() => poll(attempt + 1))
      }, recoveryDelay(attempt))
    }

    if (recovered.has(owner.toLowerCase())) {
      poll(0)
    } else {
      recovered.add(owner.toLowerCase())
      void first().catch(() => undefined).then(() => poll(0))
    }
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [owner])

  // `version` changes when a pass finishes, so the list below is read fresh.
  if (version < 0 || !owner) return { pending: [], settled: [] }
  return { pending: pendingSubmissions(owner), settled: [...(settledThisLoad.get(owner.toLowerCase())?.values() ?? [])] }
}
