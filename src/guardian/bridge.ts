import type { StepName, TransferRecord } from '@/circle/cctp'

/**
 * The cross-chain timeline of a CCTP bridge, from real facts only.
 *
 * Source transaction -> Bridge processing -> Destination transaction -> Destination confirmation -> Final verification
 *
 * A stage is "done" only when its own proof exists, and never when an earlier stage is not done. So a confirmed burn
 * on the source chain can never make the transfer look finished: the destination has to show the mint first.
 */

export type BridgeStageId = 'source' | 'processing' | 'destination' | 'confirmation' | 'verification'
export type BridgeStageState = 'done' | 'active' | 'waiting' | 'failed'

export interface BridgeStage {
  id: BridgeStageId
  label: string
  state: BridgeStageState
  /** A real transaction hash, when the stage has one. */
  hash?: string
  detail?: string
}

const step = (record: TransferRecord, name: StepName) => record.steps.find((item) => item.name === name)

function fromStep(name: StepName, record: TransferRecord): { state: BridgeStageState; hash?: string; message?: string } {
  const found = step(record, name)
  if (!found) return { state: 'waiting' }
  if (found.state === 'success') return { state: 'done', hash: found.txHash }
  if (found.state === 'error') return { state: 'failed', hash: found.txHash, message: found.message }
  if (found.state === 'active') return { state: 'active', hash: found.txHash }
  return { state: 'waiting' }
}

export function bridgeStages(record: TransferRecord): BridgeStage[] {
  const approve = fromStep('approve', record)
  const burn = fromStep('burn', record)
  const attestation = fromStep('fetchAttestation', record)
  const mint = fromStep('mint', record)

  // Source: the approval and the burn must both be confirmed. A failure of either is a failure of the source stage.
  const source: BridgeStage = {
    id: 'source',
    label: 'Source transaction',
    state: burn.state === 'done' && approve.state !== 'failed' ? 'done' : approve.state === 'failed' || burn.state === 'failed' ? 'failed' : approve.state === 'active' || burn.state === 'active' || approve.state === 'done' ? 'active' : 'waiting',
    hash: burn.hash,
    detail: burn.message ?? approve.message,
  }
  const processing: BridgeStage = { id: 'processing', label: 'Bridge processing', state: attestation.state, hash: undefined, detail: attestation.message }
  const destination: BridgeStage = { id: 'destination', label: 'Destination transaction', state: mint.state, hash: mint.hash, detail: mint.message }
  const verified = record.state === 'success' && Boolean(record.mintHash)
  const arrived = Boolean(record.mintHash)
  const confirmation: BridgeStage = {
    id: 'confirmation',
    label: 'Destination confirmation',
    state: arrived ? 'done' : record.state === 'confirming' || record.state === 'unconfirmed' ? 'active' : 'waiting',
    hash: record.mintHash,
    detail: record.state === 'unconfirmed' ? record.error : undefined,
  }
  const verification: BridgeStage = {
    id: 'verification',
    label: 'Final verification',
    state: verified ? 'done' : 'waiting',
  }

  const stages = [source, processing, destination, confirmation, verification]
  // Monotonic: nothing after a stage that is not done may be shown as done.
  let open = false
  return stages.map((stage) => {
    if (open && stage.state === 'done') return { ...stage, state: 'waiting' as const }
    if (stage.state !== 'done') open = true
    return stage
  })
}

/** "Completed" is allowed only once the destination result was read back and matched. */
export const isBridgeCompleted = (record: TransferRecord): boolean => bridgeStages(record).every((stage) => stage.state === 'done') && record.state === 'success'
