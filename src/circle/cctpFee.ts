import { formatUsdc, parseUsdc } from '@/onchain-money'

/**
 * CCTP v2 burn fee rules.
 *
 * The burn on the source chain carries a `maxFee`. Circle's contract reverts the burn ("Max fee must be less than
 * amount") unless `maxFee < amount`. The App Kit sets `maxFee` to the Circle protocol fee (fast transfers, with a
 * 10% safety margin) plus the forwarding fee when Circle submits the mint. Both fees are quoted in USDC, and the kit
 * reports them as decimal text, while the burn compares 6-decimal base units. Everything here converts to base units
 * first, so a human-readable fee is never compared with a raw amount.
 */

export const FEE_TOO_SMALL_MESSAGE = 'Amount is too small for the current CCTP fee. Please enter a larger amount.'

/** The fee kinds that make up the burn's `maxFee`. A custom service fee is charged separately and is not part of it. */
const BURN_FEE_TYPES: ReadonlySet<string> = new Set(['provider', 'forwarder'])

export interface QuotedFee {
  type?: string
  /** USDC as decimal text (for example "0.2"), exactly as the kit reports it. */
  amount: string
}

/** The burn's `maxFee` in 6-decimal base units: the quoted protocol fee plus the forwarding fee. */
export function maxFeeFromQuote(fees: readonly QuotedFee[]): bigint {
  return fees.reduce((sum, fee) => (fee.type && BURN_FEE_TYPES.has(fee.type) ? sum + parseUsdc(fee.amount) : sum), 0n)
}

export type BurnFeeCheck =
  | { ok: true; maxFee: bigint }
  | { ok: false; maxFee: bigint; message: string }

/** Both values are 6-decimal base units. The burn is only valid while `maxFee < amount`. */
export function checkBurnFee(amount: bigint, maxFee: bigint): BurnFeeCheck {
  if (maxFee < amount) return { ok: true, maxFee }
  return { ok: false, maxFee, message: `${FEE_TOO_SMALL_MESSAGE} The fee is ${formatUsdc(maxFee)} USDC, so the amount must be more than that.` }
}

/** True for the contract's own wording, so a late revert reads the same as the early check. */
export const isMaxFeeRevert = (message: string): boolean => /max\s*fee must be less than amount/i.test(message)
