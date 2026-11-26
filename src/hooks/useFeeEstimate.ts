import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { ARC_CHAIN_ID } from '@/chain'
import type { PlannedCall } from '@/lib/plan'
import { getArcClient } from '@/lib/rpc'
import { dedupedRead } from '@/guardian/retry'
import { Amount, gasTokenDecimalsFor, gasTokenToUsdc } from '@/onchain-money'

export interface FeeEstimate {
  gas: bigint
  /** Upper-bound network fee in 6-decimal USDC base units (rounded up). */
  feeUsdc: bigint
}

const GAS_BUFFER_NUM = 12n
const GAS_BUFFER_DEN = 10n

async function estimate(call: PlannedCall, account: Address): Promise<FeeEstimate> {
  const client = getArcClient()
  const [gas, perGas] = await Promise.all([
    call.type === 'contract'
      ? client.estimateContractGas({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, account })
      : client.estimateGas({ account, to: call.to, data: call.data, value: call.value }),
    client
      .estimateFeesPerGas()
      .then((fees) => fees.maxFeePerGas ?? fees.gasPrice ?? 0n)
      .catch(() => client.getGasPrice()),
  ])
  const gasLimit = (gas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN
  // Gas is paid in the native view of USDC (18 decimals); rescale through the shared helper.
  const native = Amount.fromRaw(gasLimit * perGas, gasTokenDecimalsFor(ARC_CHAIN_ID))
  const truncated = gasTokenToUsdc(ARC_CHAIN_ID, native, 'trunc').raw
  return { gas: gasLimit, feeUsdc: truncated + 1n }
}

const callKey = (call: PlannedCall, account: Address): string =>
  call.type === 'contract'
    ? `fee:${account}:${call.address}:${call.functionName}:${call.args.map((arg) => String(arg)).join(',')}`
    : `fee:${account}:${call.to}:${call.data}:${call.value}`

/**
 * The fee estimate, shared: the review screen and the Guardian ask for the same estimate at the same moment, so they
 * share one request. `fresh` skips the short cache for the final check right before signing.
 */
export function estimateFee(call: PlannedCall, account: Address, options: { fresh?: boolean } = {}): Promise<FeeEstimate> {
  return dedupedRead(callKey(call, account), 15_000, () => estimate(call, account), { fresh: options.fresh })
}

/** Simulates the call (so reverts surface before signing) and prices the network fee. */
export function useFeeEstimate(call: PlannedCall | null, account: Address | undefined) {
  const argsKey = !call ? '' : call.type === 'contract' ? call.args.map((arg) => String(arg)).join(',') : `${call.data}:${call.value}`
  return useQuery({
    queryKey: ['arvexa', 'fee', account, call?.type === 'contract' ? call.address : call?.to, call?.type === 'contract' ? call.functionName : 'raw', argsKey],
    enabled: Boolean(call && account),
    staleTime: 20_000,
    gcTime: 60_000,
    queryFn: () => estimateFee(call as PlannedCall, account as Address),
  })
}
