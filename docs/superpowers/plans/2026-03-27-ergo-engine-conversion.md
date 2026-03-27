# Cardano-to-Ergo Engine Conversion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert blockhost-engine-cardano into blockhost-engine-ergo — a fully functional Ergo blockchain engine satisfying the ENGINE_INTERFACE contract.

**Architecture:** Cannibalize the Cardano engine, replacing chain-specific layers (cmttk/Koios/Aiken/CIP-30/CIP-68/bech32) with Ergo equivalents (Fleet SDK/Ergo Node API/ErgoScript/EIP-12/EIP-4/Base58). Ergo's eUTXO model maps naturally to Cardano's — subscription state lives in box registers (R4-R9) instead of inline datums, beacon tokens use the Token ID Rule (token ID = first input box ID), and NFTs follow EIP-4. The ECIES crypto layer (secp256k1) is chain-agnostic and stays as-is. Ergo also uses secp256k1 natively, so key operations align without curve translation.

**Tech Stack:** TypeScript, Fleet SDK (`@fleet-sdk/core`, `@fleet-sdk/common`, `@fleet-sdk/crypto`, `@fleet-sdk/compiler`), `@scure/bip32` (HD key derivation), Ergo Node REST API (including `/wallet/transaction/sign` for server-side signing — no WASM), Ergo Explorer API, ErgoScript (guard scripts), esbuild, Python 3 (wizard plugin). Browser-side signing via Nautilus EIP-12 (`ergo.sign_tx()`). **No `ergo-lib-wasm-nodejs`** — signing is delegated to the Ergo node API (server) and Nautilus wallet (browser).

**Reference Documents:**
- `facts/ENGINE_INTERFACE.md` — the contract this engine must satisfy
- `facts/NFT_CONTRACT_INTERFACE.md` — NFT credential spec
- `CONVERSION_NOTES.md` — Cardano session's mapping of chain-specific components
- `facts/SPECIAL.md` — S.P.E.C.I.A.L. bias profiles for engine components

**Ergo Knowledge Base MCP:** Use `ergo-code` MCP tools (`search_docs`, `get_concept`, `get_skill`, `get_pattern`, `get_ergoscript_ref`) to look up Ergo-specific APIs, ErgoScript syntax, Fleet SDK patterns, and ecosystem conventions when implementing any chain-specific code.

**S.P.E.C.I.A.L. Profiles:** Apply the engine profiles from `facts/SPECIAL.md` when working on each component. Key callouts: root-agent client (P10), fund-manager (L9), bw wallet ops (S8 P7), auth-svc (P9), bhcrypt (P9 A8).

---

## File Structure

### Files to Copy As-Is (chain-agnostic)

| Source (cardano) | Destination (ergo) | Purpose |
|------------------|-------------------|---------|
| `src/crypto.ts` | `src/crypto.ts` | ECIES + AES-GCM (secp256k1, not Ed25519) |
| `src/provisioner.ts` | `src/provisioner.ts` | Provisioner manifest discovery |
| `src/root-agent/client.ts` | `src/root-agent/client.ts` | Unix socket IPC to root agent daemon |
| `src/fund-manager/state.ts` | `src/fund-manager/state.ts` | Fund cycle state persistence |
| `src/fund-manager/types.ts` | `src/fund-manager/types.ts` | Addressbook/state type defs |
| `src/admin/types.ts` | `src/admin/types.ts` | Admin command type defs |
| `src/admin/handlers/knock.ts` | `src/admin/handlers/knock.ts` | Firewall knock handler |
| `src/ab/commands/new.ts` | `src/ab/commands/new.ts` | Generate wallet via root agent |
| `src/ab/commands/list.ts` | `src/ab/commands/list.ts` | List addressbook entries |
| `examples/blockhost-monitor.service` | `examples/blockhost-monitor.service` | Systemd unit template |
| `tsconfig.json` | `tsconfig.json` | TypeScript config |

### Files to Create or Substantially Rewrite

