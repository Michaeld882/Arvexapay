import { NETWORK_LABEL } from '@/chain'
import { ConnectGate } from '@/components/ConnectGate'
import { AddressCard, NetworkInfo } from '@/components/NetworkInfo'
import { Banner, Card, PageHeader } from '@/components/ui'

export default function Receive() {
  return (
    <>
      <PageHeader title="Receive" subtitle={`Share your address to receive USDC on ${NETWORK_LABEL}.`} />
      <ConnectGate allowWrongNetwork>
        {(address) => (
          <div className="space-y-5">
            <Card>
              <AddressCard address={address} caption="Scan or copy your Arc Mainnet address" />
            </Card>
            <Banner tone="warn" title="Only send USDC on Arc Mainnet">
              Funds sent on a different network, or other tokens that cannot be recovered, may be lost permanently.
            </Banner>
            <Card>
              <h2 className="display mb-1 text-lg font-semibold">Network information</h2>
              <NetworkInfo />
            </Card>
          </div>
        )}
      </ConnectGate>
    </>
  )
}
