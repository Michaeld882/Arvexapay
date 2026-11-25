import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { Layout } from '@/components/Layout'
import { Button, Card, PageHeader, Skeleton } from '@/components/ui'
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

export default function App() {
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
