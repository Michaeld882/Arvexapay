import type { ReactNode } from 'react'
import { useDisconnect } from 'wagmi'
import { Moon, Sun } from 'lucide-react'
import { ARC_RPC_URL, ARVEXA_ADDRESS } from '@/chain'
import { Logo } from '@/components/Logo'
import { NetworkInfo } from '@/components/NetworkInfo'
import { Button, Card, CopyButton, PageHeader, Row, cx } from '@/components/ui'
import { VaultSummary } from '@/components/VaultStatus'
import { WalletButton } from '@/components/WalletButton'
import { useWallet } from '@/hooks/useWallet'
import { SWAP_CONFIGURED, SWAP_PROVIDER } from '@/swap-config'
import { useTheme } from '@/theme/ThemeProvider'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="display mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </Card>
  )
}

export default function Settings() {
  const { theme, setTheme } = useTheme()
  const { address, status } = useWallet()
  const { disconnect } = useDisconnect()

  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-5">
        <Section title="Theme">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Theme">
            {(['light', 'dark'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={theme === option}
                onClick={() => setTheme(option)}
                className={cx(
                  'flex min-h-12 items-center justify-center gap-2 rounded-2xl border text-sm font-semibold capitalize transition-colors duration-200',
                  theme === option ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-muted text-ink-2 hover:border-line-strong',
                )}
              >
                {option === 'light' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
                {option}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Connected wallet">
          {address ? (
            <div className="space-y-3">
              <p className="mono rounded-2xl border border-line bg-surface-muted px-4 py-3 text-xs [overflow-wrap:anywhere]">{address}</p>
              <p className="text-sm text-muted">{status === 'wrong-network' ? 'Connected, but not on Arc Mainnet.' : 'Connected on Arc Mainnet.'}</p>
              <div className="flex gap-2">
                <CopyButton value={address} label="Copy address" className="flex-1" />
                <Button variant="secondary" className="flex-1" onClick={() => disconnect()}>
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted">No wallet connected.</p>
              <WalletButton />
            </div>
          )}
        </Section>

        <Section title="Network">
          <NetworkInfo />
          <dl>
            <Row label="RPC endpoint">
              <span className="mono text-xs">{new URL(ARC_RPC_URL).host}</span>
            </Row>
          </dl>
        </Section>

        <Section title="Arvexa contract">
          <VaultSummary />
          {!ARVEXA_ADDRESS && (
            <p className="mt-3 text-xs text-muted">
              Configuration point: <span className="mono">VITE_ARVEXA_CONTRACT_ADDRESS</span> in <span className="mono">.env</span>. Restart the dev server or rebuild after changing it.
            </p>
          )}
        </Section>

        <Section title="Swap provider">
          <p className="text-sm font-semibold">{SWAP_CONFIGURED ? `${SWAP_PROVIDER?.name} configured` : 'Swap liquidity is not configured'}</p>
          <p className="mt-1 text-sm text-muted">Providers are registered in <span className="mono text-xs">src/swap-config.ts</span>.</p>
        </Section>
        <Card className="flex items-center justify-between gap-4">
          <Logo size={44} wordmarkClassName="text-xl" />
          <p className="text-right text-xs text-muted">USDC wallet and payments on Arc Mainnet</p>
        </Card>
      </div>
    </>
  )
}
