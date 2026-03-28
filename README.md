# Blockhost Engine (Ergo)

UTXO-native VM hosting subscription system on Ergo. Subscribers lock funds at a guard script address with beacon tokens for discoverability. No shared contract state, no custody transfer — subscribers retain control of their funds until the service collects earned payment at configurable intervals.

## How It Works

1. **User visits signup page** — Connects Nautilus wallet (EIP-12), selects plan, pays
2. **Subscription box created** — Funds locked at guard script address with beacon token + register state
3. **Monitor detects beacon** — Scans for boxes matching subscription ErgoTree, triggers VM provisioning
4. **VM is created** — With web3-only SSH authentication (no passwords, no keys)
5. **NFT is minted** — EIP-4 credential with encrypted connection details in registers
6. **User authenticates** — Signs with Ergo wallet on VM's signing page, PAM plugin verifies

## Architecture

```
+-------------------+     +------------------+     +------------------+
|   Signup Page     |---->|  Subscription    |---->|  Monitor Svc     |
|   (static HTML)   |     |  Guard (ErgoScript)|   |  (TypeScript)    |
+-------------------+     +------------------+     +--------+---------+
                                                            |
                                                            v
+-------------------+     +------------------+     +------------------+
|   User's VM       |<----|  Provisioner     |<----|  Engine          |
|   (PAM plugin)    |     |  (pluggable)     |     |  (manifest)      |
+-------------------+     +------------------+     +------------------+
```

Key characteristics:
- **Per-subscriber boxes** with beacon tokens for discoverability
- **ErgoScript guard script** with 4 spending paths (collect, cancel, extend, migrate)
- **Interval-based collection** — service claims earned payment periodically, not all at once
- **Fair cancellation** — guard script enforces earned/refund split
- **Pure JS stack** — Fleet SDK + Ergo Node API, zero WASM dependencies
- **Node-delegated signing** — server-side tx signing via Ergo node `/wallet/transaction/sign`

## Components

| Component | Language | Description |
|-----------|----------|-------------|
| `src/ergo/contracts.ts` | TypeScript | ErgoScript subscription guard (4 spending paths) |
| `src/ergo/provider.ts` | TypeScript | Ergo Node + Explorer API client |
| `src/ergo/registers.ts` | TypeScript | Sigma serialization for box registers |
| `src/ergo/address.ts` | TypeScript | Ergo address validation and encoding |
| `src/monitor/` | TypeScript | Subscription box scanner |
| `src/handlers/` | TypeScript | Subscription lifecycle handlers (provision, extend, cancel) |
| `src/admin/` | TypeScript | On-chain admin commands via box registers |
| `src/reconcile/` | TypeScript | NFT ownership reconciliation and GECOS sync |
| `src/fund-manager/` | TypeScript | Subscription collection and revenue distribution |
| `src/bw/` | TypeScript | blockwallet CLI (send, balance, withdraw, plan, who, set) |
| `src/ab/` | TypeScript | Addressbook CLI |
| `src/is/` | TypeScript | Identity predicate CLI |
| `src/bhcrypt.ts` | TypeScript | Crypto tool (keypair gen, ECIES, symmetric, BIP32 keygen) |
| `src/root-agent/` | TypeScript | Root agent client (privilege separation) |
| `blockhost/engine_ergo/` | Python | Installer wizard plugin |
| `scripts/` | TS/Bash/Python | Deployment, minting, signup page generation |

## On-chain Components (ErgoScript)

A single parameterized guard script compiled via the Ergo node, with 4 spending paths:

- **ServiceCollect** — Interval-based partial collection, capped at expiry. Server signs, continuing box with updated registers.
- **SubscriberCancel** — Fair split of earned/refund. Subscriber signs, beacon burned.
- **SubscriberExtend** — Top up funds or extend expiry. Subscriber signs, immutable fields preserved.
- **Migrate** — Upgrade to new contract version. Server signs, funds move to different script.

