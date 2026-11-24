import { useMemo } from 'react'
import { erc20Abi, type Address } from 'viem'
import { USDC } from '@/chain'
import { useWalletUsdc } from '@/hooks/useChainData'
import { useFeeEstimate } from '@/hooks/useFeeEstimate'
import type { PlannedCall } from '@/lib/plan'

/**
 * Only used to price a transfer. It is never sent: the estimate uses an address that holds nothing, which is
 * the more expensive case for a transfer, so the reserve it produces is on the safe side.
 */
const FEE_PROBE_RECIPIENT: Address = '0x000000000000000000000000000000000000dEaD'

/**
 * Wallet USDC that can actually be spent. On Arc the network fee is paid in the same USDC, so the spendable
 * amount is the balance minus an upper-bound fee for one transfer. The balance is the onchain ERC-20 view.
 */
export function useSpendableUsdc(address: Address) {
  const balance = useWalletUsdc(address)
  const hasFunds = balance.data !== undefined && balance.data > 1n
  const probe = useMemo<PlannedCall | null>(
    () => (hasFunds ? { type: 'contract', address: USDC.address, abi: erc20Abi, functionName: 'transfer', args: [FEE_PROBE_RECIPIENT, 1n] } : null),
    [hasFunds],
  )
  const fee = useFeeEstimate(probe, address)
  const feeUsdc = fee.data?.feeUsdc
  const spendable = balance.data === undefined ? undefined : feeUsdc === undefined ? undefined : balance.data > feeUsdc ? balance.data - feeUsdc : 0n
  return { balance, feeUsdc, spendable, feePending: hasFunds && fee.isPending }
}
