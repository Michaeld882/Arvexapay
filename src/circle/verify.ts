import { erc20Abi, type Address } from 'viem'
import { ARC_CHAIN_ID, USDC } from '@/chain'
import { getGatewayBalance } from '@/circle/gateway'
import { chainKey, getAppKit, isEvmChain, loadCctpChains, loadGatewayChains } from '@/circle/sdk'
import { getArcClient } from '@/lib/rpc'
import { ONCHAIN_CHAINS, getChain } from '@/onchain-facts'

/**
 * Live configuration checks for every Circle integration. Each check reads Arc Mainnet or Circle's own registry and
 * API; none of them signs or sends anything, and none needs a credential. Used by the Circle page and by
 * `bun run verify:circle`.
 */

export type CheckGroup = 'usdc' | 'cctp' | 'gateway'

export interface ConfigCheck {
  id: string
  group: CheckGroup
  label: string
  ok: boolean
  /** Public facts only: addresses, counts and chain names. Never a key or a token. */
  detail: string
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase())

async function hasCode(address: string): Promise<boolean> {
  const code = await getArcClient().getCode({ address: address as Address })
  return Boolean(code && code !== '0x')
}

async function run(id: string, group: CheckGroup, label: string, test: () => { ok: boolean; detail: string } | Promise<{ ok: boolean; detail: string }>): Promise<ConfigCheck> {
  try {
    return { id, group, label, ...(await test()) }
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 160) : 'Check failed'
    return { id, group, label, ok: false, detail: message }
  }
}

export async function runCircleChecks(): Promise<ConfigCheck[]> {
  const client = getArcClient()
  const [cctp, gateway] = await Promise.allSettled([loadCctpChains(), loadGatewayChains()])

  const checks: Array<Promise<ConfigCheck>> = [
    run('usdc-chain', 'usdc', 'Arc RPC reports chain 5042', async () => {
      const id = await client.getChainId()
      return { ok: id === ARC_CHAIN_ID, detail: `RPC chain ID ${id}` }
    }),
    run('usdc-contract', 'usdc', 'USDC contract is deployed on Arc', async () => ({ ok: await hasCode(USDC.address), detail: USDC.address })),
    run('usdc-token', 'usdc', 'USDC symbol and decimals', async () => {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'decimals' }),
      ])
      return { ok: symbol === 'USDC' && decimals === USDC.decimals, detail: `${symbol}, ${decimals} decimals` }
    }),
    run('usdc-registry', 'usdc', "Circle's registry lists the same USDC address for Arc", () => {
      if (cctp.status === 'rejected') throw cctp.reason
      const listed = cctp.value.destination.usdcAddress
      return { ok: same(listed, USDC.address), detail: `Circle lists ${listed ?? 'none'}` }
    }),
    run('cctp-domain', 'cctp', 'Arc CCTP domain matches the app facts', () => {
      if (cctp.status === 'rejected') throw cctp.reason
      const sdk = cctp.value.destination.cctp?.domain
      const facts = getChain(ARC_CHAIN_ID)?.cctpDomain
      return { ok: sdk !== undefined && sdk === facts, detail: `Circle domain ${sdk ?? 'none'}, app facts ${facts ?? 'none'}` }
    }),
    run('cctp-forwarder', 'cctp', 'Arc supports the forwarding service as a destination', () => {
      if (cctp.status === 'rejected') throw cctp.reason
      const supported = Boolean(cctp.value.destination.cctp?.forwarderSupported.destination)
      return { ok: supported, detail: supported ? 'Circle can submit the mint on Arc' : 'Mint must be submitted by the user wallet' }
    }),
    run('cctp-contracts', 'cctp', 'CCTP TokenMessenger and MessageTransmitter exist on Arc', async () => {
      if (cctp.status === 'rejected') throw cctp.reason
      const v2 = cctp.value.destination.cctp?.contracts.v2 as { tokenMessenger?: string; messageTransmitter?: string } | undefined
      if (!v2?.tokenMessenger || !v2.messageTransmitter) return { ok: false, detail: 'Circle did not list both contracts' }
      const [a, b] = await Promise.all([hasCode(v2.tokenMessenger), hasCode(v2.messageTransmitter)])
      return { ok: a && b, detail: `TokenMessenger ${v2.tokenMessenger}, MessageTransmitter ${v2.messageTransmitter}` }
    }),
    run('cctp-sources', 'cctp', 'Source chains all have a USDC address and a CCTP domain', () => {
      if (cctp.status === 'rejected') throw cctp.reason
      const { sources } = cctp.value
      const complete = sources.filter((chain) => chain.usdcAddress && chain.cctp && chain.rpcEndpoints.length > 0)
      return { ok: sources.length > 0 && complete.length === sources.length, detail: `${complete.length} of ${sources.length} source chains are complete` }
    }),
    run('cctp-cross-check', 'cctp', "Circle's USDC addresses match the app facts where both know the chain", () => {
      if (cctp.status === 'rejected') throw cctp.reason
      const known = cctp.value.sources.filter((chain) => getChain(chain.chainId)?.usdc)
      const wrong = known.filter((chain) => !same(chain.usdcAddress, getChain(chain.chainId)?.usdc?.address))
      return {
        ok: wrong.length === 0 && known.length > 0,
        detail: wrong.length === 0 ? `${known.length} chains agree (${ONCHAIN_CHAINS.length} in app facts)` : `Mismatch on ${wrong.map((chain) => chain.name).join(', ')}`,
      }
    }),
    run('gateway-chain', 'gateway', 'Arc is a Gateway chain', () => {
      if (gateway.status === 'rejected') throw gateway.reason
      return { ok: gateway.value.arc.chainId === ARC_CHAIN_ID, detail: `${gateway.value.chains.length} Gateway chains listed by Circle` }
    }),
    run('gateway-contracts', 'gateway', 'Gateway Wallet and Minter exist on Arc', async () => {
      if (gateway.status === 'rejected') throw gateway.reason
      const v1 = gateway.value.arc.gateway?.contracts.v1 as { wallet?: string; minter?: string } | undefined
      if (!v1?.wallet || !v1.minter) return { ok: false, detail: 'Circle did not list both contracts' }
      const [a, b] = await Promise.all([hasCode(v1.wallet), hasCode(v1.minter)])
      return { ok: a && b, detail: `Wallet ${v1.wallet}, Minter ${v1.minter}` }
    }),
    run('gateway-usdc', 'gateway', "Gateway's Arc USDC matches the app", () => {
      if (gateway.status === 'rejected') throw gateway.reason
      return { ok: same(gateway.value.arc.usdcAddress, USDC.address), detail: `Circle lists ${gateway.value.arc.usdcAddress ?? 'none'}` }
    }),
    run('gateway-api', 'gateway', 'Circle Gateway answers a read-only balance request', async () => {
      const kit = await getAppKit()
      const supported = kit.unifiedBalance.getSupportedChains('USDC').filter(isEvmChain).some((chain) => chainKey(chain) === 'Arc')
      const balance = await getGatewayBalance('0x000000000000000000000000000000000000dEaD')
      return { ok: supported && typeof balance.total === 'string', detail: 'Balance lookup succeeded, no credentials used' }
    }),
  ]
  return Promise.all(checks)
}
