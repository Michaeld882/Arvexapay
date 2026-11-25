import { ARVEXA, ARVEXA_ADDRESS } from '@/chain'
import { useVaultState } from '@/hooks/useChainData'

/** Single place that decides whether contract-dependent actions are allowed. */
export function useVault() {
  const vault = useVaultState()
  return {
    vault,
    isReady: vault.state === 'ready',
    isPaused: vault.state === 'ready' && vault.paused,
    address: ARVEXA_ADDRESS,
    /**
     * True when a valid address is configured. Vault reads (balance, allowance) may start in parallel with
     * the contract check; their results are only ever shown once `isReady` is true.
     */
    configured: ARVEXA.status === 'configured',
  }
}
