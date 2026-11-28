import { useEffect, useRef, useState } from 'react'
import { getWalletClient } from 'wagmi/actions'
import { Globe, ShieldCheck } from 'lucide-react'
import type { Address } from 'viem'
import { ARC_CHAIN_ID } from '@/chain'
import { ConnectGate } from '@/components/ConnectGate'
import { Field, MODULES, ModuleHero, inputClass } from '@/components/payments/kit'
import { Banner, Button, Card, CopyButton, ExplorerLink } from '@/components/ui'
import { config } from '@/config'
import { beginSubmission, dropSubmission, findInFlightDuplicate, txLock, updateSubmission } from '@/guardian/lock'
import { useSpendableUsdc } from '@/hooks/useSpendable'
import { classifyError } from '@/lib/errors'
import { formatUsdcDisplay, shortAddress } from '@/lib/format'
import { waitForReceipt } from '@/lib/rpc'
import { ARC_TARGET, type Discovery, type PayableOffer, X402SigningMismatch, discover, parseResourceUrl, payOffer, verifySettlement } from '@/lib/x402'

type Step =
  | { name: 'idle' }
  | { name: 'checking' }
  | { name: 'result'; discovery: Discovery }
  | { name: 'signing'; offer: PayableOffer }
  | { name: 'sending'; offer: PayableOffer }
  | { name: 'settled'; offer: PayableOffer; body: string; hash: `0x${string}`; verified: 'pending' | 'yes' | 'no' }
  | { name: 'unconfirmed'; offer: PayableOffer; body: string }
  | { name: 'failed'; title: string; message: string; offer?: PayableOffer }

const initialUrl = (): string => new URLSearchParams(window.location.search).get('url') ?? ''

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function Offer({ offer, balance, onPay, onCancel }: { offer: PayableOffer; balance: bigint | undefined; onPay: () => void; onCancel: () => void }) {
  const host = new URL(offer.url).host
  const short = balance !== undefined && balance < offer.amount
  return (
    <Card className="space-y-4 border-accent">
      <div>
        <p className="text-sm font-semibold text-success">This API asks for payment</p>
        <p className="mt-0.5 text-xs text-muted">x402 API payment. Your wallet signs a USDC authorization for this API only. It is not a wallet-to-wallet transfer.</p>
      </div>
      <dl className="divide-y divide-line rounded-2xl border border-line bg-surface-muted px-4">
        <Row label="API">{host}</Row>
        {offer.description && <Row label="For">{offer.description}</Row>}
        <Row label="Price">
          <span className="display text-base font-semibold tabular-nums">{formatUsdcDisplay(offer.amount)} USDC</span>
        </Row>
        <Row label="Paid to">
          <span className="mono text-xs">{shortAddress(offer.payTo)}</span> <CopyButton value={offer.payTo} label="Copy payee address" />
        </Row>
        <Row label="Network">{ARC_TARGET.label}</Row>
        <Row label="Your USDC">{balance === undefined ? 'Loading…' : `${formatUsdcDisplay(balance)} USDC`}</Row>
        <Row label="Valid for">{offer.validForSeconds} seconds</Row>
      </dl>
      {short && <Banner tone="danger" title="Not enough USDC">Your balance is lower than the price.</Banner>}
      <p className="text-xs text-muted">No gas is charged to you. The charge happens only after you sign in your wallet, and only for the price shown.</p>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="flex-[2]" disabled={short || balance === undefined} onClick={onPay}>
          Pay {formatUsdcDisplay(offer.amount)} USDC
        </Button>
      </div>
    </Card>
  )
}

