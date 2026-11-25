import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Layout } from '@/components/Layout'
import { Button, Card, PageHeader, Skeleton } from '@/components/ui'
import { Onboarding } from '@/components/onboarding/Onboarding'
import { useAppGate } from '@/lib/onboarding'
import { navigate, useRoute } from '@/lib/router'

const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Send = lazy(() => import('@/pages/Send'))
const Receive = lazy(() => import('@/pages/Receive'))
const Swap = lazy(() => import('@/pages/Swap'))
const Deposit = lazy(() => import('@/pages/Deposit'))
const Withdraw = lazy(() => import('@/pages/Withdraw'))
const Activity = lazy(() => import('@/pages/Activity'))
const Settings = lazy(() => import('@/pages/Settings'))
const Circle = lazy(() => import('@/pages/Circle'))
const CircleBridge = lazy(() => import('@/pages/CircleBridge'))
const CircleGateway = lazy(() => import('@/pages/CircleGateway'))

const PAGES: Record<string, LazyExoticComponent<ComponentType>> = {
  '/': Dashboard,
  '/send': Send,
  '/receive': Receive,
  '/swap': Swap,
  '/deposit': Deposit,
  '/withdraw': Withdraw,
  '/activity': Activity,
  '/settings': Settings,
  '/circle': Circle,
  '/circle/bridge': CircleBridge,
  '/circle/gateway': CircleGateway,
}

function PageFallback() {
  return (
    <Card className="space-y-3" aria-busy>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-24 w-full" />
    </Card>
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
  const route = useRoute()
  const Page = PAGES[route]
  return (
    <Layout>
      <div key={route} className="page-in">
        {Page ? (
          <Suspense fallback={<PageFallback />}>
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
export default function App() {
  const gate = useAppGate()
  if (gate === 'splash') return <div className="min-h-dvh" aria-busy />
  return (
    <AnimatePresence mode="wait" initial={false}>
      {gate === 'intro' ? (
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
