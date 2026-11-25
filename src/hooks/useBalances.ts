import type { Address } from 'viem'
import { useVaultBalance, useWalletUsdc } from '@/hooks/useChainData'
import { useVault } from '@/hooks/useVault'

/**
 * Wallet USDC and vault USDC. On Arc the native gas balance is the SAME pool as wallet USDC,
 * so it is never queried or added again. total is undefined whenever a needed read has not succeeded.
 */
export function useBalances(address: Address | undefined) {
  const { isReady: vaultReady, configured } = useVault()
  const wallet = useWalletUsdc(address)
  // Starts alongside the contract check instead of after it; the value is used only once the contract is verified.
  const vault = useVaultBalance(address, configured)

  const walletRaw = wallet.data
  const vaultRaw = vaultReady ? vault.data : 0n
  const total = walletRaw !== undefined && vaultRaw !== undefined ? walletRaw + vaultRaw : undefined

  return {
    wallet,
    vault,
    vaultReady,
    walletRaw,
    vaultRaw: vaultReady ? vault.data : undefined,
    total,
    isFetching: wallet.isFetching || vault.isFetching,
    isLoading: wallet.isPending || (vaultReady && vault.isPending),
    isError: wallet.isError || (vaultReady && vault.isError),
    refetch: () => {
      void wallet.refetch()
      if (vaultReady) void vault.refetch()
    },
  }
}
