import { CheckCircle2 } from 'lucide-react'
import { Card, CopyButton, ExplorerLink } from '@/components/ui'
import type { LastConfirmedTx } from '@/hooks/useTxFlow'
import { shortHash } from '@/lib/format'

/** Keeps the hash and explorer link of the last confirmed transaction on the page after the dialog is closed. */
export function LastTxCard({ tx }: { tx: LastConfirmedTx | null }) {
  if (!tx) return null
  return (
    <Card className="space-y-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        <p className="text-sm font-semibold">Last confirmed: {tx.title}</p>
      </div>
      <p className="text-sm text-muted">{tx.resultText}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mono text-xs text-subtle" title={tx.hash}>
          {shortHash(tx.hash)}
        </span>
        <CopyButton value={tx.hash} label="Copy hash" className="min-h-9 px-3 text-xs" />
        <ExplorerLink hash={tx.hash} />
      </div>
    </Card>
  )
}
