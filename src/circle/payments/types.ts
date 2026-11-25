import type { Address, Hex } from 'viem'

/**
 * Arvexa's payment layer is rail-based. A rail is one way of moving value to a recipient and settling it.
 * Today the active rail is native USDC on Arc. Circle Payments Network (CPN) is modeled as a second rail so it
 * can be connected later by implementing `PaymentRail.submit`, without changing the screens that list,
 * track or settle payments.
 */

export type PaymentRailId = 'arc-usdc' | 'cpn'

/** How ready a rail is: `active` works now; the others say exactly what is missing. */
export type RailReadiness =
  | { status: 'active'; detail: string }
  | { status: 'needs_configuration'; detail: string; requirements: string[] }
  | { status: 'needs_access'; detail: string; requirements: string[] }

export type PaymentStatus = 'submitted' | 'settled' | 'failed' | 'unverified'

export interface Settlement {
  /** `settled` means final on the rail. On Arc a successful, event-verified receipt is final. */
  state: 'pending' | 'settled' | 'failed' | 'unverified'
  reference?: Hex
  /** Rail-specific explorer or tracking link for the settlement. */
  url?: string
}

export interface PaymentRecord {
  id: string
  rail: PaymentRailId
  recipient?: Address
  /** Raw 6-decimal USDC amount. */
  amount: bigint
  status: PaymentStatus
  settlement: Settlement
  createdAt: number
}

/** What a rail must provide so the rest of the app can treat all rails the same way. */
export interface PaymentRail {
  id: PaymentRailId
  label: string
  summary: string
  /** Where in the app a payment on this rail is started, when it can be started in-app. */
  startPath?: string
  readiness: () => RailReadiness
  /**
   * Submits a payment on this rail. Absent until the rail is connected: callers must check `readiness()` first and
   * never fall back to a different rail silently.
   */
  submit?: (request: { recipient: Address; amount: bigint }) => Promise<PaymentRecord>
}
