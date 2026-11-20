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
- Activity scans 5,000-block windows paced at about one per second: the public RPC rate limits `eth_getLogs` faster than that (measured). Do not parallelize or speed this up without re-measuring.
