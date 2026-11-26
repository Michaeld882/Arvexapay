import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { newTransferRecord, type StepName, type StepState, type TransferRecord } from '../src/circle/cctp'
import { bridgeStages, isBridgeCompleted } from '../src/guardian/bridge'
import { chainKey, loadCctpChains } from '../src/circle/sdk'

const OWNER = '0x2222222222222222222222222222222222222222' as Address

async function record(steps: Partial<Record<StepName, StepState>>, extra: Partial<TransferRecord> = {}): Promise<TransferRecord> {
  const { sources } = await loadCctpChains()
  const base = newTransferRecord({ owner: OWNER, source: sources.find((chain) => chainKey(chain) === 'Arbitrum') ?? sources[0], amount: '10', recipient: OWNER, speed: 'FAST', useForwarder: true })
  return { ...base, steps: base.steps.map((item) => ({ ...item, state: steps[item.name] ?? 'idle' })), ...extra }
}
const states = (stages: ReturnType<typeof bridgeStages>) => stages.map((stage) => stage.state)

describe('bridge tracking: source, processing, destination, confirmation, verification', () => {
  test('a confirmed burn alone is not a finished bridge', async () => {
    const r = await record({ approve: 'success', burn: 'success', fetchAttestation: 'active' }, { state: 'pending' })
    expect(states(bridgeStages(r))).toEqual(['done', 'active', 'waiting', 'waiting', 'waiting'])
    expect(isBridgeCompleted(r)).toBe(false)
  })

  test('the kit saying the mint is done is not verification: Arc has to show it first', async () => {
    const r = await record({ approve: 'success', burn: 'success', fetchAttestation: 'success', mint: 'success' }, { state: 'unconfirmed', error: 'No mint found yet.' })
    expect(states(bridgeStages(r))).toEqual(['done', 'done', 'done', 'active', 'waiting'])
    expect(isBridgeCompleted(r)).toBe(false)
  })

  test('only a mint read back from Arc completes every stage', async () => {
    const r = await record({ approve: 'success', burn: 'success', fetchAttestation: 'success', mint: 'success' }, { state: 'success', mintHash: `0x${'34'.repeat(32)}`, received: '9.99' })
    expect(states(bridgeStages(r))).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(isBridgeCompleted(r)).toBe(true)
  })

  test('a failure shows where it stopped, and nothing after it can show as done', async () => {
    const approveOnly = await record({ approve: 'success', burn: 'error' }, { state: 'error' })
    expect(states(bridgeStages(approveOnly))).toEqual(['failed', 'waiting', 'waiting', 'waiting', 'waiting'])
    const attestation = await record({ approve: 'success', burn: 'success', fetchAttestation: 'error' }, { state: 'error' })
    expect(states(bridgeStages(attestation))).toEqual(['done', 'failed', 'waiting', 'waiting', 'waiting'])
  })

  test('an inconsistent record cannot show a later stage as done ahead of an earlier one', async () => {
    const odd = await record({ approve: 'success', burn: 'active', mint: 'success' }, { state: 'success', mintHash: `0x${'56'.repeat(32)}` })
    const result = bridgeStages(odd)
    expect(result[0].state).not.toBe('done')
    expect(result.slice(1).every((stage) => stage.state !== 'done')).toBe(true)
    expect(isBridgeCompleted(odd)).toBe(false)
  })

  test('a transfer that has not started shows everything waiting', async () => {
    expect(states(bridgeStages(await record({}, { state: 'pending' })))).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'waiting'])
  })
})
