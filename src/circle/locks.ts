import { createExclusive } from '@/circle/store'

/** One CCTP transfer (start, resume or re-check) at a time. The value is the transfer record id. */
export const transferLock = createExclusive()

/** One Gateway deposit or spend at a time. */
export const gatewayLock = createExclusive()

/** True while any signed Circle operation is running. */
export function useCircleOperationActive(): boolean {
  const transfer = transferLock.useActive()
  const gateway = gatewayLock.useActive()
  return transfer !== undefined || gateway !== undefined
}
