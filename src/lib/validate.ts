import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'
import { ARVEXA_ADDRESS, USDC } from '@/chain'
import { AmountError, parseUsdc } from '@/onchain-money'

export type AmountCheck =
  | { ok: true; raw: bigint }
  | { ok: false; empty: boolean; message: string }

/** Parses user input into 6-decimal USDC base units. Rejects zero, negatives and extra decimals. */
export function checkAmount(input: string): AmountCheck {
  const value = input.trim()
  if (value === '') return { ok: false, empty: true, message: 'Enter an amount.' }
  if (!/^\d*\.?\d*$/.test(value) || value === '.') {
    return { ok: false, empty: false, message: 'Enter a valid positive number.' }
  }
  try {
    const raw = parseUsdc(value)
    if (raw <= 0n) return { ok: false, empty: false, message: 'Amount must be greater than zero.' }
    return { ok: true, raw }
  } catch (err) {
    if (err instanceof AmountError) {
      return { ok: false, empty: false, message: 'USDC supports at most 6 decimal places.' }
    }
    return { ok: false, empty: false, message: 'Enter a valid amount.' }
  }
}

export type AddressCheck =
  | { ok: true; address: Address }
  | { ok: false; empty: boolean; message: string }

export interface AddressRules {
  /** Block sending to the Arvexa vault directly (that would not credit a deposit). */
  blockVault?: boolean
}

/** Validates a recipient. Mixed-case input must pass its EIP-55 checksum. */
export function checkRecipient(input: string, rules: AddressRules = { blockVault: true }): AddressCheck {
  const value = input.trim()
  if (value === '') return { ok: false, empty: true, message: 'Enter a recipient address.' }
  if (!isAddress(value)) {
    return { ok: false, empty: false, message: 'Not a valid address. Check every character, including the checksum.' }
  }
  const address = getAddress(value)
  if (isAddressEqual(address, zeroAddress)) {
    return { ok: false, empty: false, message: 'The zero address cannot receive funds.' }
  }
  if (isAddressEqual(address, USDC.address)) {
    return { ok: false, empty: false, message: 'That is the USDC token contract, not a wallet. Funds sent there would be lost.' }
  }
  if (rules.blockVault && ARVEXA_ADDRESS && isAddressEqual(address, ARVEXA_ADDRESS)) {
    return { ok: false, empty: false, message: 'That is the Arvexa vault. Use Deposit to add funds to it.' }
  }
  return { ok: true, address }
}