| File | Purpose | Derived From |
|------|---------|-------------|
| `engine.json` | Ergo engine manifest | Cardano `engine.json` (rename + new constraints) |
| `package.json` | Ergo deps (Fleet SDK, ergo-lib-wasm) | Cardano `package.json` (replace deps) |
| `src/paths.ts` | Path constants (remove Plutus paths, add Ergo paths) | Cardano `src/paths.ts` |
| `src/ergo/types.ts` | Ergo subscription/NFT types (registers, box model) | Cardano `src/cardano/types.ts` |
| `src/ergo/provider.ts` | Ergo Node/Explorer API client | New — replaces cmttk `getProvider` |
| `src/ergo/address.ts` | Address validation, encoding, derivation | New — replaces bech32/cmttk |
| `src/ergo/contracts.ts` | ErgoScript guard scripts (compiled ErgoTree hex) | New — replaces Aiken validators |
| `src/ergo/registers.ts` | Register encoding/decoding helpers (Sigma serialization) | New — replaces Plutus Data CBOR |
| `src/ergo/tx-builder.ts` | Transaction building helpers wrapping Fleet SDK | New — replaces cmttk tx builder |
| `src/bhcrypt.ts` | Crypto CLI (adapt key derivation to secp256k1 BIP32) | Cardano `src/bhcrypt.ts` |
| `src/bw/index.ts` | Blockwallet CLI dispatcher | Cardano (update token shortcuts) |
| `src/bw/cli-utils.ts` | Address/token resolution for Ergo | Cardano (replace bech32, cmttk) |
| `src/bw/commands/balance.ts` | ERG + token balance queries | Cardano (use Ergo explorer API) |
| `src/bw/commands/send.ts` | ERG/token transfers via Fleet SDK | Cardano (replace cmttk tx) |
| `src/bw/commands/withdraw.ts` | Subscription box collection | Cardano (replace Plutus redeemers) |
| `src/bw/commands/set.ts` | NFT reference data update | Cardano (use Ergo box registers) |
| `src/bw/commands/plan.ts` | Subscription plan creation box | Cardano (replace datum encoding) |
| `src/bw/commands/split.ts` | Multi-recipient token split | Cardano (use Fleet SDK multi-output) |
| `src/bw/commands/swap.ts` | ERG/token swap via Spectrum DEX | Cardano (replace Uniswap V2) |
| `src/bw/commands/who.ts` | NFT holder lookup | Cardano (use explorer token API) |
| `src/bw/commands/config.ts` | Payment token configuration | Cardano (adapt token ID format) |
| `src/bw/commands/cleanup.ts` | Debug sweep utility | Cardano (use Fleet SDK) |
| `src/ab/index.ts` | Addressbook CLI dispatcher | Cardano (update address validation) |
| `src/ab/commands/add.ts` | Add entry (Base58 validation) | Cardano (replace bech32) |
| `src/ab/commands/del.ts` | Delete entry | Cardano (minimal changes) |
| `src/ab/commands/up.ts` | Update entry address | Cardano (replace bech32) |
| `src/ab/commands/init.ts` | Bootstrap addressbook | Cardano (Ergo address format) |
| `src/is/index.ts` | Identity predicates (NFT ownership, box existence) | Cardano (use Ergo explorer) |
| `src/monitor/index.ts` | Main polling loop | Cardano (replace Koios with Ergo node) |
| `src/monitor/scanner.ts` | Subscription box scanner (by ErgoTree) | Cardano (replace beacon UTXO scan) |
| `src/handlers/index.ts` | Event handlers (provision, extend, destroy) | Cardano (register parsing, not datum) |
| `src/nft/mint.ts` | EIP-4 NFT minting | Cardano (replace CIP-68 two-token) |
| `src/nft/reference.ts` | NFT holder lookup | Cardano (use explorer token API) |
| `src/reconcile/index.ts` | NFT ownership reconciliation | Cardano (Ergo explorer queries) |
| `src/fund-manager/index.ts` | Fund cycle orchestration | Cardano (Ergo tx patterns) |
| `src/fund-manager/config.ts` | Fund manager config (ERG thresholds) | Cardano (rename ADA→ERG) |
| `src/fund-manager/web3-config.ts` | Web3 config loader (Ergo node URL) | Cardano (replace Koios/Blockfrost) |
| `src/fund-manager/addressbook.ts` | Addressbook + hot wallet generation | Cardano (Ergo address validation) |
| `src/fund-manager/collateral.ts` | Remove (Ergo has no collateral concept) | Delete |
| `src/fund-manager/distribution.ts` | Revenue distribution | Cardano (Fleet SDK transfers) |
| `src/fund-manager/withdrawal.ts` | Subscription collection | Cardano (Ergo box spending) |
| `src/admin/index.ts` | Admin command scanner | Cardano (Ergo tx metadata/registers) |
| `src/admin/config.ts` | Admin config loader | Cardano (Ergo address format) |
| `src/admin/nonces.ts` | Nonce tracking (adapt to block height) | Cardano (minimal changes) |
| `scripts/deploy-contracts.ts` | Contract deployment (create guarded boxes) | Cardano (replace Aiken) |
| `scripts/mint_nft.ts` | NFT minting script (EIP-4) | Cardano (replace CIP-68) |
| `scripts/keygen.ts` | Key generation (BIP32 secp256k1, EIP-3 path) | Cardano (replace BIP32-Ed25519) |
| `scripts/signup-engine.js` | Browser signup (Nautilus EIP-12 connector) | Cardano (replace CIP-30) |
| `scripts/signup-template.html` | Signup page HTML | Cardano (Nautilus wallet UI) |
| `scripts/generate-signup-page` | Signup page generator | Cardano (update placeholders) |
| `scripts/first-boot-hook.sh` | First-boot hook | Cardano (Ergo node deps if needed) |
| `blockhost/engine_ergo/wizard.py` | Flask wizard plugin | Cardano (rename, adapt chain ops) |
| `blockhost/engine_ergo/templates/engine_ergo/blockchain.html` | Wizard blockchain page | Cardano (Ergo node config) |
| `blockhost/engine_ergo/templates/engine_ergo/wallet.html` | Wizard wallet page | Cardano (Ergo address format) |
| `blockhost/engine_ergo/templates/engine_ergo/summary_section.html` | Wizard summary | Cardano (rename Cardano→Ergo) |
| `root-agent-actions/wallet.py` | Wallet generation action | Cardano (secp256k1 derivation) |
| `packaging/build.sh` | Debian package builder | Cardano (rename, remove Aiken) |

### Files to Delete (no Ergo equivalent)

| File | Reason |
|------|--------|
| `validators/` (entire dir) | Aiken contracts — replaced by `src/ergo/contracts.ts` |
| `lib/blockhost/` (Aiken lib) | Aiken helper library |
| `aiken.toml` | Aiken build config |
| `plutus.json` | Compiled Plutus blueprint |
| `src/cardano/types.ts` | Replaced by `src/ergo/types.ts` |
| `src/fund-manager/collateral.ts` | Ergo has no Plutus collateral requirement |

---

## Task 1: Project Scaffold & Engine Manifest

**Files:**
- Create: `engine.json`
- Create: `package.json`
- Create: `tsconfig.json` (copy from Cardano)
- Create: `src/paths.ts`
- Create: `src/ergo/types.ts`
- Copy: chain-agnostic files listed above

This task establishes the project skeleton with correct Ergo identity and dependency declarations. No chain interaction yet — purely structural.

- [ ] **Step 1: Create `engine.json`**

```json
{
  "name": "ergo",
  "version": "0.1.0",
  "display_name": "Ergo",
  "accent_color": "#FF5722",
  "setup": {
    "first_boot_hook": "/usr/share/blockhost/engine-hooks/first-boot.sh",
    "wizard_module": "blockhost.engine_ergo.wizard",
    "finalization_steps": ["wallet", "contracts", "chain_config"],
    "post_finalization_steps": ["mint_nft", "plan", "revenue_share"]
  },
  "config_keys": {
    "session_key": "blockchain"
  },
  "constraints": {
    "address_pattern": "^(9|3)[1-9A-HJ-NP-Za-km-z]{50,}$",
    "native_token": "erg",
    "native_token_label": "ERG",
    "token_pattern": "^[0-9a-fA-F]{64}$",
    "address_placeholder": "9f...",
    "signature_pattern": "^[0-9a-fA-F]{2,}$"
  }
}
```

