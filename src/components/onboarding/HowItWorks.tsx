import { Compass, Wallet, Zap, type LucideIcon } from 'lucide-react'

const STEPS: ReadonlyArray<{ label: string; hint: string; icon: LucideIcon; color: string }> = [
  { label: 'Connect', hint: 'Link your wallet', icon: Wallet, color: '#2cf5a6' },
  { label: 'Explore', hint: 'See what you can do', icon: Compass, color: '#22d3ee' },
  { label: 'Pay', hint: 'Move USDC on Arc', icon: Zap, color: '#a855f7' },
]

/** Connect, Explore, Pay: three nodes that light up in turn, joined by a line with a travelling glow. */
export function HowItWorks() {
  return (
    <section aria-labelledby="ob-how" className="ob-glass rounded-3xl p-5">
      <h2 id="ob-how" className="display text-base font-semibold">
        How it works
      </h2>
      <ol className="relative mt-5 grid grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.label} className="relative flex flex-col items-center text-center">
            {index > 0 && (
              <span aria-hidden className="absolute right-1/2 top-6 h-px w-full -translate-y-1/2 overflow-hidden bg-white/12">
                <span className="absolute top-1/2 block h-[3px] w-[10px] -translate-y-1/2 rounded-full" style={{ background: `linear-gradient(90deg, transparent, ${step.color})`, boxShadow: `0 0 12px 2px ${step.color}`, animation: 'ob-flow 2.4s ease-in-out infinite', animationDelay: `${(index - 1) * 1.2}s` }} />
              </span>
            )}
            <span
              className="relative z-10 grid size-12 place-items-center rounded-2xl border bg-[#08121f]"
              style={{ ['--c' as string]: step.color, color: step.color, animation: 'ob-step 3.6s ease-in-out infinite', animationDelay: `${index * 1.2}s` }}
            >
              <step.icon className="size-5" aria-hidden />
            </span>
            <span className="mt-2 text-sm font-semibold">{step.label}</span>
            <span className="mt-0.5 max-w-[11ch] text-[11px] leading-tight text-[#8da2c2]">{step.hint}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
