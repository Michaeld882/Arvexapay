import { ARVEXA_ADDRESS } from '@/chain'
import { useVaultState } from '@/hooks/useChainData'

/** Single place that decides whether contract-dependent actions are allowed. */
export function useVault() {
  const vault = useVaultState()
  return {
    vault,
    isReady: vault.state === 'ready',
    isPaused: vault.state === 'ready' && vault.paused,
    address: ARVEXA_ADDRESS,
  }
}
