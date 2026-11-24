import { useEffect, useRef } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import { formatUsdcDisplay } from '@/lib/format'

// Raw USDC is a bigint; motion values are doubles. Above this the animation is skipped (never inexact).
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const EASE = [0.22, 1, 0.36, 1] as const

interface AnimatedAmountProps {
  raw: bigint
  /** When this changes (for example the connected address) the amount counts up again from zero. */
  resetKey: string
  className?: string
}

/**
 * Shows a USDC amount. It counts up from zero when it first appears or the account changes, and eases
 * from the old to the new value when the same account's balance changes. The final frame is always the
 * exact amount, and reduced-motion users get the exact amount at once.
 */
export function AnimatedAmount({ raw, resetKey, className }: AnimatedAmountProps) {
  const reduceMotion = useReducedMotion()
  const motionValue = useMotionValue(reduceMotion || raw > MAX_SAFE ? Number(raw) : 0)
  const text = useTransform(motionValue, (value) => formatUsdcDisplay(BigInt(Math.round(value))))
  const previous = useRef<{ raw: bigint; resetKey: string } | null>(null)

  useEffect(() => {
    const before = previous.current
    if (before && before.raw === raw && before.resetKey === resetKey) return
    previous.current = { raw, resetKey }
    if (reduceMotion || raw > MAX_SAFE) {
      motionValue.set(Number(raw))
      return
    }
    const fromZero = !before || before.resetKey !== resetKey
    if (fromZero) motionValue.set(0)
    const run = { completed: false }
    const controls = animate(motionValue, Number(raw), {
      duration: fromZero ? 1.1 : 0.7,
      ease: EASE,
      onComplete: () => {
        run.completed = true
        motionValue.set(Number(raw))
      },
    })
    return () => {
      controls.stop()
      // An interrupted run (React StrictMode re-runs effects in development) must not count as shown.
      if (!run.completed) previous.current = before
    }
  }, [raw, resetKey, reduceMotion, motionValue])

  return <motion.span className={className}>{text}</motion.span>
}
