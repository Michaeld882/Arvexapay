import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { getArcClient } from '@/lib/rpc'

/** The block time of a confirmed transaction, read from Arc. Undefined while loading or if it cannot be read. */
export function useTxTime(hash: Hex | undefined): number | undefined {
  const query = useQuery({
    queryKey: ['arvexa', 'tx-time', hash],
    enabled: Boolean(hash),
    staleTime: Infinity,
    queryFn: async () => {
      const client = getArcClient()
      const receipt = await client.getTransactionReceipt({ hash: hash as Hex })
      return Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp)
    },
  })
  return query.data
}
