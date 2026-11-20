import type { Address } from 'viem'

export type SendMode = 'reject' | 'hang'

export interface MockWallet {
  calls: Array<{ method: string; params?: unknown }>
  sendCount: () => number
  chainId: number
  setSendMode: (mode: SendMode) => void
  /** Simulates the user switching accounts in the wallet. */
  setAccount: (next: Address) => void
  emit: (event: string, ...args: unknown[]) => void
}

/**
 * A browser-wallet stand-in (EIP-1193). It answers account and chain queries, switches chains,
 * and either rejects or never answers eth_sendTransaction. It never returns a transaction hash,
 * so tests can never produce a "successful" fake transaction.
 */
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
let active: { wallet: MockWallet; account: () => Address; mode: () => SendMode } | undefined

// One provider object for the whole test run, like a real browser's window.ethereum. wagmi keeps
// its accountsChanged listener across reconnects, so a new provider object per test would lose events.
const provider = {
  isMetaMask: true,
  on: (event: string, listener: (...args: unknown[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)?.add(listener)
  },
  removeListener: (event: string, listener: (...args: unknown[]) => void) => {
    listeners.get(event)?.delete(listener)
  },
  request: async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    if (!active) throw new Error('mock wallet is not installed')
    const { wallet } = active
    wallet.calls.push({ method, params })
    switch (method) {
      case 'eth_chainId':
        return `0x${wallet.chainId.toString(16)}`
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [active.account()]
      case 'wallet_switchEthereumChain': {
        const [{ chainId }] = params as [{ chainId: string }]
        wallet.chainId = Number(chainId)
        wallet.emit('chainChanged', chainId)
        return null
      }
      case 'eth_sendTransaction':
        if (active.mode() === 'hang') return new Promise(() => undefined)
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      default:
        throw Object.assign(new Error(`mock wallet does not implement ${method}`), { code: -32601 })
    }
  },
}

export function installMockWallet(account: Address, initialChainId: number): MockWallet {
  let sendMode: SendMode = 'reject'
  let current = account
  const wallet: MockWallet = {
    calls: [],
    sendCount: () => wallet.calls.filter((call) => call.method === 'eth_sendTransaction').length,
    chainId: initialChainId,
    setSendMode: (mode) => {
      sendMode = mode
    },
    setAccount: (next) => {
      current = next
      wallet.emit('accountsChanged', [next])
    },
    emit: (event, ...args) => listeners.get(event)?.forEach((listener) => listener(...args)),
  }
  active = { wallet, account: () => current, mode: () => sendMode }
  ;(window as unknown as { ethereum: unknown }).ethereum = provider
  return wallet
}
