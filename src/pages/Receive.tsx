import { useState } from 'react'
import { BadgeCheck, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Address } from 'viem'
import { NETWORK_LABEL, USDC } from '@/chain'
import { ConnectGate } from '@/components/ConnectGate'
import { AddressCard, NetworkInfo } from '@/components/NetworkInfo'
import { Banner, Button, Card, PageHeader } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { shortAddress } from '@/lib/format'
import { paymentDetailsText } from '@/lib/paymentDetails'

function ProfileCard({ address }: { address: Address }) {
  const [sharing, setSharing] = useState(false)

  const share = async () => {
    setSharing(true)
    try {
      const { text, url } = await paymentDetailsText(address)
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: 'My Arvexa payment details', text, url })
          return
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return // closed the share sheet
          // otherwise fall back to copying below
        }
      }
      if (await copyText(text)) toast.success('Payment details copied. Paste them in any chat.')
      else toast.error('Copy failed. Select the address and copy it manually.')
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="anim-border rounded-3xl p-[1.5px]">
      <Card className="rise !rounded-[calc(1.5rem-1.5px)] bg-surface-strong">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-2xl text-lg font-bold text-white"
              style={{ background: 'radial-gradient(circle at 30% 25%, #6fa8ff, #2775ca 70%)', boxShadow: '0 0 22px -4px #4f8cff' }}
            >
              $
            </span>
            <div className="min-w-0">
              <h2 className="display text-lg font-semibold">Your payment profile</h2>
              <p className="mono truncate text-xs text-muted" title={address}>
                {shortAddress(address, 8, 6)}
              </p>
            </div>
          </div>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold text-success"
            style={{ background: 'color-mix(in srgb, var(--success) 14%, transparent)' }}
            title={`USDC token contract ${USDC.address}`}
          >
            <BadgeCheck className="size-3.5" aria-hidden />
            USDC on Arc
          </span>
        </div>
        <AddressCard address={address} caption={`Scan or copy your ${NETWORK_LABEL} address`} />
        <Button className="mt-3 w-full" loading={sharing} onClick={() => void share()}>
          <Share2 className="size-4" aria-hidden />
          Share payment details
        </Button>
        <p className="mt-2 text-center text-[11px] text-muted">Shares your public address and a pay link. Nothing private is included.</p>
      </Card>
    </div>
  )
}

export default function Receive() {
  return (
    <>
      <PageHeader title="Receive" subtitle={`Share your address to receive USDC on ${NETWORK_LABEL}.`} />
      <ConnectGate allowWrongNetwork>
        {(address) => (
          <div className="space-y-5">
            <ProfileCard address={address} />
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
