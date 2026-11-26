import { useAccount } from 'wagmi'

export type AppGate = 'intro' | 'app'

/**
 * What the app shows first, driven only by the live wallet state (nothing is stored):
 * - `intro`: no wallet connected. The animated intro stays up for as long as the wallet is disconnected, with no
 *   timer and no skip. Connect Wallet on it opens the existing wallet modal.
 * - `app`: a wallet is connected, or a saved session is being restored (wagmi only reports that state when a saved
 *   session exists). The app shell shows straight away with skeletons instead of a blank screen; if restoring fails
 *   the wallet becomes disconnected and the intro takes over.
 */
export function useAppGate(): AppGate {
  const { status } = useAccount()
  return status === 'connected' || status === 'reconnecting' ? 'app' : 'intro'
}
