import { BadgeCheck, Share2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { ExplorerLink, CopyButton, Button } from '@/components/ui'
import { CategoryBadge } from '@/components/TxMetaEditor'
import { shareOrCopy } from '@/components/payments/kit'
import { contactFor, useContacts } from '@/lib/contacts'
import { formatTimestamp, formatUsdcDisplay, shortAddress, shortHash } from '@/lib/format'
import { receiptText, type Receipt } from '@/lib/payments/receipts'

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

/** A digital receipt for a payment that was verified onchain. */
export function ReceiptCard({ receipt, owner }: { receipt: Receipt; owner?: string }) {
  const contacts = useContacts(owner)
  const who = (address: string) => {
    const saved = contactFor(contacts, address)
    return (
      <span className="mono text-xs" title={address}>
        {saved ? `${saved.name} · ` : ''}
        {shortAddress(address, 8, 6)}
      </span>
    )
  }
  return (
    <article className="rounded-3xl p-px" style={{ background: 'linear-gradient(135deg, #22d3ee, transparent 50%, #a855f7)' }} aria-label="Payment receipt">
      <div className="rounded-[calc(1.5rem-1px)] bg-surface-strong p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-success" style={{ background: 'color-mix(in srgb, var(--success) 14%, transparent)' }}>
            <BadgeCheck className="size-4" aria-hidden />
            Verified
          </span>
          <span className="text-xs text-muted">{receipt.direction === 'received' ? 'Payment received' : 'Payment sent'}</span>
        </div>
        <p className="display mt-4 text-4xl font-semibold tabular-nums">
          {formatUsdcDisplay(receipt.amount)} <span className="text-lg font-medium text-subtle">USDC</span>
        </p>
        <dl className="mt-3 divide-y divide-line">
          <Line label="From">{who(receipt.from)}</Line>
          <Line label="To">{who(receipt.to)}</Line>
          <Line label="Date and time">{receipt.timestamp ? formatTimestamp(receipt.timestamp) : 'Time not available'}</Line>
          <Line label="Network">{receipt.network}</Line>
          <Line label="Status">Verified onchain</Line>
          {receipt.invoiceNo && <Line label="Invoice">{receipt.invoiceNo}</Line>}
          {receipt.description && <Line label="For">{receipt.description}</Line>}
          {receipt.reference && <Line label="Reference">{receipt.reference}</Line>}
          {receipt.note && <Line label="Note">“{receipt.note}”</Line>}
          {receipt.category && <Line label="Category"><CategoryBadge category={receipt.category} /></Line>}
          <Line label="Transaction hash">
            <span className="mono text-xs" title={receipt.hash}>
              {shortHash(receipt.hash)}
            </span>
          </Line>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <CopyButton value={receipt.hash} label="Copy hash" className="min-h-10 flex-1" />
          <Button className="min-h-10 flex-1" onClick={() => void shareOrCopy({ title: 'Arvexa payment receipt', text: receiptText(receipt) })}>
            <Share2 className="size-4" aria-hidden />
            Share receipt
          </Button>
        </div>
        <div className="mt-3 text-center">
          <ExplorerLink hash={receipt.hash} />
        </div>
      </div>
    </article>
  )
}
