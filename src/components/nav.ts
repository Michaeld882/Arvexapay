import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  History,
  LayoutDashboard,
  HandCoins,
  QrCode,
  ScanLine,
  Send,
  Waypoints,
  Settings,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
  summary: string
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, summary: 'Balances and recent activity' },
  { path: '/send', label: 'Send', icon: Send, summary: 'Send USDC to any address' },
  { path: '/receive', label: 'Receive', icon: QrCode, summary: 'Your address and QR code' },
  { path: '/payments', label: 'Payments', icon: HandCoins, summary: 'Requests, splits, invoices and receipts' },
  { path: '/scan', label: 'ScanFlow', icon: ScanLine, summary: 'Scan a payment QR code' },
  { path: '/swap', label: 'Swap', icon: ArrowLeftRight, summary: 'Swap tokens on Arc' },
  { path: '/deposit', label: 'Top Up', icon: ArrowDownToLine, summary: 'Fund your wallet or vault' },
  { path: '/withdraw', label: 'Cash Out', icon: ArrowUpFromLine, summary: 'Cash out from your wallet or vault' },
  { path: '/circle', label: 'Circle', icon: Waypoints, summary: 'USDC, CCTP, Gateway and payment rails' },
  { path: '/activity', label: 'Activity', icon: History, summary: 'Your onchain activity' },
  { path: '/settings', label: 'Settings', icon: Settings, summary: 'Theme, network, contract' },
]