function X402Content({ address }: { address: Address }) {
  const [url, setUrl] = useState(initialUrl)
  const [step, setStep] = useState<Step>({ name: 'idle' })
  const mounted = useRef(true)
  const busy = useRef(false)
  const { balance } = useSpendableUsdc(address)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const set = (next: Step) => {
    if (mounted.current) setStep(next)
  }

  const urlCheck = parseResourceUrl(url)
  const urlError = url.trim() !== '' && !urlCheck.ok ? urlCheck.message : null

  const check = async () => {
    if (busy.current || !urlCheck.ok) return
    busy.current = true
    set({ name: 'checking' })
    try {
      set({ name: 'result', discovery: await discover(urlCheck.url) })
    } finally {
      busy.current = false
    }
  }

  const pay = async (offer: PayableOffer) => {
    if (busy.current) return
    busy.current = true
    const fingerprint = `x402:${address.toLowerCase()}:${offer.url}:${offer.payTo.toLowerCase()}:${offer.amount}`
    const duplicate = findInFlightDuplicate(address, fingerprint)
    if (duplicate) {
      set({ name: 'failed', title: 'Already in progress', message: 'You already signed a payment for this API a moment ago. Wait for it to finish, or check Activity, before paying again.', offer })
      busy.current = false
      return
    }
    const lock = txLock.tryAcquire(address, fingerprint)
    if (!lock.ok) {
      set({ name: 'failed', title: 'Another payment is in progress', message: 'Finish or cancel the payment that is already open, then try again.', offer })
      busy.current = false
      return
    }
    const submission = beginSubmission(address, { fingerprint, kind: 'x402', title: 'API payment', expect: [{ type: 'erc20-transfer', token: ARC_TARGET.asset, from: address, to: offer.payTo, value: offer.amount.toString() }] })
    const progress = { signed: false } // set once the wallet has produced a signature
    try {
      set({ name: 'signing', offer })
      const wallet = await getWalletClient(config, { chainId: ARC_CHAIN_ID })
      const account = wallet.account
      if (!account || account.address.toLowerCase() !== address.toLowerCase()) throw new Error('Your wallet account changed. Reconnect and try again.')
      const result = await payOffer(
        offer,
        {
          address,
          signTypedData: async (message) => {
            const signature = await wallet.signTypedData({ account, ...message })
            progress.signed = true
            set({ name: 'sending', offer })
            return signature
          },
        },
        ARC_TARGET,
      )
      if (result.kind === 'refused') {
        // Nothing was collected by the API. Free the lock; the signed authorization expires on its own.
        updateSubmission(address, submission.id, { state: 'FAILED' })
        set({ name: 'failed', title: 'Payment not accepted', message: result.message, offer })
        return
      }
      if (result.kind === 'paid-unconfirmed') {
        updateSubmission(address, submission.id, { state: 'FAILED' })
        set({ name: 'unconfirmed', offer, body: result.body })
        return
      }
      const hash = result.settlement.transaction
      updateSubmission(address, submission.id, { state: 'SUBMITTED', hash })
      set({ name: 'settled', offer, body: result.body, hash, verified: 'pending' })
      // Final check against the chain: the exact price moved from you to the payee.
      let verified = false
      try {
        const receipt = await waitForReceipt(hash, 90_000)
        verified = verifySettlement(receipt, { asset: ARC_TARGET.asset, payer: address, payTo: offer.payTo, amount: offer.amount })
      } catch {
        verified = false
      }
      updateSubmission(address, submission.id, { state: verified ? 'VERIFIED' : 'CONFIRMED' })
      set({ name: 'settled', offer, body: result.body, hash, verified: verified ? 'yes' : 'no' })
    } catch (err) {
      const classified = classifyError(err)
      const signed = progress.signed
      if (!signed) dropSubmission(address, submission.id)
      else updateSubmission(address, submission.id, { state: 'FAILED' })
      if (!signed && classified.kind === 'user_rejected') set({ name: 'failed', title: 'Payment declined', message: 'You declined the signature request. Nothing was paid.', offer })
      else if (err instanceof X402SigningMismatch) set({ name: 'failed', title: 'Payment stopped', message: err.message, offer })
      else set({ name: 'failed', title: signed ? 'Payment could not be completed' : 'Payment failed', message: signed ? `${classified.message} If you signed, the authorization is only valid for a short time. Check Activity before trying again.` : classified.message, offer })
    } finally {
      lock.release()
      busy.current = false
    }
  }

  const reset = () => setStep({ name: 'idle' })
  const working = step.name === 'checking' || step.name === 'signing' || step.name === 'sending'
  const discovery = step.name === 'result' ? step.discovery : undefined

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <div className="flex items-start gap-3 text-sm text-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p>
            Some web APIs charge per request using <strong className="text-ink-2">x402</strong>. Paste the API address to see its price first. This is separate from normal wallet payments: nothing is sent until you approve a signature in your wallet.
          </p>
        </div>
        <Field label="API address" error={urlError} hint="Secure https:// addresses only.">
          {({ id, invalid }) => (
            <input
              id={id}
              value={url}
              onChange={(event) => { setUrl(event.target.value); if (step.name !== 'idle' && !working) reset() }}
              disabled={working}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="https://api.example.com/data"
              aria-invalid={invalid || undefined}
              className={inputClass}
            />
          )}
        </Field>
        <Button className="w-full" loading={step.name === 'checking'} disabled={!urlCheck.ok || working} onClick={() => void check()}>
          <Globe className="size-4" aria-hidden />
          Check price
        </Button>
      </Card>

      {discovery?.kind === 'payable' && <Offer offer={discovery.offer} balance={balance.data} onPay={() => void pay(discovery.offer)} onCancel={reset} />}
      {step.name === 'failed' && step.offer && (
        <Offer offer={step.offer} balance={balance.data} onPay={() => void pay(step.offer as PayableOffer)} onCancel={reset} />
      )}

      {(step.name === 'signing' || step.name === 'sending') && (
        <Banner tone="info" title={step.name === 'signing' ? 'Confirm in your wallet' : 'Paying the API'}>
          {step.name === 'signing' ? 'Approve the signature request in your wallet. You are authorizing only the price shown.' : 'Signed. Waiting for the API to confirm the payment…'}
        </Banner>
      )}

      {discovery?.kind === 'free' && (
        <Banner tone="info" title="This API did not ask for payment">
          It answered with status {discovery.status}. Nothing was paid.
        </Banner>
      )}
      {discovery?.kind === 'unsupported' && (
        <Banner tone="warn" title="Cannot pay this API here">
          {discovery.message}
          {discovery.accepted.length > 0 && <span className="mt-1 block text-xs text-muted">It accepts: {discovery.accepted.join(', ')}.</span>}
        </Banner>
      )}
      {discovery?.kind === 'failed' && (
        <Banner tone="danger" title="Could not check this API">
          {discovery.message}
        </Banner>
      )}
      {step.name === 'failed' && (
        <Banner tone="danger" title={step.title}>
          {step.message}
        </Banner>
      )}

      {step.name === 'unconfirmed' && (
        <Banner tone="warn" title="Paid, but no settlement was reported" action={<Button variant="secondary" className="min-h-10" onClick={reset}>Done</Button>}>
          The API answered, but did not return a settlement record, so Arvexa cannot confirm the charge. Check Activity for a USDC transfer to {shortAddress(step.offer.payTo)} before paying again.
        </Banner>
      )}

      {step.name === 'settled' && (
        <Card className="space-y-3 border-accent" aria-live="polite">
          <p className="text-sm font-semibold text-success">{step.verified === 'yes' ? 'Payment settled and verified' : step.verified === 'pending' ? 'Payment sent. Verifying on Arc…' : 'Payment sent, not yet verified'}</p>
          <p className="text-xs text-muted">
            {formatUsdcDisplay(step.offer.amount)} USDC to {shortAddress(step.offer.payTo)}.{' '}
            {step.verified === 'yes' && 'The transfer was found on Arc for exactly this amount.'}
            {step.verified === 'no' && 'The transaction was not confirmed on Arc yet, or did not match. Check the explorer or Activity.'}
          </p>
          <ExplorerLink hash={step.hash} />
          {step.body && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-2">Response from the API</p>
              <pre className="mono max-h-64 overflow-auto rounded-2xl border border-line bg-surface-muted p-3 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{step.body}</pre>
            </div>
          )}
          <Button variant="secondary" className="w-full" onClick={reset}>
            Done
          </Button>
        </Card>
      )}
    </div>
  )
}

export default function X402Page() {
  return (
    <>
      <ModuleHero module={MODULES.x402} />
      <ConnectGate>{(address) => <X402Content address={address} />}</ConnectGate>
    </>
  )
}
