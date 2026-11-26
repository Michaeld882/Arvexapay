# Guardian production hardening

## 1. Recovered work is VERIFIED only with proof
- CONFIRMED: the chain confirmed the transaction. VERIFIED: the expected result was read back and matched. UNVERIFIED: confirmed, but the expected result is not in the receipt.
- Direct transactions store what the receipt must contain (`src/guardian/expect.ts`) when they are handed to the wallet. After a reload `recoverSubmissions` reads the receipt (read-only) and compares. No stored expectation means CONFIRMED, never VERIFIED.
- Gateway: a top up carries `verified` only when the receipt holds the USDC transfer from the owner into the Gateway contract for the exact amount. A spend is verified by the Arc mint. Older records have no `verified` and show "Confirmed, result not verified".
- CCTP: VERIFIED needs the Arc mint hash. New transfers also store the least the mint can credit (amount minus the checked maxFee), so an unrelated small mint cannot verify a transfer found by search.
- The notice after a reload lists recovered items with their real outcome.

## 2. connect-flow "history request fails" test
Pre-existing and unrelated to the Guardian: it fails the same way on the untouched repository and passes when run alone. Root cause: the first test in the file installs a `fetch` that never answers. viem keeps one shared in-flight promise per read (for example the block number), so that request stays joined by every later test in the same process and the history read in the third test never settles. The fix is test-only: unanswered requests are failed when each test ends. No app code changed for it.

## 3. Gateway
The Gateway check is reported as "Fee estimate" with `simulated: false`, and the screen says "Estimated, not simulated". No minimum or maximum amount is applied.

## 4. CCTP
The fee rule runs before the chain switch, approval and burn. If the fee cannot be quoted the transfer is blocked, not guessed. The burn is only shown as simulated when the kit returned a burn estimate. The amount is never changed.

## 5. Safety audit (tests/guardian-hardening.test.tsx, tests/guardian-recovery-ui.test.tsx)
- Retry wrappers contain no signing or submitting call; signing calls exist only in `useTxFlow`, `cctp.ts` and `gateway.ts`.
- No transaction hash is hard-coded in `src`.
- Wallet rejection has its own state and never counts as a blockchain failure.
- After a reload a running CCTP transfer and a Gateway request are restored by reads only, with zero wallet writes.
