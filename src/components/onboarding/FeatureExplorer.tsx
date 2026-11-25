import { useState, type ComponentType } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeftRight, ChevronDown, Link2, QrCode, Users, type LucideIcon } from 'lucide-react'
import { RequestPayDemo, ScanPayDemo, SendReceiveDemo, SplitDemo } from '@/components/onboarding/demos'

interface Feature {
  id: string
  title: string
  blurb: string
  from: string
  to: string
  icon: LucideIcon
  motion: string
  Demo: ComponentType
}

const FEATURES: readonly Feature[] = [
  { id: 'send', title: 'Send & Receive', blurb: 'Send or receive USDC using a wallet address or QR code.', from: '#2cf5a6', to: '#22d3ee', icon: ArrowLeftRight, motion: 'ob-nudge 2.2s ease-in-out infinite', Demo: SendReceiveDemo },
  { id: 'scan', title: 'Scan & Pay', blurb: 'Scan a payment QR code, review the details, then confirm.', from: '#22d3ee', to: '#4f8cff', icon: QrCode, motion: 'ob-breath 2.6s ease-in-out infinite', Demo: ScanPayDemo },
  { id: 'split', title: 'Split Payment', blurb: 'Divide a bill between friends and track who has paid.', from: '#a855f7', to: '#e879f9', icon: Users, motion: 'ob-nudge 2.6s ease-in-out infinite', Demo: SplitDemo },
  { id: 'request', title: 'Request Pay', blurb: 'Create a payment link with an amount and reference, then track the payment status.', from: '#4f8cff', to: '#a855f7', icon: Link2, motion: 'ob-breath 2.8s ease-in-out infinite', Demo: RequestPayDemo },
]

function FeatureCard({ feature, open, onToggle, index }: { feature: Feature; open: boolean; onToggle: () => void; index: number }) {
  const panelId = `ob-panel-${feature.id}`
  return (
    <li
      className="ob-glass ob-rise overflow-hidden rounded-3xl transition-[border-color,box-shadow] duration-300"
      style={open ? { borderColor: `${feature.from}66`, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.1), 0 0 36px -12px ${feature.from}`, ['--d' as string]: `${index * 70}ms` } : { ['--d' as string]: `${index * 70}ms` }}
    >
      <motion.button
        type="button"
        whileTap={{ scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-[68px] w-full items-center gap-3.5 p-4 text-left"
      >
        <span
          className="grid size-11 shrink-0 place-items-center rounded-2xl border"
          style={{ color: feature.from, borderColor: `${feature.from}55`, background: `linear-gradient(145deg, ${feature.from}26, ${feature.to}1a)`, boxShadow: `0 0 22px -6px ${feature.from}` }}
        >
          <feature.icon className="size-5" style={{ animation: feature.motion }} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="display text-[15px] font-semibold">{feature.title}</span>
          </span>
          <span className="mt-0.5 block text-xs text-[#8da2c2]">{open ? 'Tap to close' : 'Tap to see how it works'}</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ type: 'spring', stiffness: 300, damping: 24 }} className="text-[#8da2c2]">
          <ChevronDown className="size-5" aria-hidden />
        </motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            id={panelId}
            role="region"
            aria-label={feature.title}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 32 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-4 pb-4">
              <p className="text-sm leading-relaxed text-[#c3d1e8]">{feature.blurb}</p>
              <feature.Demo />
              <p className="text-[11px] text-[#7f93b3]">Illustration only. No real transaction.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

/** Four tappable cards. One is open at a time, so the screen never feels crowded. */
export function FeatureExplorer() {
  const [openId, setOpenId] = useState<string | null>(FEATURES[0].id)
  return (
    <section aria-labelledby="ob-features">
      <h2 id="ob-features" className="display mb-3 px-1 text-base font-semibold">
        What you can do
      </h2>
      <ul className="space-y-3">
        {FEATURES.map((feature, index) => (
          <FeatureCard key={feature.id} feature={feature} index={index} open={openId === feature.id} onToggle={() => setOpenId((current) => (current === feature.id ? null : feature.id))} />
        ))}
      </ul>
      <p className="mt-4 px-1 text-xs text-[#8da2c2]" data-testid="ob-also">
        Also in the app: Swap, Deposit, Withdraw, Bridge &amp; Gateway, and your Activity history.
      </p>
    </section>
  )
}
