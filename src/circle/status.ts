import { useQuery } from '@tanstack/react-query'
import { erc20Abi } from 'viem'
import { ARC_CHAIN_ID, USDC } from '@/chain'
import { CIRCLE_CONFIG } from '@/circle/config'
import { cpnRail } from '@/circle/payments/rails'
import { loadCctpChains, loadGatewayChains } from '@/circle/sdk'
import { runCircleChecks } from '@/circle/verify'
import { getArcClient } from '@/lib/rpc'

/** Circle's route registry never changes during a session; load it once and share it. */
export function useCctpChains() {
  return useQuery({ queryKey: ['circle', 'cctp-chains'], queryFn: loadCctpChains, staleTime: Infinity, enabled: CIRCLE_CONFIG.cctpEnabled })
}

export function useGatewayChains() {
  return useQuery({ queryKey: ['circle', 'gateway-chains'], queryFn: loadGatewayChains, staleTime: Infinity, enabled: CIRCLE_CONFIG.gatewayEnabled })
}

/** Reads the USDC contract on Arc itself: right chain, contract has code, 6 decimals, symbol USDC. */
export function useUsdcOnArc() {
  return useQuery({
    queryKey: ['circle', 'usdc-on-arc', ARC_CHAIN_ID, USDC.address],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const client = getArcClient()
      const [chainId, code, decimals, symbol] = await Promise.all([
        client.getChainId(),
        client.getCode({ address: USDC.address }),
        client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'decimals' }),
        client.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'symbol' }),
      ])
      return { chainId, hasCode: Boolean(code && code !== '0x'), decimals, symbol, ok: chainId === ARC_CHAIN_ID && Boolean(code && code !== '0x') && decimals === USDC.decimals && symbol === 'USDC' }
    },
  })
}

/** The live configuration checks. Read-only, cached for five minutes, re-run on demand. */
export function useCircleChecks() {
  return useQuery({ queryKey: ['circle', 'config-checks'], queryFn: runCircleChecks, staleTime: 5 * 60_000 })
}

/** Latest Arc block, a cheap live signal that the RPC connection works. */
export function useArcHead() {
  return useQuery({ queryKey: ['circle', 'arc-head'], queryFn: () => getArcClient().getBlockNumber(), staleTime: 15_000, refetchInterval: 30_000 })
}

export type IntegrationState = 'active' | 'checking' | 'unavailable' | 'disabled' | 'needs_access' | 'needs_configuration'

export interface IntegrationItem {
  id: 'usdc' | 'cctp' | 'gateway' | 'payments' | 'cpn'
  /** `live` works now with no Circle credentials. `access` needs access or setup from Circle first. */
  group: 'live' | 'access'
  title: string
  state: IntegrationState
  detail: string
  path?: string
}

/** One honest status per Circle integration. Active means a live check against Arc or Circle's registry passed. */
export function useIntegrationStatus(): IntegrationItem[] {
  const usdc = useUsdcOnArc()
  const cctp = useCctpChains()
  const gateway = useGatewayChains()
  const rail = cpnRail.readiness()

  const usdcItem: IntegrationItem = usdc.isPending
    ? { id: 'usdc', group: 'live', title: 'USDC on Arc', state: 'checking', detail: 'Reading the USDC contract on Arc Mainnet.' }
    : usdc.isError
      ? { id: 'usdc', group: 'live', title: 'USDC on Arc', state: 'unavailable', detail: 'Could not reach Arc Mainnet to check the USDC contract.' }
      : usdc.data.ok
        ? { id: 'usdc', group: 'live', title: 'USDC on Arc', state: 'active', detail: `Native USDC contract verified onchain (${usdc.data.decimals} decimals). Balances, Send, Top Up and Cash Out use it.` }
        : { id: 'usdc', group: 'live', title: 'USDC on Arc', state: 'unavailable', detail: 'The contract at the configured USDC address did not match USDC on Arc Mainnet.' }

  const cctpItem: IntegrationItem = !CIRCLE_CONFIG.cctpEnabled
    ? { id: 'cctp', group: 'live', title: 'CCTP', state: 'disabled', detail: 'Turned off with VITE_CIRCLE_CCTP_ENABLED.', path: '/circle/bridge' }
    : cctp.isPending
      ? { id: 'cctp', group: 'live', title: 'CCTP', state: 'checking', detail: 'Loading Circle supported routes.', path: '/circle/bridge' }
      : cctp.isError
        ? { id: 'cctp', group: 'live', title: 'CCTP', state: 'unavailable', detail: 'Could not load Circle CCTP routes. Try again.', path: '/circle/bridge' }
        : { id: 'cctp', group: 'live', title: 'CCTP', state: 'active', detail: `Native burn-and-mint into Arc from ${cctp.data.sources.length} chains. No credentials needed.`, path: '/circle/bridge' }

  const gatewayItem: IntegrationItem = !CIRCLE_CONFIG.gatewayEnabled
    ? { id: 'gateway', group: 'live', title: 'Gateway', state: 'disabled', detail: 'Turned off with VITE_CIRCLE_GATEWAY_ENABLED.', path: '/circle/gateway' }
    : gateway.isPending
      ? { id: 'gateway', group: 'live', title: 'Gateway', state: 'checking', detail: 'Loading Circle Gateway chains.', path: '/circle/gateway' }
      : gateway.isError
        ? { id: 'gateway', group: 'live', title: 'Gateway', state: 'unavailable', detail: 'Could not load Circle Gateway chains. Try again.', path: '/circle/gateway' }
        : { id: 'gateway', group: 'live', title: 'Gateway', state: 'active', detail: `One USDC balance across ${gateway.data.chains.length} chains, including Arc. No credentials needed.`, path: '/circle/gateway' }

  const paymentsItem: IntegrationItem = {
    id: 'payments',
    group: 'live',
    title: 'Payment infrastructure',
    state: 'active',
    detail:
      rail.status === 'active'
        ? 'USDC on Arc payments are live, with recipient, amount and settlement tracking.'
        : 'USDC on Arc payments are live, with recipient, amount and settlement tracking. Other rails plug into the same layer.',
  }

  const cpnItem: IntegrationItem = {
    id: 'cpn',
    group: 'access',
    title: 'Circle Payments Network',
    state: rail.status === 'active' ? 'active' : rail.status,
    detail: rail.detail,
  }

  return [usdcItem, cctpItem, gatewayItem, paymentsItem, cpnItem]
}
