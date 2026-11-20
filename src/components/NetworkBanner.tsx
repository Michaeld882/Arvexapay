import { NETWORK_LABEL } from '@/chain'
import { useWallet } from '@/hooks/useWallet'
import { Banner, Button } from '@/components/ui'

/** Shown whenever the connected wallet is not on Arc Mainnet. No transaction can start from here. */
export function NetworkBanner() {
  const { wrongNetwork, switchToArc, isSwitching } = useWallet()
  if (!wrongNetwork) return null
  return (
    <Banner
      tone="danger"
      title="Wrong network"
      className="mb-5"
      action={
        <Button onClick={() => void switchToArc()} loading={isSwitching} className="min-h-10">
          Switch to {NETWORK_LABEL}
        </Button>
      }
    >
      Your wallet is on a different network. Arvexa only works on {NETWORK_LABEL}, so transactions are disabled until you switch.
    </Banner>
  )
}
