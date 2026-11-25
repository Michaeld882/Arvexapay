import { useMemo } from 'react'
import { ARVEXA_ADDRESS, explorerTxUrl, USDC } from '@/chain'
import { CIRCLE_CONFIG } from '@/circle/config'
import type { PaymentRail, PaymentRecord, RailReadiness } from '@/circle/payments/types'
import { useLocalTxs, type LocalTx } from '@/lib/txLog'

/** Native USDC on Arc: Send and vault withdrawals use the real Circle-issued USDC contract and settle onchain. */
export const arcUsdcRail: PaymentRail = {
  id: 'arc-usdc',
  label: 'USDC on Arc',
  summary: 'Native USDC transfers on Arc Mainnet. Each payment settles when its receipt and Transfer event are verified onchain.',
  startPath: '/send',
  readiness: (): RailReadiness => ({ status: 'active', detail: `Using USDC at ${USDC.address} with ${USDC.decimals} decimals.` }),
}

/**
 * Circle Payments Network. Access is granted by Circle and payments are authorized by credentials that must stay on
 * a server. Until a backend you run is connected, this rail reports what is missing and never submits anything.
 */
export const cpnRail: PaymentRail = {
  id: 'cpn',
  label: 'Circle Payments Network',
  summary: 'Cross-border payments through Circle Payments Network participants.',
  readiness: (): RailReadiness => {
    if (!CIRCLE_CONFIG.cpnApiUrl) {
      return {
        status: 'needs_access',
        detail: 'Circle Payments Network access is granted by Circle and is not self-serve.',
        requirements: [
          'Approved Circle Payments Network access for your organization',
          'A server you run that holds the Circle credentials and signs payment requests',
          'VITE_CPN_API_URL set to that server (an https URL, never a Circle API key)',
        ],
      }
    }
    return {
      status: 'needs_configuration',
      detail: 'A server URL is set, but payment submission is not enabled in this build.',
      requirements: ['Implement PaymentRail.submit for CPN against the API Circle approved for you (src/circle/payments/rails.ts)'],
    }
  },
}

export const PAYMENT_RAILS: readonly PaymentRail[] = [arcUsdcRail, cpnRail]

const PAYMENT_KINDS: ReadonlySet<LocalTx['kind']> = new Set(['send', 'withdraw'])

/** Maps a transaction this app submitted into a payment record. Only real hashes ever appear. */
export function toPaymentRecord(tx: LocalTx): PaymentRecord {
  const settled = tx.status === 'success'
  const failed = tx.status === 'failed'
  const unverified = tx.status === 'unverified'
  return {
    id: tx.hash,
    rail: 'arc-usdc',
    recipient: tx.to,
    amount: BigInt(tx.amount),
    status: settled ? 'settled' : failed ? 'failed' : unverified ? 'unverified' : 'submitted',
    settlement: {
      state: settled ? 'settled' : failed ? 'failed' : unverified ? 'unverified' : 'pending',
      reference: tx.hash,
      url: explorerTxUrl(tx.hash),
    },
    createdAt: tx.createdAt,
  }
}

/** Payments (sends and vault withdrawals) made from this browser for the connected wallet. */
export function usePayments(address: string | undefined): PaymentRecord[] {
  const txs = useLocalTxs(address)
  return useMemo(
    () => txs.filter((tx) => PAYMENT_KINDS.has(tx.kind) && tx.to && (!ARVEXA_ADDRESS || tx.to.toLowerCase() !== ARVEXA_ADDRESS.toLowerCase())).map(toPaymentRecord),
    [txs],
  )
}
