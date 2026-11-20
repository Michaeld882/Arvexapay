import { ConnectKitButton } from 'connectkit'
import { Wallet } from 'lucide-react'
import { shortAddress } from '@/lib/format'
import { Button } from '@/components/ui'

export function WalletButton({ className }: { className?: string }) {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, show, address }) => (
        <Button
          variant={isConnected ? 'secondary' : 'primary'}
          onClick={() => show?.()}
          className={className}
        >
          <Wallet className="size-4" aria-hidden />
          {isConnected && address ? <span className="mono text-xs">{shortAddress(address)}</span> : 'Connect wallet'}
        </Button>
      )}
    </ConnectKitButton.Custom>
  )
}
