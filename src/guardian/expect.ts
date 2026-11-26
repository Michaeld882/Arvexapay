import { erc20Abi, isAddressEqual, parseEventLogs, type Address, type TransactionReceipt } from 'viem'
import { USDC } from '@/chain'
import { arvexaAbi } from '@/lib/abi'
import type { TxPlan } from '@/lib/plan'
import { permit2Abi } from '@/lib/swapPlan'

/**
 * What a receipt must contain for a transaction to count as VERIFIED. It is written down when the transaction is
 * handed to the wallet and kept with the submission, so after a reload the result can still be checked against the
 * chain without the screen that built the transaction. Values are decimal strings so they survive storage.
 */
export type Expectation =
  | { type: 'erc20-transfer'; token: Address; from?: Address; to?: Address; value: string; atLeast?: boolean }
  | { type: 'erc20-approval'; token: Address; owner: Address; spender: Address; value: string }
  | { type: 'permit2-approval'; permit2: Address; owner: Address; token: Address; spender: Address; value: string }
  | { type: 'vault-event'; event: 'Deposited' | 'Withdrawn'; vault: Address; account: Address; to?: Address; value: string }

const sameAddress = (a: Address, b: Address): boolean => isAddressEqual(a, b)

/** The expected result of a plan, derived from the plan's own call, not from anything in a receipt. */
export function expectationsFor(owner: Address, plan: TxPlan): Expectation[] | undefined {
  const { call } = plan
  const guard = plan.guard
  if (guard?.type === 'swap') {
    return [
      { type: 'erc20-transfer', token: guard.tokenIn, from: owner, value: guard.amountIn.toString() },
      { type: 'erc20-transfer', token: guard.tokenOut, to: owner, value: guard.minAmountOut.toString(), atLeast: true },
    ]
  }
  if (call.type !== 'contract') return undefined
  const args = call.args
  switch (call.functionName) {
    case 'transfer':
      return [{ type: 'erc20-transfer', token: call.address, from: owner, to: args[0] as Address, value: String(args[1]) }]
    case 'approve':
      if (guard?.type === 'permit2-approve') {
        return [{ type: 'permit2-approval', permit2: call.address, owner, token: args[0] as Address, spender: args[1] as Address, value: String(args[2]) }]
      }
      return [{ type: 'erc20-approval', token: call.address, owner, spender: args[0] as Address, value: String(args[1]) }]
    case 'deposit':
      return [
        { type: 'erc20-transfer', token: USDC.address, from: owner, to: call.address, value: String(args[0]) },
        { type: 'vault-event', event: 'Deposited', vault: call.address, account: owner, value: String(args[0]) },
      ]
    case 'withdraw':
      return [
        { type: 'erc20-transfer', token: USDC.address, from: call.address, to: args[0] as Address, value: String(args[1]) },
        { type: 'vault-event', event: 'Withdrawn', vault: call.address, account: owner, to: args[0] as Address, value: String(args[1]) },
      ]
    default:
      return undefined
  }
}

export interface ExpectationResult {
  ok: boolean
  /** Which expectations were not found in the receipt. */
  missing: string[]
}

/** Checks a receipt's logs against the expectations. Pure: it reads nothing, so it can never claim more than the logs show. */
export function verifyExpectations(expectations: readonly Expectation[], receipt: TransactionReceipt): ExpectationResult {
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
  const approvals = parseEventLogs({ abi: erc20Abi, eventName: 'Approval', logs: receipt.logs })
  const permit2Approvals = parseEventLogs({ abi: permit2Abi, eventName: 'Approval', logs: receipt.logs })
  const deposited = parseEventLogs({ abi: arvexaAbi, eventName: 'Deposited', logs: receipt.logs })
  const withdrawn = parseEventLogs({ abi: arvexaAbi, eventName: 'Withdrawn', logs: receipt.logs })
  const missing: string[] = []

  for (const expectation of expectations) {
    const value = BigInt(expectation.value)
    let found = false
    switch (expectation.type) {
      case 'erc20-transfer':
        found = transfers.some(
          (log) =>
            sameAddress(log.address, expectation.token) &&
            (!expectation.from || sameAddress(log.args.from, expectation.from)) &&
            (!expectation.to || sameAddress(log.args.to, expectation.to)) &&
            (expectation.atLeast ? log.args.value >= value : log.args.value === value),
        )
        if (!found) missing.push('token transfer')
        break
      case 'erc20-approval':
        found = approvals.some((log) => sameAddress(log.address, expectation.token) && sameAddress(log.args.owner, expectation.owner) && sameAddress(log.args.spender, expectation.spender) && log.args.value === value)
        if (!found) missing.push('approval')
        break
      case 'permit2-approval':
        found = permit2Approvals.some(
          (log) => sameAddress(log.address, expectation.permit2) && sameAddress(log.args.owner, expectation.owner) && sameAddress(log.args.token, expectation.token) && sameAddress(log.args.spender, expectation.spender) && log.args.amount === value,
        )
        if (!found) missing.push('router allowance')
        break
      case 'vault-event':
        found =
          expectation.event === 'Deposited'
            ? deposited.some((log) => sameAddress(log.address, expectation.vault) && sameAddress(log.args.account, expectation.account) && log.args.amount === value)
            : withdrawn.some((log) => sameAddress(log.address, expectation.vault) && sameAddress(log.args.account, expectation.account) && (!expectation.to || sameAddress(log.args.to, expectation.to)) && log.args.amount === value)
        if (!found) missing.push(`vault ${expectation.event.toLowerCase()} event`)
        break
    }
  }
  return { ok: missing.length === 0, missing }
}
