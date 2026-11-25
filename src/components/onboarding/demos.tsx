import type { CSSProperties, ReactNode } from 'react'
import { Check, Link2, ScanLine, Wallet, type LucideIcon } from 'lucide-react'

/**
 * Small looping illustrations for the intro. They show how a feature works with generic labels only: no amounts,
 * addresses or balances, so nothing here can be mistaken for real wallet data. Each loop is CSS only.
 */

const loop = (name: string, delay = 0): CSSProperties => ({ animationName: name, animationDelay: `${delay}s` })

function Frame({ children, tall }: { children: ReactNode; tall?: boolean }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-white/10 bg-black/30 ${tall ? 'h-[168px]' : 'h-[132px]'}`} aria-hidden>
      {children}
    </div>
  )
}

function Node({ label, side, icon: Icon = Wallet }: { label: string; side: 'left' | 'right'; icon?: LucideIcon }) {
  return (
    <div className={`absolute top-1/2 flex -translate-y-1/2 flex-col items-center gap-1.5 ${side === 'left' ? 'left-4' : 'right-4'}`}>
      <span className="grid size-12 place-items-center rounded-2xl border border-white/15 bg-white/[0.06] text-[#2cf5a6]">
        <Icon className="size-5" />
      </span>
      <span className="text-[11px] text-[#9db0cf]">{label}</span>
    </div>
  )
}

export function SendReceiveDemo() {
  return (
    <Frame>
      <Node label="You" side="left" />
      <Node label="Friend" side="right" />
      <span className="absolute left-[26%] right-[26%] top-1/2 h-px bg-gradient-to-r from-[#2cf5a6]/10 via-[#22d3ee]/60 to-[#2cf5a6]/10" />
      <span
        className="ob-demo-loop absolute top-1/2 grid size-7 place-items-center rounded-full text-[12px] font-bold text-white shadow-[0_0_18px_rgba(79,140,255,0.9)]"
        style={{ ...loop('ob-coin'), background: 'radial-gradient(circle at 30% 25%, #6fa8ff, #2775ca 70%)' }}
      >
        $
      </span>
      <span className="ob-demo-loop absolute bottom-2.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#2cf5a6]/15 px-2.5 py-1 text-[11px] font-semibold text-[#2cf5a6]" style={loop('ob-badge')}>
        <Check className="size-3" /> USDC received
      </span>
    </Frame>
  )
}

const QR_ROWS = ['1110111', '1010101', '1110111', '0001000', '1101011', '0110101', '1010011']

export function ScanPayDemo() {
  return (
    <Frame>
      <div className="absolute left-1/2 top-1/2 size-[92px] -translate-x-1/2 -translate-y-1/2">
        <div className="ob-demo-loop grid h-full w-full grid-cols-7 gap-[3px] rounded-lg bg-white/[0.07] p-2" style={loop('ob-qr')}>
          {QR_ROWS.join('')
            .split('')
            .map((cell, index) => (
              <span key={index} className={cell === '1' ? 'rounded-[2px] bg-[#22d3ee]' : 'rounded-[2px] bg-transparent'} />
            ))}
        </div>
        <span className="ob-demo-loop absolute inset-x-[-6px] block h-[3px] rounded-full bg-[#22d3ee] shadow-[0_0_14px_3px_rgba(34,211,238,0.8)]" style={loop('ob-scanline')} />
        <ScanLine className="absolute -left-2 -top-2 size-3 text-[#4f8cff]" />
      </div>
      <div className="ob-demo-loop absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-2xl border border-[#22d3ee]/40 bg-[#07182b]/95 p-3 text-center shadow-[0_0_30px_-8px_rgba(34,211,238,0.7)]" style={loop('ob-sheet')}>
        <span className="mx-auto grid size-8 place-items-center rounded-full bg-[#22d3ee]/20 text-[#22d3ee]">
          <Check className="size-4" />
        </span>
        <p className="mt-1.5 text-xs font-semibold">Details reviewed. Payment confirmed.</p>
      </div>
    </Frame>
  )
}

function StatusSwap({ delay = 0 }: { delay?: number }) {
  return (
    <span className="relative inline-block h-6 w-[68px]">
      <span className="ob-demo-loop absolute inset-0 grid place-items-center rounded-full bg-[#f5b94a]/15 text-[11px] font-semibold text-[#f5b94a]" style={loop('ob-pending', delay)}>
        Pending
      </span>
      <span className="ob-demo-loop absolute inset-0 grid place-items-center rounded-full bg-[#2cf5a6]/15 text-[11px] font-semibold text-[#2cf5a6] opacity-0" style={loop('ob-paid', delay)}>
        Paid
      </span>
    </span>
  )
}

export function RequestPayDemo() {
  return (
    <Frame>
      <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl border border-white/12 bg-white/[0.06] p-3.5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-[#4f8cff]/40 to-[#a855f7]/40 text-[#9cc0ff]">
            <Link2 className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Payment request</p>
            <p className="text-[11px] text-[#8da2c2]">Link created, waiting for payment</p>
          </div>
          <StatusSwap />
        </div>
        <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-white/10">
          <span className="ob-demo-loop block h-full origin-left rounded-full bg-gradient-to-r from-[#4f8cff] to-[#a855f7]" style={loop('ob-fill')} />
        </span>
      </div>
    </Frame>
  )
}

const FRIENDS = ['Friend 1', 'Friend 2', 'Friend 3']

export function SplitDemo() {
  return (
    <Frame tall>
      <div className="absolute inset-x-4 top-3">
        <p className="mb-1.5 text-[11px] text-[#8da2c2]">Bill, split three ways</p>
        <div className="flex gap-1">
          {FRIENDS.map((_, index) => (
            <span key={index} className="ob-demo-loop h-2 flex-1 rounded-full bg-gradient-to-r from-[#a855f7] to-[#e879f9] opacity-25" style={loop('ob-seg', index * 0.9)} />
          ))}
        </div>
      </div>
      <ul className="absolute inset-x-4 bottom-3 space-y-1.5">
        {FRIENDS.map((name, index) => (
          <li key={name} className="flex items-center justify-between rounded-xl bg-white/[0.05] px-3 py-1.5">
            <span className="flex items-center gap-2 text-xs">
              <span className="grid size-5 place-items-center rounded-full bg-gradient-to-br from-[#a855f7] to-[#4f8cff] text-[10px] font-bold">{index + 1}</span>
              {name}
            </span>
            <StatusSwap delay={index * 0.9} />
          </li>
        ))}
      </ul>
    </Frame>
  )
}
