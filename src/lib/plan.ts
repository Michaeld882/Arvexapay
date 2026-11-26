import { erc20Abi, isAddressEqual, parseEventLogs, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { ARVEXA_ADDRESS, USDC } from '@/chain'
import { arvexaAbi } from '@/lib/abi'
import { AppError } from '@/lib/errors'
import type { LocalTxKind } from '@/lib/txLog'
import type { TxMeta } from '@/lib/txMeta'
import { formatUsdcDisplay, shortAddress } from '@/lib/format'

export interface ContractCall {
  type: 'contract'
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
}

/** A prebuilt transaction, used by swap providers that return calldata. */
export interface RawCall {
  type: 'raw'
  to: Address
  data: Hex
  value: bigint
}

export type PlannedCall = ContractCall | RawCall

export interface SummaryRow {
  label: string
  value: string
  mono?: boolean
}

/**
 * What a transaction is allowed to be, stated by whoever built the plan (the swap builders). The Guardian checks the
 * encoded call against this and against the app's own list of verified addresses, never against the plan's claim alone.
 */
export type PlanGuard =
  | { type: 'swap-approve'; token: Address; spender: Address }
  | { type: 'permit2-approve'; token: Address; permit2: Address; router: Address; expiration: number }
  | {
      type: 'swap'
      router: Address
      tokenIn: Address
      tokenOut: Address
      amountIn: bigint
      amountOut: bigint
      minAmountOut: bigint
      slippageBps: number
      priceImpact?: number
      /** Unix seconds the router rejects the transaction after. */
      deadline: number
      /** Unix milliseconds when the quote behind this plan was read. */
      quotedAt: number
    }

/** Everything the confirmation screen and the receipt verifier need for one transaction. */
export interface TxPlan {
  kind: LocalTxKind
  title: string
  confirmLabel: string
  successText: string
  rows: SummaryRow[]
  call: PlannedCall
  amount: bigint
  to?: Address
  /** Set by plan builders whose calls go beyond USDC and the Arvexa vault (swaps). */
  guard?: PlanGuard
  /** USDC that leaves the wallet in this transaction, when it differs from `amount` (for example a swap that sells USDC). */
  usdcOutflow?: bigint
  /** An optional local note and category. Saved in this browser against the real hash once the wallet submits; never sent onchain. */
  meta?: TxMeta
  /**
   * Throws AppError('unverified') if the receipt lacks the expected onchain events.
   * May return a sentence describing what the verified logs showed (for example the amount received).
   */
  verify: (receipt: TransactionReceipt) => string | void
}

const unverified = (what: string) => new AppError('unverified', `Expected ${what} was not found in the receipt logs`)

function usdcTransfers(receipt: TransactionReceipt) {
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).filter((log) =>
    isAddressEqual(log.address, USDC.address),
  )
}

function requireVault(): Address {
  if (!ARVEXA_ADDRESS) throw new AppError('contract_not_configured')
  return ARVEXA_ADDRESS
}

export interface SendLabels {
  title: string
  confirmLabel: string
  successText: string
}

const SEND_LABELS: SendLabels = { title: 'Send USDC', confirmLabel: 'Confirm and send', successText: 'USDC sent and verified onchain.' }
export const WALLET_WITHDRAW_LABELS: SendLabels = { title: 'Cash Out USDC', confirmLabel: 'Confirm cash out', successText: 'Cash out confirmed and verified onchain.' }

export function buildSendPlan(from: Address, to: Address, amount: bigint, labels: SendLabels = SEND_LABELS): TxPlan {
  return {
    kind: 'send',
    title: labels.title,
    confirmLabel: labels.confirmLabel,
    successText: labels.successText,
    rows: [
      { label: 'Amount', value: `${formatUsdcDisplay(amount)} USDC` },
      { label: 'To', value: to, mono: true },
    ],
    call: { type: 'contract', address: USDC.address, abi: erc20Abi, functionName: 'transfer', args: [to, amount] },
    amount,
    to,
    verify: (receipt) => {
      const ok = usdcTransfers(receipt).some(
        (log) => isAddressEqual(log.args.from, from) && isAddressEqual(log.args.to, to) && log.args.value === amount,
      )
      if (!ok) throw unverified('USDC Transfer event')
    },
  }
}

