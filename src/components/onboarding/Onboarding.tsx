import { ConnectKitButton } from 'connectkit'
import { ArrowRight, Loader2 } from 'lucide-react'
import { LogoMark } from '@/components/Logo'
import { ArcHero } from '@/components/onboarding/ArcHero'
import { FeatureExplorer } from '@/components/onboarding/FeatureExplorer'
import { HowItWorks } from '@/components/onboarding/HowItWorks'

/**
 * The entry screen for every disconnected visitor. It stays up (no timer, no skip) until a wallet connects. It explains
 * Arc and the app's features, and its Connect Wallet button opens the app's existing wallet modal directly. Once a
 * wallet connects, the app takes over. It reads no wallet data and shows no balances or history.
 */
export function Onboarding() {
  return (
    <main className="ob-root">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-[150px] pt-5">
        <header className="ob-rise flex items-center gap-2.5">
          <LogoMark size={28} />
          <span className="display text-lg font-semibold tracking-[-0.02em]">Arvexa</span>
        </header>

        <div className="ob-rise mt-3" style={{ ['--d' as string]: '80ms' }}>
          <ArcHero />
        </div>
        <div className="ob-rise mt-6" style={{ ['--d' as string]: '180ms' }}>
          <FeatureExplorer />
        </div>
        <div className="ob-rise mt-6" style={{ ['--d' as string]: '280ms' }}>
          <HowItWorks />
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 bg-gradient-to-t from-[#050913] via-[#050913]/92 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8">
        <div className="mx-auto w-full max-w-md">
          <ConnectKitButton.Custom>
            {({ show, isConnecting }) => (
              <button
                type="button"
                onClick={() => show?.()}
                disabled={isConnecting}
                className="ob-cta flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold transition-transform duration-200 active:scale-[0.97] disabled:opacity-80"
              >
                {isConnecting ? <Loader2 className="size-5 animate-spin" aria-hidden /> : null}
                Connect Wallet
                {isConnecting ? null : <ArrowRight className="size-5" aria-hidden />}
              </button>
            )}
          </ConnectKitButton.Custom>
          <p className="mt-2 text-center text-[11px] text-[#7f93b3]">Your wallet signs everything. Nothing moves until you confirm it.</p>
        </div>
      </div>
    </main>
  )
}
