import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  LimitExceededRpcError,
  TimeoutError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem'

export type ErrorKind =
  | 'user_rejected'
  | 'insufficient_usdc'
  | 'insufficient_gas'
  | 'invalid_address'
  | 'invalid_amount'
  | 'rpc_unavailable'
  | 'rpc_timeout'
  | 'rpc_rate_limited'
  | 'reverted'
  | 'wrong_network'
  | 'wallet_unavailable'
  | 'contract_not_configured'
  | 'token_not_configured'
  | 'swap_unavailable'
  | 'unverified'
  | 'unknown'

const MESSAGES: Record<ErrorKind, string> = {
  user_rejected: 'You rejected the request in your wallet. Nothing was sent.',
  insufficient_usdc: 'Your USDC balance is too low for this amount.',
  insufficient_gas: 'You do not have enough USDC to cover the network fee. On Arc, gas is paid in USDC.',
  invalid_address: 'Enter a valid wallet address (0x followed by 40 hex characters).',
  invalid_amount: 'Enter an amount greater than zero, with up to 6 decimal places.',
  rpc_unavailable: 'Arc Mainnet RPC is not responding right now. Your funds are safe. Try again in a moment.',
  rpc_timeout: 'The Arc Mainnet RPC took too long to answer. Try again in a moment.',
  rpc_rate_limited: 'The Arc Mainnet RPC is rate limiting requests. Wait a few seconds and try again.',
  reverted: 'The transaction was reverted onchain, so no funds moved.',
  wrong_network: 'Your wallet is not on Arc Mainnet (Chain ID 5042). Switch networks to continue.',
  wallet_unavailable: 'No browser wallet was found or the wallet could not complete the request.',
  contract_not_configured: 'Contract not configured. Set VITE_ARVEXA_CONTRACT_ADDRESS to enable this action.',
  token_not_configured: 'This token is not configured for Arc Mainnet.',
  swap_unavailable: 'Swap liquidity is not configured, so no swap route is available.',
  unverified: 'The transaction was mined, but the expected result could not be verified onchain.',
  unknown: 'Something went wrong. Nothing was assumed to have succeeded.',
}

export class AppError extends Error {
  readonly kind: ErrorKind
  /** Raw technical detail for debugging. Never the only thing shown to the user. */
  readonly detail: string
  /** The original thrown value, kept for debugging. */
  readonly origin: unknown

  constructor(kind: ErrorKind, detail?: string, options?: { cause?: unknown }) {
    super(MESSAGES[kind])
    this.name = 'AppError'
    this.kind = kind
    this.detail = detail ?? MESSAGES[kind]
    this.origin = options?.cause
  }
}

export const messageFor = (kind: ErrorKind): string => MESSAGES[kind]

function technicalDetail(err: unknown): string {
  if (err instanceof BaseError) {
    const details = (err as { details?: unknown }).details
    return typeof details === 'string' && details ? `${err.shortMessage} (${details})` : err.shortMessage || err.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}

function hasCode(err: unknown, code: number): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === code
}

/** Turns any thrown value into an AppError with a friendly message and a technical detail. */
export function classifyError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const detail = technicalDetail(err)
  const lower = detail.toLowerCase()
  const walk = <T extends Error>(Cls: new (...args: never[]) => T): boolean =>
    err instanceof BaseError ? err.walk((e) => e instanceof Cls) !== null : err instanceof Cls

  if (walk(UserRejectedRequestError) || hasCode(err, 4001) || /user rejected|user denied|rejected the request/.test(lower)) {
    return new AppError('user_rejected', detail, { cause: err })
  }
  if (walk(InsufficientFundsError) || /insufficient funds|exceeds the balance of the account/.test(lower)) {
    return new AppError('insufficient_gas', detail, { cause: err })
  }
  if (/chain mismatch|does not match the target chain|wrong network|chain id/.test(lower) && /mismatch|match/.test(lower)) {
    return new AppError('wrong_network', detail, { cause: err })
  }
  if (walk(WaitForTransactionReceiptTimeoutError)) {
    return new AppError('rpc_timeout', detail, { cause: err })
  }
  if (walk(LimitExceededRpcError) || hasCode(err, -32005) || /429|rate limit|too many requests/.test(lower)) {
    return new AppError('rpc_rate_limited', detail, { cause: err })
  }
  if (walk(TimeoutError) || /timed out|timeout/.test(lower)) {
    return new AppError('rpc_timeout', detail, { cause: err })
  }
  if (walk(HttpRequestError) || /failed to fetch|networkerror|network error|http request failed|load failed/.test(lower)) {
    return new AppError('rpc_unavailable', detail, { cause: err })
  }
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name === 'InsufficientBalance') return new AppError('insufficient_usdc', detail, { cause: err })
      if (name === 'InvalidRecipient') return new AppError('invalid_address', detail, { cause: err })
      if (name === 'ZeroAmount') return new AppError('invalid_amount', detail, { cause: err })
      if (name === 'EnforcedPause') return new AppError('reverted', 'Top-ups are paused by the contract owner. ' + detail, { cause: err })
      return new AppError('reverted', detail, { cause: err })
    }
  }
  if (/transfer amount exceeds balance|erc20: .*exceeds balance|insufficient allowance|exceeds allowance/.test(lower)) {
    return new AppError('insufficient_usdc', detail, { cause: err })
  }
  if (/reverted|execution revert/.test(lower)) return new AppError('reverted', detail, { cause: err })
  if (/connector not connected|no provider|provider not found/.test(lower)) {
    return new AppError('wallet_unavailable', detail, { cause: err })
  }
  return new AppError('unknown', detail, { cause: err })
}

/** True only for failures that are safe to retry on a READ (never a wallet write). */
export function isTransientError(err: unknown): boolean {
  const kind = classifyError(err).kind
  return kind === 'rpc_unavailable' || kind === 'rpc_timeout' || kind === 'rpc_rate_limited'
}

export function isRpcError(err: unknown): boolean {
  return isTransientError(err)
}

/** User-friendly text for an unknown thrown value; the raw detail is logged for debugging. */
export function toUserMessage(err: unknown): string {
  const app = classifyError(err)
  console.debug('[arvexa:error]', app.kind, app.detail)
  return app.message
}
