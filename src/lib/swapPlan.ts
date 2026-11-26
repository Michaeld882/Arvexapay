import { erc20Abi, isAddressEqual, parseAbi, parseEventLogs, type Address } from 'viem'
import { USDC } from '@/chain'
import type { SwapQuote, SwapRequest, SwapTransaction } from '@/swap-config'
import { AppError } from '@/lib/errors'
import { formatUnitsFixed } from '@/onchain-money'
import type { TxPlan } from '@/lib/plan'

const display = (raw: bigint, decimals: number) => formatUnitsFixed(raw, decimals, Math.min(decimals, 6))

const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)',
])

export { permit2Abi }

/** Step 1 of a first swap: let Permit2 pull exactly the amount being swapped (an ERC-20 approval). */
export function buildSwapApprovePlan(owner: Address, request: SwapRequest, spender: Address): TxPlan {
  const { tokenIn, amountIn } = request
  return {
    kind: 'approve',
    title: `Approve ${tokenIn.symbol} for swapping`,
    confirmLabel: 'Confirm approval',
    successText: 'Approval confirmed. Continue to the next step.',
    rows: [
      { label: 'Allowance', value: `${display(amountIn, tokenIn.decimals)} ${tokenIn.symbol}` },
      { label: 'Spender (Permit2)', value: spender, mono: true },
    ],
    call: { type: 'contract', address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [spender, amountIn] },
    amount: amountIn,
    guard: { type: 'swap-approve', token: tokenIn.address, spender },
    usdcOutflow: 0n,
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

/** Step 2: let the router spend that amount through Permit2, for a short time only. */
export function buildPermit2ApprovePlan(owner: Address, request: SwapRequest, permit2: Address, router: Address, expiration: number): TxPlan {
  const { tokenIn, amountIn } = request
  return {
    kind: 'approve',
    title: `Allow the swap router to use ${tokenIn.symbol}`,
    confirmLabel: 'Confirm allowance',
    successText: 'Router allowance confirmed. You can review the swap now.',
    rows: [
      { label: 'Allowance', value: `${display(amountIn, tokenIn.decimals)} ${tokenIn.symbol}` },
      { label: 'Router', value: router, mono: true },
      { label: 'Expires', value: new Date(expiration * 1000).toLocaleTimeString() },
    ],
    call: { type: 'contract', address: permit2, abi: permit2Abi, functionName: 'approve', args: [tokenIn.address, router, amountIn, expiration] },
    amount: amountIn,
    guard: { type: 'permit2-approve', token: tokenIn.address, permit2, router, expiration },
    usdcOutflow: 0n,
    verify: (receipt) => {
      const ok = parseEventLogs({ abi: permit2Abi, eventName: 'Approval', logs: receipt.logs }).some(
        (log) =>
          isAddressEqual(log.address, permit2) &&
          isAddressEqual(log.args.owner, owner) &&
          isAddressEqual(log.args.token, tokenIn.address) &&
          isAddressEqual(log.args.spender, router) &&
          log.args.amount === amountIn,
      )
      if (!ok) throw new AppError('unverified', 'Permit2 approval event not found')
    },
  }
}

/** A swap is verified only if tokenIn left the wallet, and tokenOut reached the recipient and met the minimum. */
export function buildSwapPlan(request: SwapRequest, quote: SwapQuote, tx: SwapTransaction): TxPlan {
  const { tokenIn, tokenOut, amountIn, recipient } = request
  const rows = [
    { label: 'You pay', value: `${display(amountIn, tokenIn.decimals)} ${tokenIn.symbol}` },
    { label: 'You receive (est.)', value: `${display(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}` },
    { label: 'Minimum received', value: `${display(quote.minAmountOut, tokenOut.decimals)} ${tokenOut.symbol}` },
    { label: 'Slippage limit', value: `${(request.slippageBps / 100).toFixed(2)}%` },
  ]
  if (quote.routeLabel) rows.push({ label: 'Route', value: quote.routeLabel })
  if (quote.priceImpact !== undefined) rows.push({ label: 'Price impact', value: `${(quote.priceImpact * 100).toFixed(2)}%` })
  return {
    kind: 'swap',
    title: `Swap ${tokenIn.symbol} to ${tokenOut.symbol}`,
    confirmLabel: 'Confirm swap',
    successText: 'Swap confirmed and verified onchain.',
    rows,
    call: { type: 'raw', to: tx.to, data: tx.data, value: tx.value },
    amount: amountIn,
    guard: {
      type: 'swap',
      router: tx.to,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn,
      amountOut: quote.amountOut,
      minAmountOut: quote.minAmountOut,
      slippageBps: request.slippageBps,
      priceImpact: quote.priceImpact,
      deadline: tx.deadline ?? quote.deadline,
      quotedAt: Date.now(),
    },
    usdcOutflow: isAddressEqual(tokenIn.address, USDC.address) ? amountIn : 0n,
    verify: (receipt) => {
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
      const paid = transfers.some((log) => isAddressEqual(log.address, tokenIn.address) && isAddressEqual(log.args.from, recipient) && log.args.value === amountIn)
      const received = transfers
        .filter((log) => isAddressEqual(log.address, tokenOut.address) && isAddressEqual(log.args.to, recipient) && log.args.value >= quote.minAmountOut)
        .sort((a, b) => (a.args.value === b.args.value ? 0 : a.args.value > b.args.value ? -1 : 1))[0]
      if (!paid) throw new AppError('unverified', `No ${tokenIn.symbol} Transfer from your wallet for the swap amount was found`)
      if (!received) throw new AppError('unverified', `No ${tokenOut.symbol} Transfer to your wallet met the minimum`)
      return `Swapped ${display(amountIn, tokenIn.decimals)} ${tokenIn.symbol} for ${display(received.args.value, tokenOut.decimals)} ${tokenOut.symbol}, verified onchain.`
    },
  }
}
