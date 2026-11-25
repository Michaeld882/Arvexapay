import { useId, useMemo, type ReactNode } from 'react'

/**
 * A stylized arc mark. It is a simple drawn shape, not Circle's official artwork: to use the official Arc logo,
 * replace the contents of this component with it.
 */
export function ArcMark({ size = 44 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Arc" className="shrink-0">
      <defs>
        <linearGradient id={id} x1="6" y1="40" x2="42" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2cf5a6" />
          <stop offset="0.55" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <path d="M9 37C9 20 17 10 24 10s15 10 15 27" fill="none" stroke={`url(#${id})`} strokeWidth="5.5" strokeLinecap="round" />
      <circle cx="24" cy="31" r="4" fill="#eaf3ff" />
    </svg>
  )
}

function UsdcChip({ size = 26 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid place-items-center rounded-full text-[11px] font-bold text-white shadow-[0_0_14px_rgba(79,140,255,0.8)]"
      style={{ width: size, height: size, background: 'radial-gradient(circle at 30% 25%, #6fa8ff, #2775ca 70%)' }}
    >
      $
    </span>
  )
}

function Spark({ size = 10, color = '#2cf5a6' }: { size?: number; color?: string }) {
  return <span aria-hidden className="block rounded-full" style={{ width: size, height: size, background: color, boxShadow: `0 0 12px 2px ${color}` }} />
}

/** Deterministic pseudo-random numbers, so the particles are stable between renders. */
function seeded(index: number, salt: number): number {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

const PARTICLE_COLORS = ['#2cf5a6', '#22d3ee', '#4f8cff', '#a855f7']

function Particles({ count = 16 }: { count?: number }) {
  const dots = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        left: `${Math.round(seeded(i, 1) * 100)}%`,
        top: `${Math.round(seeded(i, 2) * 100)}%`,
        size: 2 + Math.round(seeded(i, 3) * 3),
        color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
        t: `${3 + seeded(i, 4) * 4}s`,
        d: `${(seeded(i, 5) * 3).toFixed(2)}s`,
      })),
    [count],
  )
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {dots.map((dot, index) => (
        <span key={index} className="ob-dot" style={{ left: dot.left, top: dot.top, width: dot.size, height: dot.size, background: dot.color, boxShadow: `0 0 8px ${dot.color}`, ['--t' as string]: dot.t, ['--d' as string]: dot.d }} />
      ))}
    </div>
  )
}

interface RingProps {
  size: number
  seconds: number
  reverse?: boolean
  children?: ReactNode
}

function Ring({ size, seconds, reverse, children }: RingProps) {
  return (
    <div
      aria-hidden
      className="ob-ring"
      style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, ['--t' as string]: `${seconds}s`, ['--dir' as string]: reverse ? 'reverse' : 'normal' }}
    >
      {children}
    </div>
  )
}

/** The Arc scene: a pulsing logo, three slow orbits, and USDC-style tokens travelling around them. */
export function ArcHero() {
  return (
    <section aria-labelledby="ob-title" className="relative">
      <div className="relative mx-auto h-[250px] w-full max-w-[340px]">
        <Particles />
        <Ring size={250} seconds={34} reverse>
          <span className="ob-ring-item" style={{ left: '82%', top: '8%' }}><Spark size={8} color="#a855f7" /></span>
          <span className="ob-ring-item" style={{ left: '12%', top: '78%' }}><Spark size={7} color="#22d3ee" /></span>
        </Ring>
        <Ring size={186} seconds={24}>
          <span className="ob-ring-item"><UsdcChip size={24} /></span>
          <span className="ob-ring-item" style={{ left: '50%', top: '100%' }}><Spark size={9} color="#2cf5a6" /></span>
        </Ring>
        <Ring size={124} seconds={16} reverse>
          <span className="ob-ring-item" style={{ left: '100%', top: '50%' }}><UsdcChip size={20} /></span>
        </Ring>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="ob-logo grid size-[78px] place-items-center rounded-[26px] border border-white/15 bg-[#07111f]/80 backdrop-blur">
            <ArcMark size={44} />
          </div>
        </div>
      </div>
      <div className="relative mt-1 text-center">
        <h1 id="ob-title" className="display text-[2rem] font-semibold leading-tight">
          Built on <span className="ob-grad-text">Arc</span>
        </h1>
        <p className="mx-auto mt-2 max-w-[30ch] text-balance text-sm leading-relaxed text-[#a9bbd6]">
          Fast, low-cost stablecoin payments powered by Arc.
        </p>
      </div>
    </section>
  )
}
