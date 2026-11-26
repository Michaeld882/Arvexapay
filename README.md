# Arvexa

A USDC wallet and payments app for Arc Mainnet. Connect a browser wallet to see your balance, send and receive USDC, keep USDC in a personal vault, withdraw it, and review your onchain activity. Everything shown comes from the real chain; nothing is simulated.

Built with [Arc Studio](https://studio.arc.io)

## Features

- Saved addresses with names (add, edit, delete, copy, pick when sending), kept on your device
- Optional note and category on each payment, saved on your device with the transaction hash (never sent onchain)
- Live four-step status for every transaction: Preparing, Confirming, Submitted, Confirmed
- ScanFlow: scan a wallet or payment QR code with your camera (or a photo), then review the payment in Send
- Payment insights, a wallet activity timeline and a shareable payment profile on Receive, all from real onchain data
- Payments hub: payment requests, shareable payment links, invoices, split bills, PayHub (full-screen QR), receipts, customer history, recurring reminders and contacts. A request, link, invoice or split share turns Paid only when the real USDC payment is found on Arc Mainnet
- Public pay page: opening a payment link shows the details and lets the payer connect and pay
- Dashboard order: balance, quick actions, payment overview, pending requests and upcoming payments, recent activity, insights
- One animated intro screen for every disconnected visitor: what Arc is and how the main payment features work, with the Connect Wallet button on it. Connecting opens the wallet modal and goes straight into the app
- Dashboard with wallet balance, vault balance, quick actions and recent transactions
- Send, Receive (address and QR code), Top Up, Cash Out and Activity
- Circle Integration area: USDC on Arc status, native CCTP bridging into Arc from other chains, a Gateway unified USDC balance (kept separate from wallet and vault balances), and payment rails with payment tracking
- Swap screen that stays disabled ("Swap liquidity is not configured") until a verified provider is registered
- Light and dark themes that persist after refresh
- Clear wrong-network warning with a switch action; transactions are blocked off Arc Mainnet (Chain ID 5042)
- Every transaction is checked before sending, confirmed on a review screen, and only marked successful after the receipt and expected onchain events are verified

## Tech stack

React 18, Vite, TypeScript, Tailwind CSS, wagmi, viem, ConnectKit. Contract: Solidity with OpenZeppelin and Foundry.

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
bun run dev        # start the app
bun run build      # production build
bun run check      # lint and typecheck
bun run test       # app tests (uses the real Arc Mainnet RPC and Circle services, read only)
bun run test:rpc   # RPC smoke test
bun run verify:abi         # frontend ABI vs compiled contract
bun run verify:deployment  # read-only check of the deployed contract on Arc Mainnet
bun run verify:circle      # read-only check of USDC on Arc, CCTP and Gateway against Arc Mainnet and Circle
bun run contracts:build
bun run contracts:test
```

The app is a static build with path routes. Host it with a fallback that serves `index.html` for unknown paths.

### Environment variables

Copy `.env.example` to `.env`. All values are public and shipped to the browser.

- `VITE_ARVEXA_CONTRACT_ADDRESS`: address of the deployed Arvexa contract. Leave empty until deployed; the app shows "Contract not configured" and disables the vault.
- `VITE_ARVEXA_DEPLOY_BLOCK`: optional block the contract was deployed at.
- `VITE_ARC_RPC_URL`: optional https RPC override for Arc Mainnet.
- `VITE_CIRCLE_CCTP_ENABLED`, `VITE_CIRCLE_GATEWAY_ENABLED`: optional, turn CCTP bridging or Gateway on or off (default on).
- `VITE_CIRCLE_CCTP_SPEED`: optional, `FAST` (default) or `SLOW`.
- `VITE_CIRCLE_CCTP_FORWARDER`: optional, let Circle submit the mint on Arc so no Arc gas is needed (default on).
- `VITE_CIRCLE_CCTP_SOURCE_CHAINS`: optional comma list of allowed source chains.
- `VITE_CIRCLE_LARGE_TRANSFER_USDC`: optional large-transfer warning threshold (default 100).
- `VITE_CPN_API_URL`: optional https URL of your own server for Circle Payments Network. Needs approved access from Circle.

Restart the dev server after changing `.env`.

## Contract and deployment

The contract is `contracts/Arvexa.sol`. See [docs/deployment.md](docs/deployment.md) for deployment steps and [docs/security-review.md](docs/security-review.md) for the review, test and RPC results.

Arc Mainnet moves real funds and transactions are irreversible. Test on Arc Testnet and get an independent audit before using real funds.
