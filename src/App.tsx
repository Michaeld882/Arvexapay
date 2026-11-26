import { Suspense, lazy, useDeferredValue, useEffect, type ComponentType, type LazyExoticComponent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Layout } from '@/components/Layout'
import { BackButton, Button, Card, PageHeader, Skeleton, cx } from '@/components/ui'
import { Onboarding } from '@/components/onboarding/Onboarding'
import { useAppGate } from '@/lib/onboarding'
import { LogoMark } from '@/components/Logo'
import { PAGE_LOADERS, warmAllPages } from '@/lib/pages'
import { ensureBackStack, navigate, useRoute } from '@/lib/router'

const PAGES: Record<string, LazyExoticComponent<ComponentType>> = Object.fromEntries(Object.entries(PAGE_LOADERS).map(([path, load]) => [path, lazy(load)]))
const Pay = PAGES['/pay']

/** Shown only while a screen's code is still downloading: the Back button works at once, and the layout is already in place. */
function PageFallback({ route }: { route: string }) {
  return (
    <div aria-busy className="space-y-4">
      {route !== '/' && <BackButton />}
      <Skeleton className="h-8 w-48" />
      <Card className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
      </Card>
    </div>
  )
}

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" subtitle="That address does not match any Arvexa page." />
      <Card>
        <Button onClick={() => navigate('/')}>Go to Dashboard</Button>
      </Card>
    </>
  )
}

function MainApp() {
  const live = useRoute()
  // The screen you tapped is highlighted at once. The page itself switches as soon as its code is ready, and until
  // then the previous page stays on screen (dimmed, with a progress line) instead of dropping to a loading screen.
  const route = useDeferredValue(live)
  const switching = live !== route
  const Page = PAGES[route]

  useEffect(() => {
    ensureBackStack()
    warmAllPages()
  }, [])

  return (
    <Layout>
      {switching && <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden"><div className="progress-bar h-full w-2/5 rounded-full bg-accent" /></div>}
      <div key={route} className={cx('page-in', switching && 'page-switching')}>
        {Page ? (
          <Suspense fallback={<PageFallback route={route} />}>
            <Page />
          </Suspense>
        ) : (
          <NotFound />
        )}
      </div>
    </Layout>
  )
}

/**
 * One intro screen before a wallet is connected, with the Connect Wallet button on it. Connecting opens the existing
 * wallet modal; once a wallet is connected the existing app shows, with no screen in between.
 */
/** A payment link opened with no wallet connected: show the payment first, with its own Connect button. */
function PublicPay() {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-xl items-center gap-2.5 px-4">
          <LogoMark size={28} />
          <span className="display text-lg font-semibold tracking-[-0.02em]">Arvexa</span>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 py-6">
        <Suspense fallback={<PageFallback route="/pay" />}>
          <Pay />
        </Suspense>
      </main>
    </div>
  )
}

export default function App() {
  const gate = useAppGate()
  const route = useRoute()
  if (gate === 'splash') return <div className="min-h-dvh" aria-busy />
  return (
    <AnimatePresence mode="wait" initial={false}>
      {gate === 'intro' && route === '/pay' ? (
        <motion.div key="pay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
          <PublicPay />
        </motion.div>
      ) : gate === 'intro' ? (
        <motion.div key="intro" exit={{ opacity: 0, filter: 'blur(6px)' }} transition={{ duration: 0.28 }}>
          <Onboarding />
        </motion.div>
      ) : (
        <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
          <MainApp />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
