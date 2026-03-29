# Reconciler

Runs periodically as part of the monitor polling loop (every 5 minutes in production, 2 minutes in testing mode). Ensures local state (`vms.json` via the Python `vm_db`) matches on-chain NFT ownership.

## NFT Ownership Scan

For every active or suspended VM that has a minted NFT, the reconciler:

1. Queries the explorer for the current holder of the EIP-4 NFT token via `findNftHolder()` (`src/nft/reference.ts`)
2. Compares the on-chain holder against the locally stored `owner_wallet`
3. On transfer detection: updates the VM record and propagates the change to the VM's GECOS field

The holder lookup uses the explorer's `/boxes/byTokenId/{id}` endpoint, filtering for unspent boxes and deriving the holder address from the box's ErgoTree.

## Ownership Transfer Detection

When the on-chain holder differs from `owner_wallet`:

1. Updates `wallet_address` and sets `gecos_synced = false` in the Python `vm_db`
2. Calls the provisioner's `update-gecos` command to update the VM's GECOS field (`wallet=<addr>,nft=<id>`)
3. On success: sets `gecos_synced = true`

If `update-gecos` fails (VM stopped, QEMU guest agent unresponsive), `gecos_synced` stays `false`. On the next reconcile cycle, the ownership comparison matches (local was already updated), but the persisted `gecos_synced === false` flag triggers a retry of the GECOS write.

This is the sole mechanism by which VMs learn about NFT ownership changes after provisioning. The PAM module authenticates against the VM's GECOS field, not the blockchain directly.

**Provisioner Command**

```
getCommand("update-gecos") <vm-name> <wallet-address> --nft-id <token_id>
```

Exit 0 = GECOS updated. Exit 1 = failed (retried next cycle).

## NFT Minting Check

For VMs where `nft_minted` is `false`, the reconciler checks whether the token is already on-chain (e.g. after a monitor restart or a minting race). If the token exists on-chain, it marks `nft_minted = true` locally and updates GECOS if needed.

If the token is not found on-chain and `nft_minted` is `false`, a warning is logged for operator attention — this indicates a minting failure in the pipeline.

## Concurrency Guard

A `reconcileInProgress` flag prevents concurrent runs. If the reconciler is triggered while a previous run is still in progress, the new invocation returns immediately.

## Retry Logic

Failed GECOS updates are retried every reconcile cycle until they succeed. The `gecos_synced` flag in `vms.json` persists across monitor restarts.

Explorer query errors for individual VMs are logged and counted but do not abort the rest of the reconcile pass.

## Explorer Dependency

The reconciler depends on the testnet/mainnet explorer API. Known limitations:
- `getBoxesByTokenId` uses the `/boxes/byTokenId/{id}` endpoint (returns both spent and unspent, filtered client-side) because the `/unspent` variant returns 404 on testnet
- Explorer can lag a few blocks behind, so very recent transfers may not be detected immediately
