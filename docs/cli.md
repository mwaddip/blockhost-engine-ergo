# CLI Tools

## bw (blockwallet)

Scriptable wallet operations for Ergo. Reads config from `web3-defaults.yaml` and addressbook from `addressbook.json`.

```bash
bw send <amount> <token> <from> <to>       # Send ERG or tokens between wallets
bw balance <role> [token]                   # Show wallet balances
bw split <amount> <token> <ratios> <from> <to1> <to2> ...  # Split tokens by ratio
bw withdraw <to>                            # Collect earned subscription payments
bw swap <amount> <from-token> erg <wallet>  # Swap tokens via DEX (stub)
bw who <identifier>                         # Query EIP-4 NFT holder
bw config stable [tokenId]                  # Get/set primary stablecoin
bw plan create <name> <price>               # Create subscription plan box
bw set encrypt <nft_id> <data>              # Update NFT reference box R5
bw --debug --cleanup <address>              # Sweep all testnet ERG to address
```

- **Token shortcuts**: `erg` (native nanoERG), `stable` (configured payment token), or 64-char hex token ID
- **Roles**: `admin`, `server`, `hot`, `dev`, `broker` (resolved from `addressbook.json`)
- **Signing**: Only roles with `keyfile` in the addressbook can be used as `<from>`/`<wallet>`
- **Amounts**: ERG amounts accept decimal notation (`1.5` = 1,500,000,000 nanoERG)

**bw who**

Query the holder of an EIP-4 NFT token.

```bash
bw who <token_id>    # Who holds this NFT?
bw who admin         # Who holds the admin NFT? (reads admin.credential_nft_id from blockhost.yaml)
```

Uses the explorer's `/boxes/byTokenId/{id}` endpoint. Prints the Base58 Ergo address of the current holder.

**bw set encrypt**

```bash
bw set encrypt <nft_id> <hex-encrypted-data>
```

Updates the R5 (userEncrypted) field of the reference box for the given NFT. Finds the reference box by matching R4 (Coll[Byte] containing the NFT token ID) at the server address. Creates a new box with the updated R5 register, preserving all other fields.

**bw withdraw**

```bash
bw withdraw server    # Collect to server address
bw withdraw hot       # Collect to hot wallet (used by fund manager)
```

Scans subscription boxes by ErgoTree, analyzes claimability based on block height intervals, and collects earned payments. Limited to one subscription box per transaction (guard script constraint).

**bw --debug --cleanup**

```bash
bw --debug --cleanup 3Wy6H5...
```

Debug utility. Sweeps ERG from all signing wallets back to a single address. Requires `--debug` flag as a safety guard. Skips wallets that are the target or have insufficient balance for fees.

The fund-manager imports `executeSend()`, `executeWithdraw()`, and `executeBalance()` from bw command modules directly — all wallet operations flow through the same code paths.

---

## ab (addressbook)

Manages wallet entries in `/etc/blockhost/addressbook.json`. No RPC or blockchain config required — purely local filesystem operations. All addresses are Ergo Base58.

```bash
ab add <name> <address>      # Add new entry
ab del <name>                # Delete entry
ab up <name> <address>       # Update entry's address
ab new <name>                # Generate new Ergo wallet, save key, add to addressbook
ab list                      # Show all entries
ab --init <admin> <server> [dev] [broker] <keyfile>  # Bootstrap addressbook
```

- **`ab new`**: Generates a BIP39 mnemonic via `bhcrypt`, derives secp256k1 key via EIP-3 path, saves raw hex key to `/etc/blockhost/<name>.key` (chmod 600), adds Base58 address to the addressbook
- **`ab up`**: Only changes the address; preserves existing `keyfile` if present
- **`ab del`**: Removes the JSON entry but does NOT delete the keyfile (if any)
- **`ab --init`**: Bootstrap addressbook for fresh installs. Positional args: admin address, server address, optionally dev and broker addresses, then server keyfile (always last). Fails if addressbook already has entries.

---

## is (identity predicate)

Yes/no identity questions via exit code. Exit 0 = yes, exit 1 = no.

```bash
is <wallet> <nft_id>         # Does wallet hold EIP-4 NFT token?
is contract <address>        # Does address have unspent boxes on-chain?
```

Arguments are order-independent, disambiguated by type:
- **Address**: Ergo Base58 (`9...` or `3...`)
- **NFT ID**: 64-char hex token ID
- **`contract`**: literal keyword

---

## bhcrypt

Encryption/decryption and key generation utility.

```bash
bhcrypt generate-mnemonic                    # Generate mnemonic + derive key + address (JSON)
bhcrypt derive-key <word1> <word2> ...       # Derive private key from mnemonic (JSON)
bhcrypt generate-keypair <outfile>           # Random secp256k1 key to file, print address
bhcrypt validate-mnemonic <word1> ...        # Validate BIP39 mnemonic
bhcrypt mnemonic-to-address <word1> ...      # Derive address from mnemonic
bhcrypt encrypt-ecies <pubkey-hex> <text>    # ECIES encrypt for server
bhcrypt decrypt-ecies <text>                 # Decrypt with server.key
bhcrypt encrypt-sym <key-hex> <text>         # SHAKE256 + AES-256-GCM encrypt
bhcrypt decrypt-sym <key-hex> <ciphertext>   # Symmetric decrypt
```

Key derivation uses BIP32 secp256k1 with EIP-3 path `m/44'/429'/0'/0/0`.

The ECIES path uses secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM. Wire format: `ephemeralPub(65) + IV(12) + ciphertext+tag`. Implemented in `src/crypto.ts`.

`generate-mnemonic` outputs JSON: `{ mnemonic, privateKey, address }`.
`derive-key` outputs JSON: `{ privateKey, address }`.
