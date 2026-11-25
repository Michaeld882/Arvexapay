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