/** Adds an optional note and category to a plan. They show on the review screen and are kept locally; the call itself is untouched. */
export function withMeta(plan: TxPlan, meta: TxMeta): TxPlan {
  if (!meta.note && !meta.category) return plan
  const rows = [...plan.rows]
  if (meta.note) rows.push({ label: 'Note (saved on this device)', value: meta.note })
  if (meta.category) rows.push({ label: 'Category', value: meta.category })
  return { ...plan, rows, meta }
}

export function buildApprovePlan(owner: Address, amount: bigint): TxPlan {
  const vault = requireVault()
  return {
    kind: 'approve',
    title: 'Approve USDC for Arvexa',
    confirmLabel: 'Confirm approval',
    successText: 'Approval confirmed. You can now top up.',
    rows: [
      { label: 'Allowance', value: `${formatUsdcDisplay(amount)} USDC` },
      { label: 'Spender (Arvexa)', value: vault, mono: true },
    ],
    call: { type: 'contract', address: USDC.address, abi: erc20Abi, functionName: 'approve', args: [vault, amount] },
    amount,
    verify: (receipt) => {
      const ok = parseEventLogs({ abi: erc20Abi, eventName: 'Approval', logs: receipt.logs }).some(
        (log) =>
          isAddressEqual(log.address, USDC.address) &&
          isAddressEqual(log.args.owner, owner) &&
          isAddressEqual(log.args.spender, vault) &&
          log.args.value === amount,
      )
      if (!ok) throw unverified('USDC Approval event')
    },
  }
}

export function buildDepositPlan(account: Address, amount: bigint): TxPlan {
  const vault = requireVault()
  return {
    kind: 'deposit',
    title: 'Top Up Arvexa vault',
    confirmLabel: 'Confirm top up',
    successText: 'Top up confirmed and verified onchain.',
    rows: [
      { label: 'Amount', value: `${formatUsdcDisplay(amount)} USDC` },
      { label: 'Vault', value: shortAddress(vault), mono: true },
    ],
    call: { type: 'contract', address: vault, abi: arvexaAbi, functionName: 'deposit', args: [amount] },
    amount,
    verify: (receipt) => {
      const deposited = parseEventLogs({ abi: arvexaAbi, eventName: 'Deposited', logs: receipt.logs }).some(
        (log) => isAddressEqual(log.address, vault) && isAddressEqual(log.args.account, account) && log.args.amount === amount,
      )
      const moved = usdcTransfers(receipt).some(
        (log) => isAddressEqual(log.args.from, account) && isAddressEqual(log.args.to, vault) && log.args.value === amount,
      )
      if (!deposited || !moved) throw unverified('Deposited and USDC Transfer events')
    },
  }
}

export function buildWithdrawPlan(account: Address, to: Address, amount: bigint): TxPlan {
  const vault = requireVault()
  return {
    kind: 'withdraw',
    title: 'Cash Out from Arvexa vault',
    confirmLabel: 'Confirm cash out',
    successText: 'Cash out confirmed and verified onchain.',
    rows: [
      { label: 'Amount', value: `${formatUsdcDisplay(amount)} USDC` },
      { label: 'To', value: to, mono: true },
    ],
    call: { type: 'contract', address: vault, abi: arvexaAbi, functionName: 'withdraw', args: [to, amount] },
    amount,
    to,
    verify: (receipt) => {
      const withdrawn = parseEventLogs({ abi: arvexaAbi, eventName: 'Withdrawn', logs: receipt.logs }).some(
        (log) =>
          isAddressEqual(log.address, vault) &&
          isAddressEqual(log.args.account, account) &&
          isAddressEqual(log.args.to, to) &&
          log.args.amount === amount,
      )
      const moved = usdcTransfers(receipt).some(
        (log) => isAddressEqual(log.args.from, vault) && isAddressEqual(log.args.to, to) && log.args.value === amount,
      )
      if (!withdrawn || !moved) throw unverified('Withdrawn and USDC Transfer events')
    },
  }
}
