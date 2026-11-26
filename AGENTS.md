# Arvexa

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents and humans.

## What This App Does

Arvexa is a USDC wallet and payments app on Arc Mainnet (chain 5042): dashboard, send, receive, swap (disabled until a provider is configured), deposit, withdraw (personal vault in `contracts/Arvexa.sol`), activity, settings. Real chain data only; no mock balances, hashes or swaps.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind (CSS-variable tokens, light and dark via `<html data-theme>`)
- Web3: wagmi v2, viem, ConnectKit (injected wallets only)
- Contracts: Solidity ^0.8.24 (solc 0.8.28, cancun), Foundry, OpenZeppelin 5.6.1
- Tests: Foundry in `contracts/test`, app tests with `bun test` in `tests/` (happy-dom, real RPC reads, no signing)
- Chain: Arc Mainnet, Chain ID 5042, USDC 0x3600000000000000000000000000000000000000 (6 decimals, also the gas token)

## Key Files

- `src/chain.ts`: the ONLY place for chain ID, RPC, explorer, USDC, contract address (`VITE_ARVEXA_CONTRACT_ADDRESS`). Never define these elsewhere.
- `src/swap-config.ts`: swap provider registry (empty on purpose).
- `src/config.ts`: wagmi config (single transport: timeout, retries, batching).
- `src/lib/`: errors (friendly messages), rpc (client, receipt wait), queryClient (retry rules), plan (tx plans and receipt verification), activity (log classification), validate, txLog.
- `src/hooks/`: useTxFlow (state machine with duplicate-submit lock), useActivity (windowed log scans), useChainData, useBalances, useVault.
- `src/pages/`, `src/components/`: UI. Routing is in `src/lib/router.tsx`.
- `docs/deployment.md`, `docs/security-review.md`.

## Rules to keep

- On Arc the native balance and USDC are one pool: show a single USDC balance, never sum both views.
- A transaction is only "success" after receipt status plus the expected events are verified. Never show a hash that did not come from the wallet.
- Reads retry only transient RPC failures; never retry or resend a transaction. Measured: Arc RPC accepts 5,000-block getLogs ranges, rejects 10,000.
- Stock Foundry cannot execute Arc's USDC blocklist precompile, so token movement cannot be fork-tested locally.

## Deployed contracts

None yet. Mainnet deployment is done by the user from their own wallet (see `docs/deployment.md`). Record the address here after deployment.

## Intro screen

- `src/components/onboarding/` is the single intro/landing screen. `useAppGate` (`src/lib/onboarding.ts`) shows it whenever no wallet is connected, with no timer, no skip and nothing stored. Its Connect Wallet button opens the existing ConnectKit modal (same logic as `WalletButton`), and a connected wallet switches straight to the app. A restored session shows a blank moment, then the app. There is no separate connect page or second intro.
- The four cards are Send & Receive, Scan & Pay, Split Payment and Request Pay, as the owner specified. Only Send & Receive exists in this codebase; the other three have no screens here. Swap, Deposit, Withdraw and Bridge are mentioned in one line under the cards.
- `ArcMark` in `ArcHero.tsx` is a drawn stand-in, not Circle's official Arc artwork.

## Circle integration (`src/circle/`)

- `config.ts` is the only place Circle env vars are read (all public `VITE_`). Never put a Circle API key, entity secret or private key in browser code.
- `sdk.ts`: lazy `@circle-fin/app-kit` instance, route lists from Circle's own chain registry (CCTP and Gateway contract addresses are NOT duplicated in the repo), wallet adapter built from the connected wallet's provider.
- `cctp.ts`: native burn-and-mint into Arc (approve, burn, attestation, mint). Default mint is submitted by Circle's forwarding service. Transfers are saved per wallet and can be resumed after a reload; never re-run `bridge()` after a burn, use `retryTransfer`.
- `locks.ts`: module-level locks, so only one Circle transfer or Gateway operation runs at a time even across page changes. `findUnsettledDuplicate` blocks a second burn of the same amount from the same chain while an earlier one is unfinished.
- `arrival.ts`: reads Arc itself for proof of a mint. A transfer is `success` only after that proof; Circle saying done leaves it `confirming`, then `unconfirmed` if Arc does not show it. `verify.ts` + `bun run verify:circle` are the live configuration checks.
- `gateway.ts`: unified balance (read-only by address), deposit, spend to Arc. Always shown separately from the wallet and vault balance.
- `payments/`: rail interface. `arc-usdc` is active; `cpn` reports what it needs and has no `submit` until Circle grants access.
- Pages: `/circle`, `/circle/bridge`, `/circle/gateway`. Circle transfers and Gateway moves need a real wallet signature, so they are not testable end to end in the sandbox.

