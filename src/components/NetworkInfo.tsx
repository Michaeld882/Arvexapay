import { QRCodeSVG } from 'qrcode.react'
import { ARC_CHAIN_ID, ARC_EXPLORER_URL, NETWORK_NAME, USDC, explorerAddressUrl } from '@/chain'
import { CopyButton, ExplorerLink, Row } from '@/components/ui'

/** Network and USDC token facts, all read from the central chain config. */
export function NetworkInfo() {
  return (
    <dl className="divide-y divide-line">
      <Row label="Network">{NETWORK_NAME}</Row>
      <Row label="Chain ID">{ARC_CHAIN_ID}</Row>
      <Row label="Token">USDC (6 decimals)</Row>
      <Row label="USDC contract">
        <span className="mono text-xs">{USDC.address}</span>
        <div className="mt-1 flex justify-end">
          <ExplorerLink address={USDC.address} label="Explorer" />
        </div>
      </Row>
      <Row label="Gas token">USDC (same balance)</Row>
      <Row label="Explorer">
        <a href={ARC_EXPLORER_URL} target="_blank" rel="noopener noreferrer" className="text-accent-hover hover:underline">
          {ARC_EXPLORER_URL.replace('https://', '')}
        </a>
      </Row>
    </dl>
  )
}

/** Wallet address with QR code and a reliable copy button. */
export function AddressCard({ address, caption }: { address: string; caption?: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
        <QRCodeSVG value={address} size={176} level="M" bgColor="#ffffff" fgColor="#0c2118" title={`QR code for ${address}`} />
      </div>
      {caption && <p className="text-xs text-muted">{caption}</p>}
      <p className="mono w-full rounded-2xl border border-line bg-surface-muted px-4 py-3 text-sm text-ink [overflow-wrap:anywhere]">{address}</p>
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <CopyButton value={address} label="Copy address" className="flex-1" />
        <a
          href={explorerAddressUrl(address)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-2xl border border-line bg-transparent px-4 text-sm font-semibold text-ink-2 transition-colors hover:bg-surface-muted"
        >
          View on explorer
        </a>
      </div>
    </div>
  )
}