Subscription state stored in box registers:
- **R4**: `(Int, Coll[Byte])` — plan ID + subscriber ErgoTree
- **R5**: `(Long, (Long, Long))` — amount remaining + (rate per interval, interval ms)
- **R6**: `(Long, Long)` — last collected + expiry (POSIX ms)
- **R7**: `Coll[Byte]` — payment token ID (empty for native ERG)
- **R8**: `Coll[Byte]` — ECIES-encrypted user data
- **R2** (tokens): beacon token (unique per subscription, ID = first input box ID)

## Authentication

Authentication is handled by **libpam-web3** and its chain-specific plugins (separate repos). The engine's only role in auth is storing `userEncrypted` in the subscription box registers and minting the EIP-4 NFT credential to the subscriber.

## Prerequisites

- Node.js 22+
- Python 3.10+
- Ergo node (for ErgoScript compilation and transaction signing)
- `blockhost-common` package
- A provisioner package (e.g. `blockhost-provisioner-proxmox`)

## Development Setup

```bash
git clone https://github.com/mwaddip/blockhost-engine-ergo.git
cd blockhost-engine-ergo
npm install
```

```bash
npx tsc --noEmit          # Type-check TypeScript
```

Packaging (produces `.deb` for host):

```bash
./packaging/build.sh
```

## Project Structure

```
blockhost-engine-ergo/
├── src/
│   ├── ergo/                          # Ergo blockchain layer
│   │   ├── provider.ts                # Node + Explorer API client
│   │   ├── address.ts                 # Address validation, encoding, derivation
│   │   ├── contracts.ts               # ErgoScript guard scripts + compilation
│   │   ├── registers.ts               # Sigma serialization for box registers
│   │   └── types.ts                   # SubscriptionState, ErgoBox, etc.
│   ├── monitor/                       # Subscription box scanner
│   ├── handlers/                      # Subscription lifecycle handlers
│   ├── admin/                         # On-chain admin commands
│   ├── reconcile/                     # NFT ownership reconciliation
│   ├── fund-manager/                  # Collection & distribution
│   ├── bw/                            # blockwallet CLI
│   ├── ab/                            # addressbook CLI
│   ├── is/                            # identity predicate CLI
│   ├── nft/                           # EIP-4 NFT minting + holder lookup
│   ├── crypto.ts                      # ECIES + SHAKE256 symmetric
│   ├── bhcrypt.ts                     # Crypto tool CLI
│   ├── provisioner.ts                 # Provisioner manifest reader
│   ├── paths.ts                       # Shared path constants
│   └── root-agent/                    # Root agent client
├── scripts/                           # Deployment & utility scripts
│   ├── deploy-contracts.ts            # ErgoScript compilation + config write
│   ├── mint_nft.ts                    # EIP-4 NFT minting
│   ├── keygen.ts                      # Ergo wallet generation (BIP32 + EIP-3)
│   ├── generate-signup-page           # Signup page renderer
│   ├── signup-template.html           # Signup page HTML template
│   └── signup-engine.js               # Browser-side subscription tx builder
├── blockhost/engine_ergo/             # Installer wizard plugin
│   ├── wizard.py                      # Flask blueprint + finalization steps
│   └── templates/engine_ergo/         # Wizard page templates
├── engine.json                        # Engine manifest
├── packaging/                         # .deb build script
├── root-agent-actions/                # Root agent wallet plugin
├── examples/                          # Systemd units
└── facts/                             # Interface contracts (submodule)
```

## Dependencies

Runtime (all pure JS, zero WASM):
- `@fleet-sdk/core` — Transaction building
- `@fleet-sdk/common`, `@fleet-sdk/crypto`, `@fleet-sdk/serializer` — Supporting Fleet SDK packages
- `@noble/curves`, `@noble/hashes` — Cryptographic primitives (secp256k1, ECIES, SHAKE256)
- `@scure/bip32`, `@scure/bip39` — HD key derivation (BIP32 secp256k1, EIP-3 path)
- `js-yaml` — YAML config parsing

## License

MIT

## Related Packages

- `blockhost-common` — Shared configuration and Python modules
- `blockhost-provisioner-proxmox` — VM provisioning (Proxmox)
- `blockhost-provisioner-libvirt` — VM provisioning (libvirt/KVM)
- `libpam-web3` — PAM module + chain-specific auth plugins (installed on VMs)