Key differences from Cardano:
- `name`: `"ergo"` (not `"cardano"`)
- `address_pattern`: Base58 starting with `9` (mainnet) or `3` (testnet)
- `native_token`: `"erg"` / `"ERG"`
- `token_pattern`: 64 hex chars (Ergo token IDs are 32 bytes = 64 hex)
- `address_placeholder`: `"9f..."` (Base58)

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "blockhost-engine-ergo",
  "version": "0.1.0",
  "type": "module",
  "description": "Ergo blockchain engine for BlockHost hosting platform",
  "bin": {
    "bw": "./src/bw/index.ts",
    "ab": "./src/ab/index.ts",
    "is": "./src/is/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "monitor": "npx tsx src/monitor/index.ts"
  },
  "dependencies": {
    "@fleet-sdk/core": "^0.6.0",
    "@fleet-sdk/common": "^0.6.0",
    "@fleet-sdk/crypto": "^0.6.0",
    "@noble/curves": "^1.8.0",
    "@noble/hashes": "^1.7.0",
    "@scure/bip39": "^2.0.1",
    "@scure/bip32": "^1.6.0",
    "js-yaml": "^4.1.1"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "latest",
    "esbuild": "^0.25.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Key dependency changes:
- Remove: `cmttk`, `noble-bip32ed25519`, `bech32`
- Add: `@fleet-sdk/core`, `@fleet-sdk/common`, `@fleet-sdk/crypto`, `@scure/bip32`, `ergo-lib-wasm-nodejs`

Verify: `npm install` succeeds.

- [ ] **Step 3: Copy `tsconfig.json` from Cardano**

Copy as-is. No changes needed.

- [ ] **Step 4: Create `src/paths.ts`**

```typescript
/**
 * Shared path constants and environment configuration.
 */

/** Root config directory */
export const CONFIG_DIR = process.env["BLOCKHOST_CONFIG_DIR"] ?? "/etc/blockhost";

/** Root state directory */
export const STATE_DIR = process.env["BLOCKHOST_STATE_DIR"] ?? "/var/lib/blockhost";

/** Addressbook JSON file */
export const ADDRESSBOOK_PATH = `${CONFIG_DIR}/addressbook.json`;

/** web3-defaults.yaml config */
export const WEB3_DEFAULTS_PATH = `${CONFIG_DIR}/web3-defaults.yaml`;

/** blockhost.yaml config */
export const BLOCKHOST_CONFIG_PATH = `${CONFIG_DIR}/blockhost.yaml`;

/** Testing mode flag file */
export const TESTING_MODE_FILE = "/etc/blockhost/.testing-mode";

/** VMs database */
export const VMS_JSON_PATH = `${STATE_DIR}/vms.json`;

/** Minimum nanoERG for outputs (approx 0.001 ERG) */
export const MIN_ERG_FOR_BOX = 1_000_000n;

/** Timeout for Python subprocesses (ms) */
export const PYTHON_TIMEOUT_MS = 10_000;
```

Changes from Cardano: Remove `PLUTUS_JSON_PATH`, rename `MIN_ADA_FOR_TOKEN_OUTPUT` to `MIN_ERG_FOR_BOX`.

- [ ] **Step 5: Create `src/ergo/types.ts`**

```typescript
/**
 * TypeScript types for Ergo box register structures.
 * These map to the ErgoScript guard scripts defined in contracts.ts.
 *
 * Ergo subscription state lives in box registers R4-R9:
 *   R4: (planId: Int, subscriber: Coll[Byte])  — plan + subscriber public key bytes
 *   R5: (amountRemaining: Long, ratePerInterval: Long, intervalMs: Long)
 *   R6: (lastCollected: Long, expiry: Long)
 *   R7: paymentTokenId: Coll[Byte]  — empty for native ERG
 *   R8: userEncrypted: Coll[Byte]
 *   R9: reserved
 * Beacon token ID is in R2 (box tokens). Creation height is in R3.
 */

/** Subscription state decoded from box registers */
export interface SubscriptionState {
  planId: number;
  subscriber: string;        // subscriber address (Base58)
  amountRemaining: bigint;   // nanoERG or token units
  ratePerInterval: bigint;   // cost per interval in base units
  intervalMs: bigint;        // collection interval in milliseconds
  lastCollected: bigint;     // POSIX ms of last collection
  expiry: bigint;            // POSIX ms — subscription ends here
  paymentTokenId: string;    // 64 hex chars, or "" for native ERG
  beaconTokenId: string;     // 64 hex chars — beacon in box tokens
  userEncrypted: string;     // hex-encoded encrypted data
  creationHeight: number;    // from box R3
}

/** Ergo token identifier (token ID = box ID of minting tx first input) */
export type ErgoTokenId = string; // 64 hex chars

/** Ergo network type */
export type ErgoNetwork = "mainnet" | "testnet";

/** NFT reference data (stored in a reference box) */
export interface NftReferenceData {
  userEncrypted: string;     // hex-encoded encrypted connection details
}

/** Ergo box from node/explorer API (simplified) */
export interface ErgoBox {
  boxId: string;
  transactionId: string;
  index: number;
  value: bigint;
  ergoTree: string;
  creationHeight: number;
  assets: Array<{ tokenId: string; amount: bigint }>;
  additionalRegisters: Record<string, string>;  // R4-R9 as serialized hex
}
```

- [ ] **Step 6: Copy all chain-agnostic files**

Copy each file in the "Copy As-Is" table from `blockhost-engine-cardano/` to `blockhost-engine-ergo/`, preserving directory structure. Create parent directories as needed.

Run: `npx tsc --noEmit` — expect type errors from missing chain-specific modules (this is expected; the scaffold compiles incrementally as we add modules).

- [ ] **Step 7: Commit scaffold**

```bash
git add -A
git commit -m "feat: project scaffold with engine manifest and Ergo types"
```

---

## Task 2: Ergo Provider & Address Utilities

**Files:**
- Create: `src/ergo/provider.ts`
- Create: `src/ergo/address.ts`
- Create: `src/ergo/registers.ts`
- Modify: `src/fund-manager/web3-config.ts`

This task builds the chain interaction foundation — querying the Ergo node/explorer and working with Ergo addresses. All subsequent tasks depend on this.

**Ergo API endpoints** (use `ergo-code` MCP `search_docs` for latest API docs):
- Node API: `http://<node>:9053/` (indexed with `extraIndex = true`)
  - `POST /blockchain/box/unspent/byErgoTree` — find subscription boxes
  - `GET /blockchain/token/byId/{tokenId}` — token info
  - `POST /blockchain/balance` — address balance
  - `POST /transactions` — submit signed tx
  - `GET /info` — node info (current height)
- Explorer API: `https://api.ergoplatform.com/api/v1/`
  - `GET /addresses/{address}/balance/total` — confirmed balance
  - `GET /tokens/{tokenId}` — token metadata (returns boxId for issuance)
  - `GET /boxes/{boxId}` — box details with rendered registers
  - `GET /addresses/{address}/transactions` — tx history (admin commands)

- [ ] **Step 1: Create `src/ergo/provider.ts`**

Build an Ergo API client wrapping `fetch()`. Methods needed:

```typescript
export interface ErgoProvider {
  /** Current blockchain height */
  getHeight(): Promise<number>;
  /** Unspent boxes at an address */
  getUnspentBoxes(address: string): Promise<ErgoBox[]>;
  /** Unspent boxes by ErgoTree hex */
  getUnspentBoxesByErgoTree(ergoTree: string): Promise<ErgoBox[]>;
  /** Submit a signed transaction */
  submitTx(signedTx: object): Promise<string>;
  /** Get token info by ID */
  getToken(tokenId: string): Promise<TokenInfo>;
  /** Get balance for an address */
  getBalance(address: string): Promise<{ nanoErg: bigint; tokens: Array<{ tokenId: string; amount: bigint }> }>;
  /** Get transactions for an address (paginated) */
  getTransactions(address: string, offset: number, limit: number): Promise<Transaction[]>;
  /** Get box by ID */
  getBox(boxId: string): Promise<ErgoBox>;
}
```

Config source: `web3-defaults.yaml` → `blockchain.node_url` and `blockchain.explorer_url`. The provider reads from the Ergo node API primarily, falling back to explorer for indexed queries.

Use `ergo-code` MCP tools to verify exact endpoint paths and response shapes.

- [ ] **Step 2: Create `src/ergo/address.ts`**

```typescript
import { ErgoAddress } from "@fleet-sdk/core";

/** Validate an Ergo address (Base58, mainnet or testnet) */
export function isValidAddress(address: string): boolean {
  try {
    ErgoAddress.fromBase58(address);
    return true;
  } catch {
    return false;
  }
}

/** Derive an Ergo address from a secp256k1 public key (compressed, 33 bytes hex) */
export function addressFromPublicKey(pubKeyHex: string, mainnet = true): string {
  // Use ergo-lib-wasm-nodejs or Fleet SDK to encode P2PK address
  // Network prefix: 0x01 = mainnet, 0x11 = testnet
  // ...
}

/** Derive an Ergo address from a secp256k1 private key (32 bytes hex) */
export function addressFromPrivateKey(privKeyHex: string, mainnet = true): string {
  // Derive pubkey from privkey, then call addressFromPublicKey
  // ...
}

/** Extract the public key bytes from a P2PK address */
export function publicKeyFromAddress(address: string): string {
  // Decode Base58, extract GroupElement bytes
  // ...
}
```

Use `ergo-code` MCP `search_docs` for "Ergo address format encoding Base58" to verify the encoding details. Also consult the `ergo-wasm-toolkit` skill.

- [ ] **Step 3: Create `src/ergo/registers.ts`**

Register encoding/decoding using Fleet SDK's `SConstant` serialization:

```typescript
import { SConstant, SColl, SByte, SInt, SLong, STuple } from "@fleet-sdk/core";

/** Encode a UTF-8 string as Sigma Coll[Byte] hex */
export function encodeString(s: string): string {
  return SConstant(SColl(SByte, Buffer.from(s, "utf8"))).toHex();
}

/** Encode subscription registers R4-R8 from SubscriptionState */
export function encodeSubscriptionRegisters(state: SubscriptionState): Record<string, string> {
  return {
    R4: SConstant(STuple(SInt(state.planId), SColl(SByte, Buffer.from(state.subscriber, "hex")))).toHex(),
    R5: SConstant(STuple(SLong(state.amountRemaining), SLong(state.ratePerInterval), SLong(state.intervalMs))).toHex(),
    R6: SConstant(STuple(SLong(state.lastCollected), SLong(state.expiry))).toHex(),
    R7: SConstant(SColl(SByte, Buffer.from(state.paymentTokenId, "hex"))).toHex(),
    R8: SConstant(SColl(SByte, Buffer.from(state.userEncrypted, "hex"))).toHex(),
  };
}

/** Decode subscription state from box registers */
export function decodeSubscriptionRegisters(regs: Record<string, string>): Partial<SubscriptionState> {
  // Deserialize each register using Fleet SDK's SConstant.from()
  // ...
}
```

Verify Fleet SDK serialization API with `ergo-code` MCP `get_skill("fleet-sdk-transactions")`.

- [ ] **Step 4: Adapt `src/fund-manager/web3-config.ts`**

Replace Cardano config loading (Blockfrost project ID, Koios URL, network) with Ergo config:

```typescript
export interface ErgoNetworkConfig {
  nodeUrl: string;        // e.g. "http://localhost:9053"
  explorerUrl: string;    // e.g. "https://api.ergoplatform.com"
  network: ErgoNetwork;   // "mainnet" or "testnet"
}

export function loadNetworkConfig(): ErgoNetworkConfig {
  // Read from web3-defaults.yaml → blockchain.node_url, blockchain.explorer_url, blockchain.network
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — should pass for the provider/address/register modules.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Ergo provider client, address utilities, and register encoding"
```

---

## Task 3: ErgoScript Contracts

**Files:**
- Create: `src/ergo/contracts.ts`
- Create: `scripts/deploy-contracts.ts`

This task defines the ErgoScript guard scripts that protect subscription boxes, reference boxes, and control NFT minting authorization. Unlike Cardano's compiled Aiken validators, Ergo contracts are ErgoScript source compiled to ErgoTree at runtime or pre-compiled hex strings.

**Design decisions:**
- **Subscription box**: Guard script enforces collection rules (server can collect earned amount), cancel rules (subscriber can cancel and reclaim remainder), extend rules (anyone can add funds).
- **Beacon token**: Minted in the subscription creation tx (token ID = first input box ID). Existence = active subscription. Burned when subscription closes.
- **NFT credential**: Standard EIP-4 NFT (amount=1). Minted by server after VM provision. No CIP-68 two-token pattern — Ergo's register model is rich enough for a single token.
- **Reference box**: Holds encrypted connection details in registers. Guard script: only server pubkey can spend (to update).
- **Contract deployment**: Create initial boxes with correct guard scripts and fund them. The "deploy" script creates the config boxes (plan registry, reference store).

Use `ergo-code` MCP `get_ergoscript_ref("context-variables")` and `get_ergoscript_ref("built-in-functions")` for ErgoScript syntax reference. Use `get_pattern("transaction-building")` for Fleet SDK compilation patterns. Consult `search_docs("ErgoScript guard script compilation ErgoTree")` for compilation APIs.

- [ ] **Step 1: Design subscription guard script**

```ergoscript
{
  // Subscription box guard script
  // Parameters (compiled in): serverPk, minCollectionInterval

  val subscriber = SELF.R4[Coll[Byte]].get  // subscriber pubkey bytes in tuple
  val amountRemaining = SELF.R5[(Long, Long, Long)].get._1
  val ratePerInterval = SELF.R5[(Long, Long, Long)].get._2
  val intervalMs = SELF.R5[(Long, Long, Long)].get._3
  val lastCollected = SELF.R6[(Long, Long)].get._1
  val expiry = SELF.R6[(Long, Long)].get._2

  val successor = OUTPUTS(0)
  val sameScript = successor.propositionBytes == SELF.propositionBytes
  val beaconPreserved = successor.tokens(0)._1 == SELF.tokens(0)._1

  // Collection path: server collects earned amount
  val collectPath = {
    val elapsed = /* timestamp math via CONTEXT.preHeader.timestamp */
    val earned = ratePerInterval * elapsed / intervalMs
    val collected = SELF.value - successor.value
    sigmaProp(
      sameScript && beaconPreserved &&
      collected <= earned &&
      serverPk  // server must sign
    )
  }

  // Cancel path: subscriber reclaims
  val cancelPath = {
    // Beacon must be burned (not in outputs)
    sigmaProp(proveDlog(subscriberGroupElement))
  }

  // Extend path: anyone can add funds
  val extendPath = {
    sigmaProp(
      sameScript && beaconPreserved &&
      successor.value > SELF.value  // more ERG in output
    )
  }

  collectPath || cancelPath || extendPath
}
```

Write the full ErgoScript in `src/ergo/contracts.ts` as a string constant, along with a function to compile it to ErgoTree (using `ergo-lib-wasm-nodejs` or Fleet SDK's compile API).

- [ ] **Step 2: Design reference box guard script**

```ergoscript
{
  // Only server can spend (to update reference data)
  serverPk
}
```

Simple P2PK guard — only the server's private key can spend this box to update the encrypted connection details.

- [ ] **Step 3: Write contract compilation and deployment helpers**

```typescript
// src/ergo/contracts.ts
export function compileSubscriptionContract(serverPk: string): string {
  // Returns ErgoTree hex string
}

export function compileReferenceContract(serverPk: string): string {
  // Returns ErgoTree hex string
}

export function getSubscriptionErgoTree(): string {
  // Load compiled ErgoTree from config (written during deployment)
}
```

- [ ] **Step 4: Write `scripts/deploy-contracts.ts`**

Creates initial contract boxes on-chain:
1. Build a transaction that creates a "config box" holding the subscription ErgoTree and plan registry
2. Fund the config box with minimum ERG
3. Sign with deployer key, submit via node API

This replaces the Cardano `deploy-contracts.ts` which deployed Aiken validators as reference scripts.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: ErgoScript guard scripts and contract deployment"
```

---

## Task 4: CLI Infrastructure (bhcrypt, cli-utils, ab)

**Files:**
- Modify: `src/bhcrypt.ts`
- Create: `src/bw/cli-utils.ts`
- Create: `src/ab/index.ts`, `src/ab/commands/add.ts`, `src/ab/commands/del.ts`, `src/ab/commands/up.ts`, `src/ab/commands/init.ts`
- Create: `root-agent-actions/wallet.py`

This task converts the foundational CLI utilities that all other commands depend on: key generation, address validation, addressbook management, and wallet loading.

**Key change:** Ergo uses standard BIP32 secp256k1 (like Bitcoin/Ethereum), NOT BIP32-Ed25519. Derivation path: `m/44'/429'/0'/0/0` (EIP-3). Private keys are 32-byte secp256k1 scalars. Addresses are Base58-encoded.

- [ ] **Step 1: Adapt `src/bhcrypt.ts`**

Replace Cardano's BIP32-Ed25519 derivation (`noble-bip32ed25519`, `cmttk deriveWallet`) with:
- `@scure/bip32` for HD key derivation (secp256k1)
- `@scure/bip39` for mnemonic generation (stays the same)
- `@noble/curves/secp256k1` for key operations (stays the same — ECIES already uses this)

Key functions to adapt:
- `generate-keypair`: Generate secp256k1 private key, derive address, save to file
- `mnemonic-to-key`: Derive via BIP32 path `m/44'/429'/0'/0/0`
- `address-from-key`: Use `src/ergo/address.ts` helpers

Keep all symmetric/asymmetric encrypt/decrypt functions as-is (they're chain-agnostic secp256k1 ECIES).

- [ ] **Step 2: Create `src/bw/cli-utils.ts`**

Replace Cardano-specific imports:

```typescript
import { isValidAddress, addressFromPrivateKey } from "../ergo/address.js";
import { createProvider } from "../ergo/provider.js";
import type { ErgoTokenId } from "../ergo/types.js";

/** Resolve a token shortcut to an Ergo token ID */
export function resolveToken(tokenOrShortcut: string): ErgoTokenId | "" {
  const lower = tokenOrShortcut.toLowerCase();
  if (lower === "erg" || lower === "nanoerg" || lower === "") return "";
  if (lower === "stable" || lower === "stablecoin") return resolveStableToken();
  // 64-hex-char token ID
  if (/^[0-9a-fA-F]{64}$/.test(tokenOrShortcut)) return tokenOrShortcut;
  throw new Error(`Unknown token: '${tokenOrShortcut}'. Use 'erg', 'stable', or 64-char token ID.`);
}

/** Format nanoERG as human-readable ERG string */
export function formatErg(nanoErg: bigint): string {
  const whole = nanoErg / 1_000_000_000n;
  const frac = nanoErg % 1_000_000_000n;
  return `${whole}.${frac.toString().padStart(9, "0")} ERG`;
}
```

Keep `loadAddressbook()`, `resolveAddress()`, `formatToken()` patterns from Cardano but swap address validation.

- [ ] **Step 3: Adapt `src/ab/` commands**

- `add.ts`: Replace `isValidAddress` from cmttk with Ergo's `isValidAddress`
- `del.ts`: Copy as-is (no chain-specific logic)
- `up.ts`: Replace address validation
- `init.ts`: Replace Cardano address derivation with Ergo key derivation
- `index.ts`: Update help text (ERG instead of ADA, address format examples)

- [ ] **Step 4: Adapt `root-agent-actions/wallet.py`**

Replace Cardano wallet generation (CIP-1852 derivation via bhcrypt) with Ergo key generation:
- Call `bhcrypt generate-keypair` (which now generates secp256k1 + Ergo address)
- Save private key to `/etc/blockhost/<name>.key`
- Derive Ergo address from the key
- Add to addressbook

- [ ] **Step 5: Verify**

Run: `npx tsx src/ab/index.ts list` (should work if addressbook exists or return empty)
Run: `npx tsx src/bhcrypt.ts generate-keypair /tmp/test.key` (should produce secp256k1 key + Ergo address)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: CLI infrastructure - bhcrypt, cli-utils, addressbook for Ergo"
```

---

## Task 5: Blockwallet CLI (bw)

**Files:**
- Create/Modify: `src/bw/index.ts` and all `src/bw/commands/*.ts`

This is the largest single task. The `bw` CLI is the primary wallet interface — balance queries, transfers, subscription management, NFT operations. Every command touches chain-specific APIs.

**Approach:** Convert each command file from Cardano patterns to Ergo equivalents. The command signatures (CLI arguments) stay the same per ENGINE_INTERFACE. The internals change from cmttk → Fleet SDK, from Plutus datum → Ergo registers, from Koios queries → Ergo node/explorer queries.

- [ ] **Step 1: `bw/index.ts` — CLI dispatcher**

Update token shortcut table in help text: `erg` instead of `ada`, `stable` stays, token format is 64-hex instead of `policyId.assetName`.

- [ ] **Step 2: `bw balance` — Query balance via Ergo explorer**

Replace `CardanoProvider.fetchAddressBalance` with `ErgoProvider.getBalance()`. Format output using `formatErg()` for native ERG, token amounts for assets.

- [ ] **Step 3: `bw send` — Transfer ERG/tokens via Fleet SDK**

Build a transaction using Fleet SDK's `TransactionBuilder`:
1. Load sender's private key from addressbook keyfile
2. Fetch sender's unspent boxes via provider
3. Build output with recipient address and amount
4. Handle change, fees
5. Sign with private key
6. Submit via node API

- [ ] **Step 4: `bw split` — Multi-recipient transfer**

Same as `send` but multiple outputs with ratio-based amounts. Fleet SDK supports multiple `.to()` calls.

- [ ] **Step 5: `bw withdraw` — Collect from subscription boxes**

This is the most complex command. Must:
1. Find subscription boxes by ErgoTree (same guard script)
2. For each eligible box (enough earned since lastCollected): build a spending tx
3. Create successor box with updated registers (lastCollected, amountRemaining)
4. Beacon token must be preserved in successor
5. Collection output goes to hot wallet

Uses `src/ergo/contracts.ts` for ErgoTree, `src/ergo/registers.ts` for encoding.

- [ ] **Step 6: `bw set encrypt` — Update reference box**

Spend the reference box (server-guarded), create new box with updated R8 (userEncrypted). The reference box ErgoTree is the simple server-PK guard from contracts.ts.

- [ ] **Step 7: `bw plan create` — Create subscription plan box**

Create a "plan box" on-chain with plan details in registers. This is how plans are stored in the Ergo model (vs. contract storage in EVM).

- [ ] **Step 8: `bw who` — NFT holder lookup**

Query Ergo explorer: `GET /tokens/{tokenId}` → get issuance box → follow token transfers to find current holder address.

- [ ] **Step 9: `bw swap` — Spectrum DEX integration**

Replace Uniswap V2 with Spectrum (formerly ErgoDEX). Use `ergo-code` MCP `search_docs("Spectrum DEX swap ErgoDEX")` to find the Spectrum contract interaction pattern. If complex, stub with a clear TODO and error message (matching Cardano's stub approach).

- [ ] **Step 10: `bw config stable` — Payment token config**

Adapt token ID format (64 hex chars instead of `policyId.assetName`). Config read/write from `web3-defaults.yaml` stays the same.

- [ ] **Step 11: `bw --debug --cleanup` — Debug sweep**

Replace cmttk sweep with Fleet SDK: fetch all boxes at signing wallets, build consolidation tx to target address.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: bw CLI - all wallet commands adapted for Ergo"
```

---

## Task 6: Identity CLI & Scanner

**Files:**
- Create: `src/is/index.ts`
- Create: `src/monitor/scanner.ts`

**`is` CLI:** Answers identity questions via exit code. Two forms:
- `is <wallet> <nft_id>`: Check NFT ownership via explorer token query
- `is contract <address>`: Check if a box with the subscription ErgoTree exists at that address (contract "liveness")

**Scanner:** The core of subscription discovery. In Cardano, the scanner queries Koios for beacon tokens by policy ID. In Ergo, the scanner queries the node for unspent boxes by ErgoTree (the subscription guard script). Every box matching that ErgoTree with a beacon token is an active subscription.

- [ ] **Step 1: Create `src/is/index.ts`**

```typescript
// is <wallet> <nft_id>  → query explorer for token holder, compare
// is contract <address> → query unspent boxes by address, check if any exist
```

Use `ErgoProvider.getToken(tokenId)` to find current holder. Compare with provided wallet.

- [ ] **Step 2: Create `src/monitor/scanner.ts`**

Replace Koios beacon scanning with Ergo box scanning:

```typescript
export class ErgoSubscriptionScanner {
  private knownSubscriptions: Map<string, TrackedSubscription> = new Map();

  async scan(): Promise<ScanDiff> {
    // 1. Query: POST /blockchain/box/unspent/byErgoTree with subscription ErgoTree
    // 2. For each box: check it has a beacon token, decode registers → SubscriptionState
    // 3. Diff against known state: detect CREATED, EXTENDED, REMOVED
    // 4. Return ScanDiff
  }
}
```

Key differences from Cardano:
- Discovery: by ErgoTree (not by beacon policy ID)
- Datum parsing: decode Sigma-serialized registers (not Plutus CBOR)
- UTXO reference: `boxId` (not `txHash#outputIndex`)
- Removal confirmation: same two-phase logic (chain-agnostic)

Preserve the `TrackedSubscription`, `ScanDiff` interfaces — they're structurally chain-agnostic.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: identity CLI and subscription box scanner for Ergo"
```

---

## Task 7: Monitor, Handlers & Pipeline

**Files:**
- Create: `src/monitor/index.ts`
- Create: `src/handlers/index.ts`
- Create: `src/nft/mint.ts`
- Create: `src/nft/reference.ts`
- Create: `src/reconcile/index.ts`
- Create: `scripts/mint_nft.ts`

This task wires together the scanner, event handlers, NFT minting, and reconciliation — the complete subscription lifecycle.

- [ ] **Step 1: Create `src/monitor/index.ts`**

The polling loop structure is chain-agnostic. Adapt:
- Replace cmttk provider with ErgoProvider
- Replace Koios block range queries with scanner's `scan()` method
- Keep pipeline state machine, fund cycle, gas check intervals
- Adapt gas check to ERG balance (not ETH)

- [ ] **Step 2: Create `src/handlers/index.ts`**

The handler pipeline (8 steps) is structurally identical. Changes:
- Parse `SubscriptionState` from registers (not Plutus datum)
- Subscriber identity: Ergo address (Base58) not key hash
- VM name format: same (`blockhost-NNN`)
- NFT minting: call `blockhost-mint-nft` (same CLI interface)
- Token ID from mint stdout: same pattern

- [ ] **Step 3: Create `scripts/mint_nft.ts` and `src/nft/mint.ts`**

EIP-4 NFT minting (replaces CIP-68 two-token):
1. Select a UTXO from server wallet (its box ID becomes the token ID)
2. Build minting tx with `OutputBuilder.mintToken({ amount: 1n }, { name, description, decimals: 0 })`
3. Set R4-R6 (name, description, decimals) per EIP-4
4. Set R8 with userEncrypted data
5. Sign with server key, submit

No reference token needed — Ergo's box model is rich enough. The encrypted connection details go in R8 of the NFT issuance box (immutable after minting).

For updating reference data post-mint: use a separate "reference box" pattern (server-guarded box holding updated data), or implement `updateUserEncrypted` via a new minting approach.

- [ ] **Step 4: Create `src/nft/reference.ts`**

NFT holder lookup via Ergo explorer:
```typescript
export async function findNftHolder(tokenId: string, provider: ErgoProvider): Promise<string | null> {
  // GET /tokens/{tokenId} → find current box holding this token → extract address
}
```

- [ ] **Step 5: Create `src/reconcile/index.ts`**

Adapt from Cardano. Core logic is chain-agnostic (compare local vms.json with on-chain state). Chain-specific parts:
- Replace `ownerOf(tokenId)` contract call with Ergo explorer token holder query
- Replace `totalSupply()` with counting existing NFTs via explorer
- GECOS sync stays the same (calls provisioner CLI)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: monitor, handlers, NFT minting, and reconciliation for Ergo"
```

---

## Task 8: Fund Manager & Admin Commands

**Files:**
- Modify: `src/fund-manager/index.ts`, `config.ts`, `addressbook.ts`, `distribution.ts`, `withdrawal.ts`
- Delete: `src/fund-manager/collateral.ts`
- Modify: `src/admin/index.ts`, `config.ts`, `nonces.ts`

- [ ] **Step 1: Fund manager — adapt withdrawal**

Replace Cardano UTXO collection with Ergo box spending. Use `bw withdraw` internally (or import its `executeWithdraw()`).

- [ ] **Step 2: Fund manager — adapt distribution**

Replace cmttk transfers with Fleet SDK. Use `bw send` / `bw split` patterns.

- [ ] **Step 3: Fund manager — remove collateral**

Delete `src/fund-manager/collateral.ts`. Ergo doesn't require collateral for script execution.

- [ ] **Step 4: Fund manager — adapt config**

Rename ADA references to ERG. Update thresholds (ERG has different value scale). Fund manager config from `blockhost.yaml` stays structurally the same.

- [ ] **Step 5: Fund manager — adapt gas check**

Ergo doesn't have separate "gas" — transaction fees are paid in ERG. The gas check becomes an ERG balance check on the server wallet. If below threshold, skip swap (or use Spectrum DEX if implemented).

- [ ] **Step 6: Admin commands — adapt transaction scanning**

In Cardano, admin commands were encoded in tx metadata (label 7368). In Ergo, transactions don't have the same metadata label system. Options:
- **Option A:** Encode commands in a box register (R4) of a transaction output sent to a known address
- **Option B:** Use the transaction's data input boxes to encode command data
- **Option C:** Use a shared "command box" pattern where admin sends a tx spending a specific box

Choose the simplest: encode the HMAC-encrypted command payload in R4 of a transaction output. The monitor scans transactions at the admin address for outputs with R4 data.

- [ ] **Step 7: Admin nonces — adapt to Ergo block model**

Ergo has ~2 minute block times (vs Cardano's 20s). Adjust `max_command_age` defaults. Nonce tracking by box ID instead of block height ranges.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: fund manager and admin commands adapted for Ergo"
```

---

## Task 9: Signup Page & Wallet Connector

**Files:**
- Create: `scripts/signup-engine.js` (~2000 lines, near-complete rewrite)
- Create: `scripts/signup-template.html`
- Create: `scripts/generate-signup-page`

This is a near-complete rewrite of the browser-side subscription flow. Replaces CIP-30 (Cardano wallet API) with EIP-12 (Nautilus wallet connector).

Use `ergo-code` MCP `get_skill("nautilus-dapp-connector")` and `get_skill("fleet-sdk-transactions")` for the exact API patterns.

- [ ] **Step 1: Nautilus wallet connection**

```javascript
// Replace CIP-30: window.cardano.{wallet}.enable()
// With EIP-12: ergoConnector.nautilus.connect()

async function connectWallet() {
  if (!window.ergoConnector) throw new Error("Nautilus wallet not found");
  const connected = await ergoConnector.nautilus.connect();
  if (!connected) throw new Error("User rejected connection");
  // ergo context API is now available
}
```

- [ ] **Step 2: Balance and UTxO queries**

```javascript
// Get user's ERG balance
const balance = await ergo.get_balance("ERG");
// Get user's boxes for coin selection
const boxes = await ergo.get_utxos();
// Get change address
const changeAddr = await ergo.get_change_address();
```

- [ ] **Step 3: Subscription transaction building**

Build the subscription creation tx in-browser:
1. User selects plan, duration
2. Calculate payment amount (ERG or token)
3. Build tx: input from user's wallet → output: subscription box (with guard script) + beacon token mint + change
4. Sign via Nautilus: `await ergo.sign_tx(unsignedTx)`
5. Submit via Nautilus: `await ergo.submit_tx(signedTx)`

This requires building the unsigned tx in EIP-12 format and having the subscription ErgoTree available client-side.

- [ ] **Step 4: ECIES encryption (client-side)**

The server's public key is embedded in the signup page. User encrypts their signature with it (ECIES secp256k1). This is the same as Cardano — secp256k1 ECIES works in both.

- [ ] **Step 5: Template placeholders**

Update `scripts/generate-signup-page` with Ergo-specific placeholders:

| Placeholder | Source |
|-------------|--------|
| `{{SERVER_PUBLIC_KEY}}` | `blockhost.yaml` → `server_public_key` |
| `{{PUBLIC_SECRET}}` | `blockhost.yaml` → `public_secret` |
| `{{NODE_URL}}` | `web3-defaults.yaml` → `blockchain.node_url` |
| `{{EXPLORER_URL}}` | `web3-defaults.yaml` → `blockchain.explorer_url` |
| `{{SUBSCRIPTION_ERGO_TREE}}` | Compiled subscription guard script hex |

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: signup page with Nautilus wallet connector (EIP-12)"
```

---

## Task 10: Wizard Plugin & Python Components

**Files:**
- Create: `blockhost/__init__.py`
- Create: `blockhost/engine_ergo/__init__.py`
- Create: `blockhost/engine_ergo/wizard.py`
- Create: `blockhost/engine_ergo/templates/engine_ergo/blockchain.html`
- Create: `blockhost/engine_ergo/templates/engine_ergo/wallet.html`
- Create: `blockhost/engine_ergo/templates/engine_ergo/summary_section.html`

The wizard plugin follows the same pattern as Cardano. Rename `engine_cardano` → `engine_ergo` throughout. Adapt chain-specific operations.

- [ ] **Step 1: Create Python package structure**

```
blockhost/
  __init__.py
  engine_ergo/
    __init__.py
    wizard.py
    templates/
      engine_ergo/
        blockchain.html
        wallet.html
        summary_section.html
```

- [ ] **Step 2: Adapt `wizard.py`**

Key changes from Cardano wizard:
- Flask blueprint name: `engine_ergo` (not `engine_cardano`)
- Network choices: `mainnet` / `testnet` (not `mainnet` / `preprod` / `preview`)
- Node URL instead of Blockfrost/Koios config
- Key generation: `bhcrypt generate-keypair` (same CLI, now produces Ergo keys)
- Contract deployment: `blockhost-deploy-contracts` (creates initial boxes)
- Address validation: Base58 `^9...` (not bech32 `addr1...`)

Finalization steps (per ENGINE_INTERFACE §10):
1. `wallet` — generate deployer keypair, save mnemonic
2. `contracts` — deploy subscription + reference guard scripts
3. `chain_config` — write web3-defaults.yaml with node URL, explorer URL, ErgoTree hashes

Post-finalization:
1. `mint_nft` — mint admin NFT credential
2. `plan` — create default subscription plan
3. `revenue_share` — write revenue-share.json

- [ ] **Step 3: Adapt templates**

- `blockchain.html`: Ergo node URL field (replace Blockfrost project ID), explorer URL, network dropdown (mainnet/testnet)
- `wallet.html`: Ergo address format in validation, Base58 placeholder
- `summary_section.html`: Display Ergo-specific config summary

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: installer wizard plugin for Ergo engine"
```

---

## Task 11: Packaging & Build

**Files:**
- Create: `packaging/build.sh`
- Create: `packaging/control` (Debian control file template, if not embedded in build.sh)
- Modify: `scripts/first-boot-hook.sh`

- [ ] **Step 1: Adapt `packaging/build.sh`**

Key changes from Cardano build:
- Package name: `blockhost-engine-ergo` (not `cardano`)
- Remove Aiken build step (`aiken build` → no equivalent needed)
- Remove `plutus.json` installation
- Remove `--alias:libsodium-wrappers-sumo=noble-bip32ed25519/sodium` esbuild alias
- Add any Ergo-specific esbuild aliases if needed for WASM modules
- Verify `ergo-lib-wasm-nodejs` bundles correctly with esbuild (WASM may need `--external`)

Bundle targets (same as Cardano):
- `monitor.js` — monitor daemon
- `bw.js` — blockwallet CLI
- `ab.js` — addressbook CLI
- `is.js` — identity CLI
- `bhcrypt.js` — crypto tool

Debian control:
```
Package: blockhost-engine-ergo
Version: 0.1.0
Architecture: all
Depends: blockhost-common (>= 0.1.0), nodejs (>= 22), python3 (>= 3.10)
Provides: bhcrypt, blockhost-engine
Conflicts: blockhost-engine
Description: Ergo blockchain engine for BlockHost hosting platform
```

- [ ] **Step 2: Test build**

```bash
chmod +x packaging/build.sh
./packaging/build.sh
ls -la packaging/blockhost-engine-ergo_0.1.0_all.deb
```

Verify the .deb installs cleanly: `dpkg -c packaging/*.deb | head -40`

- [ ] **Step 3: Adapt `scripts/first-boot-hook.sh`**

If Ergo requires any host-level dependencies installed during first-boot (e.g., ergo node client tools), add them here. Otherwise, keep as a no-op placeholder.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: packaging and build script for blockhost-engine-ergo"
```

---

## Task 12: Integration Verification

**Files:** None created — this is a verification task.

- [ ] **Step 1: Type check**

```bash
npx tsc --noEmit
```

Must pass with zero errors.

- [ ] **Step 2: Verify all CLI entry points**

```bash
npx tsx src/bw/index.ts --help
npx tsx src/ab/index.ts --help
npx tsx src/is/index.ts --help
npx tsx src/bhcrypt.ts --help
```

Each should print usage info without errors.

- [ ] **Step 3: Verify engine manifest**

```bash
node -e "const e = require('./engine.json'); console.log(e.name, e.constraints.native_token)"
# Expected: ergo erg
```

- [ ] **Step 4: Verify esbuild bundles**

```bash
npx esbuild src/monitor/index.ts --bundle --platform=node --target=node22 --outfile=/tmp/monitor.js
npx esbuild src/bw/index.ts --bundle --platform=node --target=node22 --outfile=/tmp/bw.js
npx esbuild src/ab/index.ts --bundle --platform=node --target=node22 --outfile=/tmp/ab.js
```

All three must bundle without errors. Check for WASM-related issues with `ergo-lib-wasm-nodejs`.

- [ ] **Step 5: Cross-reference with ENGINE_INTERFACE**

Walk through `facts/ENGINE_INTERFACE.md` sections 1-14. For each CLI command, config file, and systemd unit, verify the Ergo engine satisfies the contract:
- CLI signatures match (§1)
- Monitor behavior matches (§3)
- Fund manager behavior matches (§4)
- Admin protocol works (§5)
- Config files written correctly (§6)
- Environment variables loaded (§7)
- Systemd unit correct (§8)
- Package naming correct (§8)

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: integration verification pass"
```

---

## Dependency Graph

```
Task 1 (Scaffold)
  └─→ Task 2 (Provider/Address)
       ├─→ Task 3 (Contracts)
       │    └─→ Task 5 (bw CLI) ─→ Task 8 (Fund Manager/Admin)
       │    └─→ Task 6 (Scanner) ─→ Task 7 (Monitor/Handlers)
       └─→ Task 4 (CLI Infra)
            └─→ Task 5 (bw CLI)
            └─→ Task 6 (Scanner)

Task 7 (Monitor) + Task 8 (Fund Manager) → Task 9 (Signup Page)
Task 5 (bw CLI) → Task 10 (Wizard Plugin)

All tasks → Task 11 (Packaging) → Task 12 (Verification)
```

Tasks 3, 4 can run in parallel after Task 2.
Tasks 5, 6 can run in parallel after Tasks 3+4.
Tasks 7, 8 can run in parallel after Tasks 5+6.
Tasks 9, 10 can run in parallel after Task 7+8.
