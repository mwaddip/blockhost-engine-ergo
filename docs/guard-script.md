# Guard Script

A single pre-compiled ErgoScript guard controls the on-chain subscription lifecycle. The script is parameterized — the server's public key is substituted at deploy time via byte surgery on the compiled ErgoTree (no compiler or JRE needed at runtime).

## Subscription Guard (`src/ergo/contracts.ts`)

Spending script. Controls all spending of subscription boxes locked at the guard address.

### Register Layout

Stored in box registers R4-R8 on every subscription box:

| Register | Type | Description |
|----------|------|-------------|
| R4 | `(Int, Coll[Byte])` | Plan ID + subscriber ErgoTree bytes |
| R5 | `(Long, (Long, Int))` | Amount remaining + (rate per interval, interval in blocks) |
| R6 | `(Int, Int)` | Last collected height + expiry height |
| R7 | `Coll[Byte]` | Payment token ID (empty bytes for native ERG) |
| R8 | `Coll[Byte]` | ECIES-encrypted user data |

All time references use **block height**, never timestamps. HEIGHT is deterministic and monotonically increasing.

### Beacon Token

Each subscription carries a beacon token (amount = 1) whose token ID equals the first input box ID of the subscription creation transaction. The beacon makes subscription boxes discoverable via explorer queries by ErgoTree.

### Parameters

| Parameter | Description |
|-----------|-------------|
| Server PK | Compressed secp256k1 public key (33 bytes) — substituted into ErgoTree constant at byte offset |

### Spending Paths

**ServiceCollect**

Server collects earned payment after intervals have elapsed.

- Transaction must be signed by server PK (`proveDlog(serverPk)`)
- `earned = min(intervals * ratePerInterval, amountRemaining)` where `intervals = (effectiveHeight - lastCollectedHeight) / intervalBlocks`
- `effectiveHeight = min(HEIGHT, expiryHeight)` — collection is capped at expiry
- If `earned >= amountRemaining` (fully consumed): no beacon token in any output (beacon burned)
- If partial: OUTPUTS(0) must be a continuing box at the same script address with:
  - Same beacon token (preserved)
  - Same immutable fields (planId, subscriber, rate, intervalBlocks, paymentToken, userEncrypted)
  - Updated `amountRemaining = amountRemaining - earned`
  - Updated `lastCollectedHeight = lastCollectedHeight + intervals * intervalBlocks`
  - Same `expiryHeight`

**SubscriberCancel**

Subscriber cancels and reclaims remaining funds.

- Transaction must be signed by subscriber PK (derived from R4 subscriber ErgoTree)
- Beacon token must not appear in any output (burned)

**SubscriberExtend**

Subscriber extends by spending and recreating the box with additional funds.

- Transaction must be signed by subscriber PK
- OUTPUTS(0) must be a continuing box at the same script address with:
  - Beacon token preserved
  - Immutable fields unchanged
  - `amountRemaining >= original amountRemaining`
  - `expiryHeight >= original expiryHeight`
  - `lastCollectedHeight` unchanged

**Migrate**

Server migrates to a new contract version.

- Transaction must be signed by server PK
- OUTPUTS(0) must have a different `propositionBytes` (different script)
- OUTPUTS(0).value must be >= SELF.value

### Eager Evaluation Constraint

The guard script defines `val` bindings for `OUTPUTS(0)` registers at the top level. These evaluate eagerly regardless of which spending path is taken. All transactions — including fully consumed collections — must ensure OUTPUTS(0) has valid R4, R5, R6, R7, R8 registers of the correct types to avoid `None.get` evaluation errors.

### ErgoTree Template

The compiled ErgoTree is 534 bytes. The server PK constant is at a known byte offset. Deployment substitutes the PK via `substituteErgoTreePk()` — pure byte surgery, no compiler invocation:

```typescript
const guardErgoTree = getSubscriptionErgoTree(serverPkHex);
const guardAddress = contractAddress(guardErgoTree, mainnet);
```

After deployment, the subscription guard ErgoTree and its P2S address are written to `/etc/blockhost/web3-defaults.yaml`.

## NFT Minting (EIP-4)

NFTs are minted via a standard P2PK transaction (no minting policy script). On Ergo, the token ID of a newly minted token equals the first input box ID. NFTs use EIP-4 register convention:

| Register | Content |
|----------|---------|
| R4 | Name (`Coll[Byte]`, UTF-8) |
| R5 | Description (`Coll[Byte]`, UTF-8) |
| R6 | Decimals (`Coll[Byte]`, "0") |
| R7 | Type marker (`Coll[Byte]`, `[0x01, 0x01]`) |
| R8 | User encrypted (`Coll[Byte]`, ECIES ciphertext) |

The NFT goes to the subscriber's address. A separate reference box at the server address stores the NFT token ID in R4 and encrypted data in R5 for server-side access.

## Plan Boxes

Plan definitions are stored as server-controlled P2PK boxes with registers:

| Register | Content |
|----------|---------|
| R4 | Plan name (`Coll[Byte]`, UTF-8) |
| R5 | Price (`Long`, nanoERG) |
| R6 | Active flag (`Int`, 1 = active) |

Created via `bw plan create`. The signup page reads these from the server address to display available plans.
