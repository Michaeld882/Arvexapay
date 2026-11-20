import { useQuery } from '@tanstack/react-query'
import { erc20Abi, isAddressEqual, type Address } from 'viem'
import { ARC_CHAIN_ID, ARVEXA, ARVEXA_ADDRESS, USDC } from '@/chain'
import { arvexaAbi } from '@/lib/abi'
import { isTransientError } from '@/lib/errors'
import { getArcClient } from '@/lib/rpc'

const BALANCE_REFRESH_MS = 60_000

/** A call that reverts means "not an Arvexa vault"; an RPC failure must stay an error. */
function ignoreContractMismatch(err: unknown): undefined {
  if (isTransientError(err)) throw err
  return undefined
}

/** Wallet USDC (ERC-20 view, 6 decimals). On Arc this is the same pool that pays gas. */
export function useWalletUsdc(address: Address | undefined) {
  return useQuery({
    queryKey: ['arvexa', 'usdc-balance', ARC_CHAIN_ID, address],
    enabled: Boolean(address),
    refetchInterval: BALANCE_REFRESH_MS,
    // Coming back to the tab refreshes a balance that is more than 15 s old: one cheap read.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: () =>
      getArcClient().readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as Address],
      }),
  })
}

export type VaultState =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'checking' }
  | { state: 'error' }
  | { state: 'no-code' }
  | { state: 'usdc-mismatch' }
  | { state: 'ready'; paused: boolean }

/** Confirms the configured address really is an Arvexa vault for the official USDC. */
export function useVaultState(): VaultState & { refetch: () => void } {
  const query = useQuery({
    queryKey: ['arvexa', 'vault-state', ARC_CHAIN_ID, ARVEXA_ADDRESS],
    enabled: Boolean(ARVEXA_ADDRESS),
    staleTime: 120_000,
    queryFn: async () => {
      const client = getArcClient()
      const address = ARVEXA_ADDRESS as Address
      const [code, usdc, paused] = await Promise.all([
        client.getCode({ address }),
        client.readContract({ address, abi: arvexaAbi, functionName: 'USDC' }).catch(ignoreContractMismatch),
        client.readContract({ address, abi: arvexaAbi, functionName: 'paused' }).catch(ignoreContractMismatch),
      ])
      return { hasCode: Boolean(code && code !== '0x'), usdc, paused }
    },
  })

  const refetch = () => void query.refetch()
  if (ARVEXA.status === 'missing') return { state: 'missing', refetch }
  if (ARVEXA.status === 'invalid') return { state: 'invalid', refetch }
  if (query.isPending) return { state: 'checking', refetch }
  if (query.isError) return { state: 'error', refetch }
  const { hasCode, usdc, paused } = query.data
  if (!hasCode) return { state: 'no-code', refetch }
  if (!usdc || !isAddressEqual(usdc, USDC.address) || paused === undefined) return { state: 'usdc-mismatch', refetch }
  return { state: 'ready', paused, refetch }
}

/** USDC held for the user inside the Arvexa vault contract. */
export function useVaultBalance(address: Address | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['arvexa', 'vault-balance', ARC_CHAIN_ID, ARVEXA_ADDRESS, address],
    enabled: Boolean(address) && enabled,
    refetchInterval: BALANCE_REFRESH_MS,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: () =>
      getArcClient().readContract({
        address: ARVEXA_ADDRESS as Address,
        abi: arvexaAbi,
        functionName: 'balanceOf',
        args: [address as Address],
      }),
  })
}

/** How much USDC the vault may pull from the user. */
export function useVaultAllowance(address: Address | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['arvexa', 'allowance', ARC_CHAIN_ID, ARVEXA_ADDRESS, address],
    enabled: Boolean(address) && enabled,
    staleTime: 15_000,
    queryFn: () =>
      getArcClient().readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address as Address, ARVEXA_ADDRESS as Address],
      }),
  })
}
