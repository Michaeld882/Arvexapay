import { useMemo, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { Clock, Link2, ShieldCheck, Wallet } from 'lucide-react'
import { isAddressEqual, type Address } from 'viem'
import { NETWORK_LABEL } from '@/chain'
import { ModuleIcon, MODULES } from '@/components/payments/kit'
import { ReceiptCard } from '@/components/payments/ReceiptCard'
import { AmountInput } from '@/components/Inputs'
import { DisabledHint } from '@/components/DisabledHint'
import { TxDialog } from '@/components/TxDialog'
import { BackButton, Banner, Button, Card, CopyButton, ExplorerLink, cx } from '@/components/ui'
import { useNow } from '@/hooks/useNow'
import { useSpendableUsdc } from '@/hooks/useSpendable'
import { useTxFlow } from '@/hooks/useTxFlow'
import { useTxTime } from '@/hooks/useTxTime'
import { useWallet } from '@/hooks/useWallet'
import { contactFor, useContacts } from '@/lib/contacts'
import { classifyError } from '@/lib/errors'
import { formatTimestamp, formatUsdcDisplay, shortAddress } from '@/lib/format'
import { parsePayLink, type PayLink } from '@/lib/payments/links'
import { rememberPaidLink, usePaidLinks, type Receipt, type PaidLinkRecord } from '@/lib/payments/receipts'
import { buildSendPlan, withMeta } from '@/lib/plan'
import { navigate } from '@/lib/router'
import { cleanNote } from '@/lib/txMeta'
import { checkAmount } from '@/lib/validate'
import { NETWORK_NAME } from '@/chain'

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function PaidReceipt({ payer, record }: { payer: Address; record: PaidLinkRecord }) {
  const timestamp = useTxTime(record.hash)
  const receipt: Receipt = {
    hash: record.hash,
    direction: 'sent',
    amount: BigInt(record.amount),
    from: payer,
    to: record.to,
    timestamp: timestamp ?? record.at,
    network: NETWORK_NAME,
    status: 'Verified',
    description: record.description,
    reference: record.reference,
  }
  return <ReceiptCard receipt={receipt} owner={payer} />
}

function PayAction({ payer, link, openAmount }: { payer: Address; link: PayLink; openAmount: boolean }) {
  const { balance, spendable, feeUsdc } = useSpendableUsdc(payer)
  const [amountText, setAmountText] = useState(link.amount ?? '')
  const amount = useMemo(() => checkAmount(amountText), [amountText])
  const flow = useTxFlow({
    onSuccess: (plan, hash) => rememberPaidLink(payer, { hash, to: link.to, amount: plan.amount.toString(), requestId: link.requestId, reference: link.reference, description: link.description, at: Math.floor(Date.now() / 1000) }),
  })
  const insufficient = amount.ok && balance.data !== undefined && amount.raw > balance.data
  const tooLittleForFee = amount.ok && !insufficient && spendable !== undefined && amount.raw > spendable
  const amountError = amountText && !amount.ok ? amount.message : insufficient ? 'Amount is higher than your USDC balance.' : tooLittleForFee ? `That leaves too little for the network fee (about ${formatUsdcDisplay(feeUsdc ?? 0n)} USDC).` : null
  const ready = amount.ok && !insufficient && !tooLittleForFee && balance.data !== undefined
  const reason = ready || flow.isBusy ? null : amountError ? null : !amount.ok ? 'Enter an amount to continue.' : 'Waiting for your balance to load.'
  const confirmed = flow.lastConfirmed
  const confirmedTime = useTxTime(confirmed?.hash)
  const paidRecord = usePaidFor(payer, confirmed?.hash ?? '')

  if (confirmed && flow.state.phase === 'idle') {
    const receipt: Receipt = { hash: confirmed.hash, direction: 'sent', amount: amount.ok ? amount.raw : 0n, from: payer, to: link.to, timestamp: confirmedTime, network: NETWORK_NAME, status: 'Verified', description: link.description, reference: link.reference }
    return (
      <div className="space-y-4">
        <Banner tone="success" title="Payment confirmed">
          Your payment was verified on Arc Mainnet.
        </Banner>
        <ReceiptCard receipt={paidRecord ? { ...receipt, amount: BigInt(paidRecord.amount) } : receipt} owner={payer} />
        <Button variant="secondary" className="w-full" onClick={() => navigate('/')}>
          Back to dashboard
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {openAmount ? (
          <AmountInput value={amountText} onChange={setAmountText} balance={balance.data} balanceLabel="Wallet balance" balanceLoading={balance.isPending} balanceUnavailable={balance.isError} spendable={spendable} disabled={flow.isBusy} error={amountError} />
        ) : (
          amountError && <Banner tone="danger">{amountError}</Banner>
        )}
        {balance.isError && <Banner tone="danger" title="Balance unavailable">{classifyError(balance.error).message} Paying is disabled until your balance can be checked.</Banner>}
        <Button
          className="w-full"
          disabled={!ready || flow.isBusy}
          onClick={() => {
            if (!amount.ok || flow.isBusy) return
            flow.open(withMeta(buildSendPlan(payer, link.to, amount.raw), { note: cleanNote(link.description ?? link.reference) }))
          }}
        >
          {amount.ok ? `Review and pay ${formatUsdcDisplay(amount.raw)} USDC` : 'Review and pay'}
        </Button>
        <DisabledHint reason={reason} />
        <p className="text-center text-[11px] text-muted">You review everything, then confirm in your wallet. Nothing is sent until you do.</p>
      </div>
      <TxDialog flow={flow} walletUsdc={balance.data} />
    </>
  )
}

function usePaidFor(payer: Address, hash: string): PaidLinkRecord | undefined {
  return usePaidLinks(payer).find((record) => hash !== '' && record.hash.toLowerCase() === hash.toLowerCase())
}

function PayContent({ link }: { link: PayLink }) {
  const { address, status, wrongNetwork, switchToArc, isSwitching } = useWallet()
  const now = Math.floor(useNow(30_000) / 1000)
  const contacts = useContacts(address)
  const paidLinks = usePaidLinks(address)
  const expired = link.expires !== undefined && now > link.expires
  const own = Boolean(address && isAddressEqual(address, link.to))
  const payee = contactFor(contacts, link.to)
  const parsedAmount = link.amount ? checkAmount(link.amount) : undefined
  const amountRaw = parsedAmount?.ok ? parsedAmount.raw : undefined
  const alreadyPaid = paidLinks.find((record) => isAddressEqual(record.to, link.to) && (link.requestId ? record.requestId === link.requestId : link.reference ? record.reference === link.reference && (amountRaw === undefined || record.amount === amountRaw.toString()) : false))

  return (
    <div className="space-y-5">
      {/* Inside the app there is a screen to go back to. A link opened with no wallet is the first screen. */}
      {status !== 'disconnected' && <BackButton className="!mb-0" />}
      <div className="rise rounded-3xl p-px" style={{ background: 'linear-gradient(135deg, #22d3ee, transparent 55%, #4f8cff)' }}>
        <div className="rounded-[calc(1.5rem-1px)] bg-surface-strong p-5">
          <div className="flex items-center gap-4">
            <ModuleIcon module={MODULES.link} size="lg" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Payment request</p>
              <h1 className="display truncate text-xl font-semibold">{link.name ?? payee?.name ?? shortAddress(link.to, 8, 6)}</h1>
            </div>
          </div>
          <p className="display mt-5 text-4xl font-semibold tabular-nums">
            {amountRaw !== undefined ? formatUsdcDisplay(amountRaw) : 'Any amount'} <span className="text-lg font-medium text-subtle">USDC</span>
          </p>
          <dl className="mt-3 divide-y divide-line">
            {link.description && <Detail label="For">{link.description}</Detail>}
            {link.reference && <Detail label="Reference">{link.reference}</Detail>}
            <Detail label="Pay to">
              <span className="mono text-xs">{link.to}</span>
            </Detail>
            <Detail label="Network">{NETWORK_LABEL}</Detail>
            {link.expires && (
              <Detail label={expired ? 'Expired' : 'Valid until'}>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden />
                  {formatTimestamp(link.expires)}
                </span>
              </Detail>
            )}
          </dl>
          <div className="mt-3 flex items-center justify-between gap-2">
            <CopyButton value={link.to} label="Copy address" className="min-h-9 text-xs" />
            <ExplorerLink address={link.to} label="View recipient" />
          </div>
        </div>
      </div>

      {expired ? (
        <Banner tone="danger" title="This payment link has expired">
          Ask {link.name ?? 'the recipient'} for a new link. Nothing was sent.
        </Banner>
      ) : status === 'connecting' ? (
        <p className="text-center text-sm text-muted">Checking your wallet…</p>
      ) : !address ? (
        <Card className="space-y-3 text-center">
          <p className="text-sm text-muted">Connect a wallet on {NETWORK_LABEL} to pay. You review and confirm before anything is sent.</p>
          <ConnectKitButton.Custom>
            {({ show, isConnecting }) => (
              <Button className="w-full" loading={isConnecting} onClick={() => show?.()}>
                <Wallet className="size-4" aria-hidden />
                Connect wallet to pay
              </Button>
            )}
          </ConnectKitButton.Custom>
        </Card>
      ) : own ? (
        <Banner tone="info" title="This is your own payment link">
          You cannot pay yourself. Share it with the person who should pay.
        </Banner>
      ) : wrongNetwork ? (
        <Card className="space-y-3 text-center">
          <p className="text-sm text-muted">Switch your wallet to {NETWORK_LABEL} to pay.</p>
          <Button className="w-full" loading={isSwitching} onClick={() => void switchToArc()}>
            Switch network
          </Button>
        </Card>
      ) : alreadyPaid ? (
        <div className="space-y-4">
          <Banner tone="success" title="You already paid this">
            This device recorded your payment, verified on Arc Mainnet.
          </Banner>
          <PaidReceipt payer={address} record={alreadyPaid} />
        </div>
      ) : (
        <Card>
          <PayAction payer={address} link={link} openAmount={!link.amount} />
        </Card>
      )}
      <p className={cx('flex items-center justify-center gap-1.5 text-center text-xs text-muted')}>
        <ShieldCheck className="size-3.5" aria-hidden />
        <Link2 className="size-3.5" aria-hidden />
        Payments are real USDC transfers on Arc Mainnet. Only pay people you trust.
      </p>
    </div>
  )
}

export default function Pay() {
  const parsed = useMemo(() => parsePayLink(window.location.search), [])
  if (!parsed.ok) {
    return (
      <Card className="space-y-3 text-center">
        <Banner tone="danger" title="This payment link cannot be used">
          {parsed.message}
        </Banner>
        <Button variant="secondary" onClick={() => navigate('/')}>
          Open Arvexa
        </Button>
      </Card>
    )
  }
  return <PayContent link={parsed.link} />
}

