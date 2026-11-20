import type { ReactNode } from 'react'
import type { Address } from 'viem'
import { NETWORK_LABEL } from '@/chain'
import { useWallet } from '@/hooks/useWallet'
import { LogoMark } from '@/components/Logo'
import { Button, Card, Skeleton } from '@/components/ui'
import { WalletButton } from '@/components/WalletButton'

interface ConnectGateProps {
  /** Pages that only display the wallet address can render on any network (the banner still warns). */
  allowWrongNetwork?: boolean
  children: (address: Address) => ReactNode
}

/** Renders children only for a connected wallet that is on Arc Mainnet. */
export function ConnectGate({ allowWrongNetwork = false, children }: ConnectGateProps) {
  const { address, status, switchToArc, isSwitching } = useWallet()

  if (status === 'connecting') {
    return (
      <Card className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-12 w-full" />
      </Card>
    )
  }
  if (status === 'disconnected' || !address) {
    return (
      <Card className="flex flex-col items-center gap-4 py-10 text-center">
        <LogoMark size={52} />
        <div>
          <h2 className="display text-lg font-semibold">Connect your wallet</h2>
          <p className="mt-1 text-sm text-muted">Connect a browser wallet on {NETWORK_LABEL} to continue.</p>
        </div>
        <WalletButton />
      </Card>
    )
  }
  if (status === 'wrong-network' && !allowWrongNetwork) {
    return (
      <Card className="flex flex-col items-center gap-4 py-10 text-center">
        <div>
          <h2 className="display text-lg font-semibold">Switch to Arc Mainnet</h2>
          <p className="mt-1 text-sm text-muted">Transactions are disabled until your wallet is on {NETWORK_LABEL}.</p>
        </div>
        <Button onClick={() => void switchToArc()} loading={isSwitching}>
          Switch network
        </Button>
      </Card>
    )
  }
  return <>{children(address)}</>
}
