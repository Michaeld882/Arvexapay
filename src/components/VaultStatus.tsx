import { ARVEXA } from '@/chain'
import type { VaultState } from '@/hooks/useChainData'
import { useVault } from '@/hooks/useVault'
import { Banner, Button, ExplorerLink } from '@/components/ui'

export const VAULT_LABEL: Record<VaultState['state'], string> = {
  missing: 'Contract not configured',
  invalid: 'Invalid contract address',
  checking: 'Verifying contract',
  error: 'Could not verify contract',
  'no-code': 'No contract at this address',
  'usdc-mismatch': 'Not an Arvexa vault for official USDC',
  ready: 'Contract verified',
}

const VAULT_DETAIL: Record<VaultState['state'], string> = {
  missing: 'Set VITE_ARVEXA_CONTRACT_ADDRESS to the deployed Arvexa contract to enable the vault (Top Up and Cash Out). Sending USDC works without it.',
  invalid: 'VITE_ARVEXA_CONTRACT_ADDRESS is set but is not a valid nonzero address. Vault actions are disabled.',
  checking: 'Checking the configured address on Arc Mainnet.',
  error: 'The Arc Mainnet RPC did not answer while checking the contract. Vault actions stay disabled until it can be verified.',
  'no-code': 'Nothing is deployed at the configured address on Arc Mainnet. Vault actions are disabled.',
  'usdc-mismatch': 'The contract at the configured address does not report the official Arc USDC token. Vault actions are disabled.',
  ready: 'The configured address is an Arvexa vault for the official Arc USDC token.',
}

/** Explains why vault actions are unavailable. Renders nothing when the vault is ready. */
export function VaultGate() {
  const { vault } = useVault()
  if (vault.state === 'ready') return null
  const tone = vault.state === 'checking' ? 'info' : 'warn'
  return (
    <Banner
      tone={tone}
      title={VAULT_LABEL[vault.state]}
      action={
        vault.state === 'error' ? (
          <Button variant="secondary" className="min-h-10" onClick={vault.refetch}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {VAULT_DETAIL[vault.state]}
    </Banner>
  )
}

export function VaultSummary() {
  const { vault } = useVault()
  return (
    <div className="space-y-2 text-sm">
      <p className="font-semibold text-ink">{VAULT_LABEL[vault.state]}</p>
      <p className="text-muted">{VAULT_DETAIL[vault.state]}</p>
      {ARVEXA.status === 'configured' && (
        <p className="mono break-all text-xs text-ink-2">
          {ARVEXA.address} <ExplorerLink address={ARVEXA.address} label="Explorer" />
        </p>
      )}
      {vault.state === 'ready' && vault.paused && <p className="text-warn">Top-ups are paused by the contract owner. Cash-outs still work.</p>}
    </div>
  )
}
