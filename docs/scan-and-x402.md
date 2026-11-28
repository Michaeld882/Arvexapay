# ScanFlow and API payments (x402)

## ScanFlow
- The camera opens only when you tap Start camera. The browser's QR detector is used when it exists (Android Chrome); the bundled jsQR decoder is used everywhere else (iPhone Safari, Firefox). Both run on the device.
- Cases handled: permission denied (also detected before asking when the browser already blocks it), no camera, camera in use, insecure page, stopped scan (the camera is released), leaving the tab (the camera is turned off).
- Fallbacks: choose a photo of a QR code, or paste an address, payment link or `ethereum:` request.
- What a code can be (`resolveScan` in `src/lib/paymentQr.ts`):
  - wallet address, `ethereum:` USDC request, `/send?to=` link: opens Send with the recipient and amount filled in. With an amount it opens the review screen directly.
  - Arvexa payment link (`/pay?to=`): opens Pay with its details (only known fields are carried over).
  - other `https://` link: offered as an API payment. Nothing is requested from it until you press Check price.
  - anything else (other networks, Bitcoin or Solana codes, WalletConnect, http links, links with credentials, random text): a specific message.
- The wallet is never asked to sign from the scan screen. Signing happens only after you confirm on the review screen.

## API payments (x402)
This is a separate feature from wallet payments: Payments > API Payments (`/payments/x402`).
- Protocol work is done by the official x402 libraries (`@x402/core`, `@x402/evm`). Arvexa pays with the standard x402 `exact` scheme: your wallet signs a USDC transfer authorization (EIP-3009, typed data, no gas) and the API's facilitator settles it on Arc.
- Accepted only when the API asks for exact USDC on Arc Mainnet with a valid payee, a price of at most 10 USDC, and no token approval step. Anything else is explained and not offered.
- After the signature, the authorization is checked against the price shown (payee, amount, payer) before it is sent. A payment is called settled only after the settlement transaction is found on Arc moving exactly that amount from you to the payee.
- Limits: the API must allow browser requests (CORS) and expose its payment headers. Only GET resources are supported. The app never holds keys; the wallet signs.

## Real test
`bun run test:x402` (see `scripts/x402-test.ts`) starts a real x402 seller with Circle's Facilitator on Arc Testnet and pays it with the same buyer code the app uses, then verifies the settlement on chain. It needs throwaway test keys funded with Arc Testnet USDC from the Circle faucet.
