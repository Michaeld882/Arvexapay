/**
 * Test environment: a DOM (happy-dom) for component tests. The real network fetch is kept,
 * so reads in tests hit the real Arc Mainnet RPC. No transaction is ever signed or sent.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const nativeFetch = globalThis.fetch
GlobalRegistrator.register({ url: 'http://localhost:5173/', width: 390, height: 844 })
globalThis.fetch = nativeFetch
window.fetch = nativeFetch

// happy-dom cannot cancel Web Animations cleanly; let framer-motion use its JS animator in tests.
delete (Element.prototype as { animate?: unknown }).animate
