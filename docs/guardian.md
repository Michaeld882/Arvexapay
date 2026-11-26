# Transaction Guardian

A safety layer that runs before, during and after every transaction Arvexa asks a wallet to sign. It only reads the chain. It never holds a key, never signs, never sends, and never changes the amount or the recipient.

## What it covers

| Flow | Where | Guardian |
| --- | --- | --- |
| Send, Pay link, split, request, Cash Out (wallet and vault), Top Up (vault), USDC approval | shared transaction screen (`src/hooks/useTxFlow.ts`) | pre-flight checks, exact-call simulation, lock, registry, receipt tracking |
| Swap and its two approvals | same screen, plans marked with a guard (`src/lib/swapPlan.ts`) | verified router and tokens, calldata, slippage, minimum received, quote age, price impact, provider verification |
| CCTP bridge | `src/circle/cctp.ts`, `src/pages/CircleBridge.tsx` | route and domains, token, fee below amount, balance, gas, burn simulation, duplicate protection, five-stage tracker |
| Circle Gateway top up and spend | `src/circle/gateway.ts`, `src/pages/CircleGateway.tsx` | route, token, balance, gas, USDC fees below amount, estimate, duplicate protection |
| Chain switching | `src/circle/sdk.ts` | not a transaction; unchanged |

## States

`VALIDATING, SIMULATING, READY, SIGNING, SUBMITTED, PENDING, CONFIRMED, VERIFIED` and the failures `USER_REJECTED, VALIDATION_FAILED, SIMULATION_FAILED, RPC_ERROR, REVERTED, TIMEOUT, VERIFICATION_FAILED`. They are derived from real facts only (a check result, a wallet hash, a receipt, verified logs).

CONFIRMED means a receipt succeeded. VERIFIED means the expected logs (or the destination mint) were read back and matched.

## Reads and retries

All reads go through `src/guardian/retry.ts`: identical reads share one request, answers are cached for a few seconds, a failed read is never cached, and only transient failures (timeout, unavailable, rate limited) are retried, at most three tries with exponential backoff and a longer wait after a rate limit. A transaction handed to a wallet is never retried. Its hash status is read first.

## Limitations

- The burn of a CCTP transfer is simulated by the Circle kit's own gas estimate, which runs the burn. Before the approval is mined the burn cannot succeed, so it is not simulated at that point. The fee rule (`maxFee` below the amount) does not depend on the approval and is always checked.
- The Circle kit has no simulate-only call for Gateway. A top up is checked by Circle's fee estimate (reported as an estimate, never as a simulation), balance, gas and route. No minimum or maximum amount is applied, because the kit publishes none. A spend is a signed message, not a transaction, so it is checked against the Gateway balance, route and fees.
- The kit does not publish minimum or maximum transfer amounts. The only limit checked is that fees charged in USDC must be lower than the amount.
- A direct transaction recovered after a reload is checked against the expected result that was stored when it was handed to the wallet. It is VERIFIED only if the receipt holds it, UNVERIFIED if the receipt succeeded without it, and CONFIRMED if nothing was stored to check against. CCTP is VERIFIED only by the Arc mint; a Gateway top up only when the transfer into the Gateway contract for the exact amount is in the receipt.
- A quote older than 60 seconds is not traded on: close the review and start it again.
