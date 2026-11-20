# Arvexa security, RPC and test review

Scope: `contracts/Arvexa.sol` and the Arvexa web app. Arc Studio's review is best-effort and is not a substitute for an independent professional audit before real funds are used.

## Contract summary

`Arvexa` is a non-custodial USDC vault. Users deposit USDC into a personal balance and withdraw it to any address. Sending, receiving and swapping use plain USDC transfers outside the contract.

- Solidity `^0.8.24`, OpenZeppelin `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`. 130 lines. No proxy, no fees, no upgradeability.
- Owner powers: pause and unpause deposits, and rescue ERC-20 tokens other than USDC. The owner cannot move, freeze or reduce any user balance, and `renounceOwnership` is disabled.
- Pause blocks deposits only. Withdrawals always work, so a pause can never trap user funds.
- No `receive` or `fallback`: ordinary native transfers revert.
- Checks-effects-interactions plus `nonReentrant`. Deposits verify the exact USDC amount received.

## Review results

| Check | Result |
| --- | --- |
| Rule-corpus review, maximum depth, target chain 5042 | No material findings |
| Functional and adversarial review, maximum depth | No material findings |
| Slither (full detector set) | 1 informational (naming style of `USDC`), no High or Medium |
| Foundry unit, fuzz and invariant tests | 62 passed (256 fuzz runs, 3 invariants x 128,000 calls) |
| Arc Mainnet fork checks (read only) | 2 passed: USDC is 6 decimals, vault constructs against the real token |

Covered by tests: reentrancy via a malicious token, fee-on-transfer token rejection, owner cannot take user USDC, USDC rescue forbidden, two-step ownership, pause semantics, zero address and no-code constructor checks, native transfers revert, accounting invariants (`totalDeposits` equals the sum of balances, vault USDC covers `totalDeposits`).

## Known limits and assumptions (read before mainnet)

- Direct USDC transfers to the vault are not credited to anyone and cannot be rescued, including surplus. Force-sent native value cannot be blocked or recovered.
- Arc's USDC calls a chain-level blocklist precompile. If the vault address were blocklisted by the token issuer, deposits and withdrawals would fail. This is an external token risk.
- Stock Foundry cannot execute that precompile, so deposit and withdraw with the real USDC cannot be simulated on a local fork. Rehearse the full flow on Arc Testnet (same USDC address) before mainnet.
- The owner can pause deposits (not withdrawals). Use a multisig or hardware wallet as owner.

## RPC reliability audit

Measured against the real Arc Mainnet RPC (`bun run test:rpc`):

- Chain ID 5042, USDC has 6 decimals and symbol USDC.
- `eth_getLogs`: 1,000 and 5,000 block ranges are accepted; 10,000 is rejected with "requested range too large". Activity scans start at 5,000 blocks and halve on a range error.
- Ten identical same-tick reads are merged into one HTTP request by JSON-RPC batching.
- Loading the dashboard for a real wallet took between 7 and 16 HTTP requests in total, then traffic stopped.

Design rules implemented:

| Concern | Implementation |
| --- | --- |
| One RPC client | wagmi transport only, with 10 s timeout, 2 transport retries, JSON-RPC batching |
| Duplicate requests | TanStack Query keys dedupe in-flight and cached reads; 30 s default stale time |
| Polling | Only wallet and vault balances refresh, every 60 s, and not in background tabs. No block polling. Activity and fee reads are on demand |
| Retries | Reads retry only transient failures (timeout, 429, 5xx, network) at most 2 times with exponential backoff and jitter. Reverts and wallet rejections never retry. Transactions are never resent |
| Receipt waiting | Own loop with a 3 minute budget that survives temporary RPC errors. A timeout shows "not confirmed yet, do not send again" with a Check again button, never "failed" |
| Race conditions | A synchronous lock prevents duplicate submissions. Leaving a page cancels its running activity scan |
| Stale state | After a verified transaction, balances, allowance and activity are refetched once |
| Failures | A failed read shows an error with Try again. No fake or zero balance is ever shown |
| Activity scan | Sequential 5,000-block windows paced at about one per second (measured: the public RPC rate limits `eth_getLogs` faster than that, 8 of 8 windows failed at 0 ms spacing and none at 1,000 ms), per-window retry, partial results kept, adaptive window size |
| Pending transactions | A transaction left "pending" locally (page closed before its receipt) is settled once per session by reading its receipt |

Known limitation: activity history is read straight from RPC logs, so depth is bounded (20,000 blocks, roughly 2.8 hours, on first load, then 40,000 blocks, roughly 5.6 hours, per "Load older activity"). Arc Mainnet blocks are about half a second apart. For full-history browsing, add an indexer or explorer API later.

## Application test results

`bun run test` runs 30 tests: 19 logic tests (amount and address validation, USDC formatting, error classification, retry and backoff rules, activity classification, receipt verification, swap-not-configured) and 11 interaction tests using a browser-wallet stand-in. The stand-in never returns a transaction hash, so no test can fake a successful transaction.

Interaction tests cover: disconnected state, wrong network banner and switch action, real balance display, validation, confirmation with a real fee estimate, wallet rejection, double-click protection (exactly one wallet request), unconfigured swap/deposit/withdraw states, receive address with QR and copy, theme switch and persistence, a dead RPC (clear error, bounded retries, recovery), request budget, and live activity.

Not covered by automated tests (needs a funded wallet and real money): a fully confirmed send, deposit or withdraw through a real wallet, and the swap path with a live provider. These were verified at the unit level (receipt verification) only.
