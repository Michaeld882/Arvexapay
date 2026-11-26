import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import { NETWORK_NAME } from '@/chain'
import { Link, useRoute } from '@/lib/router'
import { Logo } from '@/components/Logo'
import { NAV_ITEMS } from '@/components/nav'
import { cx } from '@/components/ui'
import { NetworkBanner } from '@/components/NetworkBanner'
import { RecoveryNotice } from '@/components/RecoveryNotice'
import { ThemeToggle } from '@/components/ThemeToggle'
import { TopProgress } from '@/components/TopProgress'
import { WalletButton } from '@/components/WalletButton'
import { useWallet } from '@/hooks/useWallet'

function HeaderLogo() {
  return (
    <Link to="/" className="flex items-center rounded-xl" aria-label="Arvexa home">
      <Logo wordmarkClassName="hidden min-[420px]:inline" />
    </Link>
  )
}

function NetworkPill() {
  const { status } = useWallet()
  const wrong = status === 'wrong-network'
  return (
    <span
      className="hidden items-center gap-2 rounded-full border border-line bg-surface-muted px-3 py-1.5 text-xs font-semibold text-ink-2 sm:inline-flex"
      title={wrong ? 'Wallet is on another network' : undefined}
    >
      <span className="dot-live size-2 rounded-full" style={{ background: wrong ? 'var(--danger)' : 'var(--success)' }} aria-hidden />
      {wrong ? 'Wrong network' : NETWORK_NAME}
    </span>
  )
}

/** pillId is set only where the active highlight should glide between items (the desktop sidebar). */
function NavLinks({ onNavigate, pillId, stagger = false }: { onNavigate?: () => void; pillId?: string; stagger?: boolean }) {
  const route = useRoute()
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ path, label, icon: Icon }, index) => {
        const active = route === path || (path !== '/' && route.startsWith(`${path}/`))
        return (
          <Link
            key={path}
            to={path}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            style={stagger ? { ['--d' as string]: `${140 + index * 45}ms` } : undefined}
            className={cx(
              'group relative flex min-h-11 items-center gap-3 rounded-2xl px-3.5 text-sm font-medium transition-[color,background-color,transform] duration-200 active:scale-[0.97]',
              stagger && 'slide-in',
              active ? 'text-ink' : 'text-ink-2 hover:bg-surface-muted',
            )}
          >
            {active &&
              (pillId ? (
                <motion.span
                  layoutId={pillId}
                  aria-hidden
                  className="absolute inset-0 rounded-2xl border border-line-strong bg-accent-soft"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              ) : (
                <span aria-hidden className="fade-in absolute inset-0 rounded-2xl border border-line-strong bg-accent-soft" />
              ))}
            <Icon className={cx('relative size-[18px] transition-[color,transform] duration-200 group-hover:translate-x-0.5', active && 'text-accent-hover')} aria-hidden />
            <span className="relative">{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const route = useRoute()

  useEffect(() => {
    const page = NAV_ITEMS.find((item) => item.path === route)
    document.title = page && page.path !== '/' ? `${page.label} | Arvexa` : 'Arvexa'
  }, [route])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenuOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md" style={{ background: 'color-mix(in srgb, var(--bg) 88%, transparent)' }}>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <HeaderLogo />
          <div className="flex items-center gap-2">
            <NetworkPill />
            <ThemeToggle />
            <WalletButton className="px-3.5" />
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              className="inline-flex size-11 items-center justify-center rounded-2xl border border-line bg-surface-muted text-ink md:hidden"
            >
              <Menu className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <TopProgress />
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-4 pb-24 pt-6">
        <aside className="sticky top-24 hidden h-fit w-56 shrink-0 md:block">
          <NavLinks pillId="nav-pill-desktop" />
        </aside>
        <main className="min-w-0 max-w-2xl flex-1">
          <NetworkBanner />
          <RecoveryNotice />
          {children}
        </main>
      </div>

      <AnimatePresence>
        {menuOpen && (
          <motion.div className="fixed inset-0 z-40 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button type="button" aria-label="Close menu" className="absolute inset-0" style={{ background: 'var(--overlay)' }} onClick={() => setMenuOpen(false)} />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className="absolute right-0 top-0 flex h-full w-72 max-w-[85%] flex-col gap-4 bg-surface-strong p-4 shadow-2xl"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            >
              <div className="flex items-center justify-between">
                <Logo size={32} />
                <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close menu" className="inline-flex size-11 items-center justify-center rounded-2xl hover:bg-surface-muted">
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <NavLinks stagger onNavigate={() => setMenuOpen(false)} />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
