import { useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { toast } from 'sonner'
import { ARC_CHAIN_ID } from '@/chain'
import { toUserMessage } from '@/lib/errors'

export type WalletStatus = 'disconnected' | 'connecting' | 'wrong-network' | 'ready'

/** Wallet connection plus the Arc Mainnet (5042) guard every action must pass. */
export function useWallet() {
  const { address, isConnected, isConnecting, isReconnecting, chainId } = useAccount()
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain()

  const wrongNetwork = isConnected && chainId !== ARC_CHAIN_ID
  const status: WalletStatus = isConnecting || isReconnecting
    ? 'connecting'
    : !isConnected
      ? 'disconnected'
      : wrongNetwork
        ? 'wrong-network'
        : 'ready'

  const switchToArc = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: ARC_CHAIN_ID })
    } catch (err) {
      toast.error(`${toUserMessage(err)} You can also switch networks manually in your wallet.`)
    }
  }, [switchChainAsync])

  return {
    address: isConnected ? address : undefined,
    chainId,
    status,
    isReady: status === 'ready',
    wrongNetwork,
    isSwitching,
    switchToArc,
  }
}