## Share links

- `getShareBase`, `buildShareLink` and `installShareSync` live in `src/lib/share.ts`; keep the `installShareSync()` call in `src/main.tsx`.
- Never put a secret in a URL path or query.

## To Run

```bash
bun install
bun run dev
```

## Notes (UI and RPC)
- `PageHeader` always renders a Back button (`goBack()` in `src/lib/router.tsx`; falls back to the Dashboard when the page was opened directly).
- The logo lives in `src/components/Logo.tsx` and `public/favicon.svg`.
- Loading: vault balance and allowance reads start as soon as an address is configured (in parallel with the contract check) but are only shown once the contract is verified. The first activity scan publishes interim results after each window (`partial` pages) instead of blocking on all four. The USDC balance is one shared query (`useWalletUsdc`); do not add a second read of it.
- `tests/logic.test.ts` and `tests/ui.test.tsx` still assume no swap provider is registered; those two tests fail since the Uniswap provider was added.
- Activity scans 5,000-block windows paced at about one per second: the public RPC rate limits `eth_getLogs` faster than that (measured). Do not parallelize or speed this up without re-measuring.

## Payment tools

- Saved addresses (`src/lib/contacts.ts`), notes and categories (`src/lib/txMeta.ts`) live in localStorage per connected wallet via `src/lib/ownerStore.ts`. They hold names, notes and categories only, never keys.
- `TxPlan.meta` carries a note/category; `useTxFlow` saves it against the real hash after the wallet submits. It is never part of the transaction.
- `TxStepper` maps the real flow phase to Preparing, Confirming, Submitted, Confirmed. Activity polls receipts every 8s while a local transaction is pending.
- `/scan` decodes QR codes with `jsqr` (camera or photo) and opens `/send?to=` with only valid values filled in. Receive shares a pay link built from `getShareBase()`.
- Insights (`src/lib/insights.ts`) count only confirmed Send and Receive items found in the scanned blocks. Do not add sample data.

## Payments platform

- All of it is local plus real Arc reads: no contract, no backend. Data lives in localStorage per wallet through `ownerStore` (`arvexa:requests:v1`, `splits`, `reminders`, `paidlinks`, `merchant`). Never store keys.
- `src/lib/payments/`: `requests` (request, link, invoice and split-share records), `links` (/pay URLs), `settle` (reads Arc for matching USDC transfers; verify by hash), `splits`, `reminders`, `ledger` (overview, categories, customers), `receipts`.
- A request is Paid only through `applySettlement`, from a real Transfer to the wallet with the exact amount at or after its creation block (a split share with a payer address also needs that sender). USDC has no memo, so same-amount requests are matched oldest first. Never add a manual "mark paid".
- `usePaymentSync` polls Arc every 15s only while something is pending. Reminders never send: Pay now opens `/send` prefilled and the reminder advances only after the receipt is confirmed (`useTxFlow` `onSuccess(plan, hash)`).
- `/pay` opens without a wallet (public shell in `App.tsx`) so a payer sees the details before connecting.

## Navigation

- Screens are code-split in `src/lib/pages.ts` (`PAGE_LOADERS`). `Link` starts downloading a screen on pointer-enter, press or focus; `navigate()` preloads too; `warmAllPages()` fetches the rest when the browser is idle after the app shows. Only code is preloaded, never blockchain data.
- `MainApp` uses `useDeferredValue(route)`: the tapped screen is highlighted at once, the previous page stays (dimmed, with a progress line) until the next one is ready, and `PageFallback` (Back button plus skeletons) shows only if nothing is on screen yet.
- `navigate()` ignores the current path+query so repeat taps never add history; scroll position is saved per history entry and restored on back. `ensureBackStack()` puts the Dashboard behind a directly opened page (not `/pay`) so the device back button does not leave the app.
- Every secondary page starts with `PageHeader` or `ModuleHero`, both of which render `BackButton`. New pages must do the same.
