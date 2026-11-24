import { useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { MotionConfig } from 'framer-motion'
import { Toaster } from 'sonner'
import { config } from '@/config'
import { ARC_CHAIN_ID } from '@/chain'
import { createQueryClient } from '@/lib/queryClient'
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider'

function ThemedShell({ children }: { children: ReactNode }) {
  const { theme } = useTheme()
  return (
    <ConnectKitProvider
      mode={theme}
      customTheme={{ '--ck-accent-color': theme === 'dark' ? '#2fbf86' : '#0f7a52', '--ck-accent-text-color': theme === 'dark' ? '#04150d' : '#ffffff' }}
      options={{ initialChainId: ARC_CHAIN_ID, enforceSupportedChains: false, hideNoWalletCTA: false }}>
      {children}
      <Toaster position="top-center" theme={theme} />
    </ConnectKitProvider>
  )
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MotionConfig reducedMotion="user">
            <ThemedShell>{children}</ThemedShell>
          </MotionConfig>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
