import { useAccount } from 'wagmi'

export type AppGate = 'splash' | 'intro' | 'app'

/**
 * What the app shows first, driven only by the live wallet state (nothing is stored):
 * - `intro`: no wallet connected. The animated intro stays up for as long as the wallet is disconnected, with no
 *   timer and no skip. Connect Wallet on it opens the existing wallet modal.
 * - `app`: a wallet is connected, so the existing app shows straight away.
 * - `splash`: a saved wallet session is being restored, so neither screen flashes before we know.
 */
export function useAppGate(): AppGate {
  const { status } = useAccount()
  if (status === 'connected') return 'app'
  if (status === 'reconnecting') return 'splash'
  return 'intro'
}
