# Transaction Guardian: stage reports

Final run: lint 0 errors, typecheck clean, production build OK. Every test file passes when run one at a time (the full suite in one process runs out of sandbox memory). One test fails in `tests/connect-flow.test.tsx` ("history request fails" retry). It failed the same way before any Guardian work.

## Stage 1: Guardian core and the shared transaction path
- Files: `src/guardian/{types,retry,lock,checks,preflight,state}.ts`, `src/components/GuardianStatus.tsx`, `src/hooks/useTxFlow.ts`, `src/components/TxDialog.tsx`, `src/hooks/useFeeEstimate.ts`.
- Checks: wallet connected, chain id, target contract allowlist (USDC, vault), exact calldata against the reviewed recipient and amount, spender and unlimited-approval rules, recipient validity (zero address, token, vault), token decimals read from the chain, USDC balance (wallet or vault), gas from the same USDC pool, fee against amount (warning), allowance, vault paused, pending transactions from the wallet, duplicate in flight (status read first), exact-call simulation (`eth_call`), RPC failure reported as retryable, never as a pass. Universal lock taken before any await. Submission registry holds real hashes only.
- Tests: `tests/guardian.test.ts` (29), `tests/guardian-ui.test.tsx` (5).
- Limitation: a wallet prompt that is never answered keeps the lock until it resolves or the page reloads.

## Stage 2: CCTP
- Files: `src/guardian/cctp.ts`, `src/circle/cctp.ts`, `src/circle/cctpFee.ts`, `src/circle/hooks.ts`, `src/pages/CircleBridge.tsx`.
- Checks: route and domains from Circle's registry, token, recipient, amount, source decimals, balance, gas on the source chain, fee below amount in 6-decimal base units (the "Max fee must be less than amount" rule), burn simulation when the approval already covers the amount, mint gas when not forwarded, pending nonces, duplicate protection. The check runs before the chain switch, approval and burn.
- Tests: `tests/guardian-cctp.test.ts` (19), `tests/cctp-fee.test.ts` (12), `tests/guardian-cctp-ui.test.tsx` (1).
- Limitation: before the approval is mined the burn cannot be simulated; the fee rule is still checked.

## Stage 3: Circle Gateway
- Files: `src/guardian/gateway.ts`, `src/pages/CircleGateway.tsx`.
- Checks: Gateway chain listing and wallet contract, Arc entry, forwarding support, token, decimals, balance (source chain or Gateway), gas, USDC fees below amount, Circle's estimate (a rejected estimate blocks), duplicate protection.
- Tests: `tests/guardian-gateway.test.ts` (13).
- Limitation: no simulate-only call and no published limits in the kit (see `docs/guardian.md`).

## Stage 4: Bridge
- Files: `src/guardian/bridge.ts`, `src/components/BridgeTracker.tsx`, `src/pages/CircleBridge.tsx`.
- Tracking: source transaction, bridge processing, destination transaction, destination confirmation, final verification. A stage is done only with its own proof and never ahead of an earlier stage.
- Tests: `tests/guardian-bridge.test.ts` (6).

## Stage 5: Swap
- Files: `src/guardian/swap.ts`, `src/lib/plan.ts`, `src/lib/swapPlan.ts`, `src/guardian/checks.ts`, `src/guardian/preflight.ts`.
- The Uniswap provider verifies against the live chain, so protection is on. Checks: verified router and Permit2 addresses, no native value, execute calldata and deadline, tokens, slippage maximum, minimum received, quote age (60 s), price impact, token balance, approvals (exact amount, Permit2 only, one-hour allowance), provider verification before signing.
- Correction made during this stage: the Stage 1 target and calldata allowlist would have blocked swaps and their approvals. It now reads a guard set by the swap plan builders.
- Tests: `tests/guardian-swap.test.ts` (16).

## Stage 6: Recovery
- Files: `src/guardian/recovery.ts`, `src/hooks/useRecovery.ts`, `src/components/RecoveryNotice.tsx`, `src/components/Layout.tsx`.
- After a reload: submitted transactions are read back by hash (CONFIRMED or FAILED), Gateway records with a hash are read back from their chain, a Gateway record with no hash is closed honestly, CCTP transfers are checked on Arc, and the identical transaction stays blocked while the first is pending. Read-only, one pass, then controlled polling (15 s growing to 2 min, at most 20 polls, paused in a hidden tab). Resuming a CCTP transfer still needs the user's click.
- Tests: `tests/guardian-recovery.test.ts` (7) and two reload tests in `tests/guardian-ui.test.tsx`.
