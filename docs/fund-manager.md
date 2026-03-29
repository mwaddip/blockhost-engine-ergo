# Fund Manager

Integrated into the monitor polling loop. Automates collection of earned subscription payments and distribution of collected funds.

## Fund Cycle (every 24h, configurable)

1. **Withdrawal** — Collect earned payments from claimable subscription boxes. Each box is processed in a separate transaction (guard script checks OUTPUTS(0) for the continuing box). Collected ERG flows to the hot wallet.
2. **Hot wallet ERG** — Server sends ERG to hot wallet if below `hot_wallet_gas_nanoerg` threshold. Server must retain a 20 ERG reserve.
3. **Server stablecoin buffer** — Hot wallet sends stablecoin tokens to server if below `server_stablecoin_buffer_nanoerg` threshold.
4. **Revenue shares** — If enabled in `revenue-share.json`, distribute configured basis points from hot wallet to dev/broker.
5. **Remainder to admin** — Send all remaining hot wallet ERG to admin.

The fund cycle is skipped (deferred) if a provisioner `create` command is detected running (`pgrep -f <create_cmd>`), to avoid balance race conditions during VM provisioning.

In testing mode, only step 1 (withdrawal) runs. Steps 2-5 are skipped to preserve deployer ERG.

## Withdrawal

Collection is per-box on Ergo. The guard script checks `OUTPUTS(0)` for the continuing box, so only one subscription box can be processed per transaction.

The fund manager queries subscription boxes by ErgoTree via the explorer, analyzes each for claimability:

- `intervals = floor((effectiveHeight - lastCollectedHeight) / intervalBlocks)`
- `collectAmount = min(intervals * ratePerInterval, amountRemaining)`
- `effectiveHeight = min(currentHeight, expiryHeight)` — capped at expiry

For partially consumed subscriptions, the transaction creates a continuing box at OUTPUTS(0) with updated `amountRemaining` and `lastCollectedHeight`, preserving the beacon token.

For fully consumed subscriptions, the beacon token is burned. A dummy OUTPUTS(0) with valid register types is created to satisfy the guard script's eager evaluation of `OUTPUTS(0).R4/R5/R6.get`.

Signing is via ergo-relay (`POST /wallet/transaction/sign`), submission tries multiple endpoints in order: submit_url, ergo-relay P2P broadcast, explorer mempool, local node.

## Distribution

All monetary values are in **nanoERG** (1 ERG = 1,000,000,000 nanoERG). Token amounts are in their respective base units.

Implemented in `src/fund-manager/distribution.ts`:
- `topUpHotWalletGas(book, config)` — top up hot wallet ERG from server
- `topUpServerStablecoinBuffer(book, config)` — top up server stablecoin from hot wallet
- `distributeRevenueShares(book, revenueConfig)` — send shares to dev/broker by basis points
- `sendRemainderToAdmin(book)` — sweep remaining hot wallet balances to admin

All transfers use `executeSend()` from `src/bw/commands/send.ts` — no inline transfer code.

## Hot Wallet

Auto-generated on first fund cycle if not in the addressbook. If a root agent is available, wallet generation is delegated there. Otherwise, the fund manager checks for an existing `/etc/blockhost/hot.key` and derives the address from it.

The hot wallet uses a raw secp256k1 private key (64-char hex), not a mnemonic. The address is a P2PK Ergo address derived from the key.

## Configuration

In `/etc/blockhost/blockhost.yaml` under the `fund_manager:` key:

| Setting | Default | Description |
|---------|---------|-------------|
| `fund_cycle_interval_hours` | 24 | Hours between fund cycles |
| `gas_check_interval_minutes` | 30 | Minutes between gas balance checks |
| `min_withdrawal_nanoerg` | 50,000,000,000 | Minimum nanoERG at guard before collection triggers |
| `gas_low_threshold_nanoerg` | 5,000,000,000 | Server nanoERG balance that triggers a warning |
| `gas_swap_amount_nanoerg` | 20,000,000,000 | Target swap amount (stub) |
| `hot_wallet_gas_nanoerg` | 1,000,000,000 | Target nanoERG balance for hot wallet |
| `server_stablecoin_buffer_nanoerg` | 50,000,000,000 | Target stablecoin balance (token base units) for server |
