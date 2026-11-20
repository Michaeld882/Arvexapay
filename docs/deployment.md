# Arvexa deployment guide (Arc Mainnet)

Arc Mainnet moves real USDC and transactions are irreversible. Arc Studio does not deploy to, sign for, or fund mainnet. You deploy and operate everything below yourself, from your own wallet. Rehearse on Arc Testnet first and get an independent professional audit before real funds are used.

## 1. Arc Mainnet configuration

| Setting | Value |
| --- | --- |
| Chain ID | 5042 |
| RPC | https://rpc.mainnet.arc.io |
| Explorer | https://explorer.arc.io |
| Gas token | USDC (same balance as ERC-20 USDC) |
| USDC | 0x3600000000000000000000000000000000000000 (6 decimals) |

These values live in one place: `src/chain.ts` (read from the generated `src/onchain-facts.ts`). The wagmi setup in `src/config.ts` and every page import from it.

## 2. Deploy `contracts/Arvexa.sol`

Prerequisites: Foundry, a funded deployer wallet on Arc Mainnet (USDC pays gas), and the address that will own the contract. Use a hardware wallet or multisig as owner. The owner can only pause deposits and rescue unsupported tokens; it can never move user USDC.

```bash
export ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io
export PRIVATE_KEY=<your deployer key>   # keep it in your shell only, never commit it

forge build

forge create contracts/Arvexa.sol:Arvexa \
  --rpc-url $ARC_MAINNET_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args 0x3600000000000000000000000000000000000000 <OWNER_ADDRESS>
```

Replace `<OWNER_ADDRESS>` with your real owner address. Prefer an encrypted keystore (`cast wallet import`, then `--account <name>`) over a raw key where possible.

Optional: note the deployment block for faster activity scans:

```bash
cast receipt <DEPLOY_TX_HASH> blockNumber --rpc-url $ARC_MAINNET_RPC_URL
```

## 3. Configure the app (the one place for the contract address)

Add to `.env` (see `.env.example`):

```
VITE_ARVEXA_CONTRACT_ADDRESS=0xYourDeployedArvexaAddress
VITE_ARVEXA_DEPLOY_BLOCK=<block number from step 2, optional>
```

Restart the dev server or rebuild (`bun run build`), because Vite reads env files at startup. The address is read only in `src/chain.ts`.

## 4. Verify the configuration

Run the read-only checks first (no keys, no transactions):

```bash
bun run verify:abi          # frontend ABI matches the compiled contract
bun run verify:deployment   # your deployed address on Arc Mainnet: code, USDC(), owner, solvency
```

Open Settings. The Arvexa contract section must read "Contract verified". The app checks, against Arc Mainnet, that:

- code exists at the address
- `USDC()` returns the official Arc USDC address

If either check fails, or the RPC cannot answer, vault actions (Deposit to vault, Withdraw) stay disabled. If the variable is empty the app still loads and shows "Contract not configured".

## 5. Swap provider (optional)

Swaps stay disabled ("Swap liquidity is not configured") until you register a verified provider in `src/swap-config.ts`. A provider supplies its tokens, a live quote function and a transaction builder. Verify its router address and routes on Arc Mainnet before adding it.

## 6. Hosting

The app is a static Vite build (`bun run build`, output in `dist/`) using path routes. Configure your host to serve `index.html` for unknown paths (SPA fallback). Set `VITE_*` variables in the host's build environment.

## 7. First real-money test (do this yourself)

Arc Studio cannot sign mainnet transactions. After steps 2 to 4, use a small amount from your own wallet:

1. Connect, confirm the header says Arc Mainnet, and open Deposit. Approve and deposit 1 USDC.
2. Wait for "Confirmed" and check the transaction on the Arc Explorer. The vault balance on the Dashboard should rise by 1 USDC.
3. Open Withdraw, withdraw 1 USDC to your wallet, and confirm the wallet balance rises (minus the network fee).
4. Run `bun run verify:deployment` again: it should still report the vault as solvent.
