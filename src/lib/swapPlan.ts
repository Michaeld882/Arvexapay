import { erc20Abi, isAddressEqual, parseEventLogs, type Address } from 'viem'
import type { SwapQuote, SwapRequest, SwapTransaction } from '@/swap-config'
import { AppError } from '@/lib/errors'
import { formatUnitsFixed } from '@/onchain-money'
import type { TxPlan } from '@/lib/plan'

const display = (raw: bigint, decimals: number) => formatUnitsFixed(raw, decimals, Math.min(decimals, 6))

/** Approval for a swap provider's spender, for exactly the amount being swapped. */
export function buildSwapApprovePlan(owner: Address, request: SwapRequest, spender: Address): TxPlan {
  const { tokenIn, amountIn } = request
  return {
    kind: 'approve',
    title: `Approve ${tokenIn.symbol} for swap`,
    confirmLabel: 'Confirm approval',
    successText: 'Approval confirmed. Review the swap next.',
    rows: [
      { label: 'Allowance', value: `${display(amountIn, tokenIn.decimals)} ${tokenIn.symbol}` },
      { label: 'Spender', value: spender, mono: true },
    ],
    call: { type: 'contract', address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [spender, amountIn] },
    amount: amountIn,
    verify: (receipt) => {
      const ok = parseEventLogs({ abi: erc20Abi, eventName: 'Approval', logs: receipt.logs }).some(
        (log) =>
          isAddressEqual(log.address, tokenIn.address) &&
          isAddressEqual(log.args.owner, owner) &&
          isAddressEqual(log.args.spender, spender) &&
          log.args.value === amountIn,
      )
      if (!ok) throw new AppError('unverified', 'Approval event not found')
    },
  }
}

/** A swap is verified only if tokenOut actually reached the recipient and met the minimum. */
export function buildSwapPlan(request: SwapRequest, quote: SwapQuote, tx: SwapTransaction): TxPlan {
  const { tokenIn, tokenOut, amountIn, recipient } = request
  return {
    kind: 'swap',
    title: `Swap ${tokenIn.symbol} to ${tokenOut.symbol}`,
    confirmLabel: 'Confirm swap',
    successText: 'Swap confirmed and verified onchain.',
    rows: [
      { label: 'You pay', value: `${display(amountIn, tokenIn.decimals)} ${tokenIn.symbol}` },
      { label: 'You receive (est.)', value: `${display(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}` },
      { label: 'Minimum received', value: `${display(quote.minAmountOut, tokenOut.decimals)} ${tokenOut.symbol}` },
      { label: 'Slippage', value: `${(request.slippageBps / 100).toFixed(2)}%` },
    ],
    call: { type: 'raw', to: tx.to, data: tx.data, value: tx.value },
    amount: amountIn,
    verify: (receipt) => {
      const received = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).some(
        (log) =>
          isAddressEqual(log.address, tokenOut.address) &&
          isAddressEqual(log.args.to, recipient) &&
          log.args.value >= quote.minAmountOut,
      )
      if (!received) throw new AppError('unverified', 'No tokenOut Transfer to the recipient met the minimum')
    },
  }
}
