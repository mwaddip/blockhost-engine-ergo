# Ergo Transaction Building Pitfalls

Notes from building a minimal Ergo tx toolkit from scratch. These are the things that aren't obvious from the docs and cost hours to debug.

## Block height, never timestamps

All on-chain time logic must use `HEIGHT`, never `CONTEXT.preHeader.timestamp`. Block height is deterministic and monotonically increasing. Timestamps are miner-adjustable and inconsistent. This applies to subscription intervals, expiry, collection scheduling — everything.

**Symptom if wrong:** Subscription timing is unpredictable, tests pass on one block and fail on the next.

## Fleet SDK toPlainObject() strips input box data

`TransactionBuilder.build().toPlainObject()` returns inputs as `{ boxId, extension }` only — no `value`, `ergoTree`, `creationHeight`, or other fields. The ergo-relay signer needs full box data to create the `TransactionContext` for signing.

Fix: pass the original `ErgoBox[]` array to `provider.signTx()` which merges full box data into `tx.inputs` before sending to the signer.

**Symptom if wrong:** `Signer POST /wallet/transaction/sign failed (400): missing field 'value'`

## ErgoTree constant substitution (no compiler needed)

The subscription guard is compiled once at development time. At deploy time, the server PK is substituted via byte surgery — find the placeholder PK bytes in the compiled ErgoTree and replace them. No Ergo node, no JRE, no compiler on the host.

`substituteErgoTreePk()` in `src/ergo/contracts.ts` handles this. The PK is at a fixed byte offset in the template.

## Guard script eager evaluation

ErgoScript `val` bindings at the top level of a `{ }` block evaluate eagerly in sigma-rust, even if the spending path doesn't reference them. The subscription guard defines:

```
val successorR4 = OUTPUTS(0).R4[(Int, Coll[Byte])].get
val successorR5 = OUTPUTS(0).R5[(Long, (Long, Int))].get
val successorR6 = OUTPUTS(0).R6[(Int, Int)].get
```

These crash with `None.get` if OUTPUTS(0) doesn't have registers of the right type — even on the `fullyConsumed` path which doesn't use these values.

Fix: always create OUTPUTS(0) with valid register types, even for fully consumed subscriptions. Use a dummy server-owned output with the same register structure.

**Symptom if wrong:** `EvalError: Not found: calling Option.get on None` at `OUTPUTS(0).getReg(4)`

## OUTPUTS(0) ordering matters

The guard script checks `OUTPUTS(0)` for the continuing box. Fleet SDK preserves `.to()` insertion order, so the continuing output must be added first (`txBuilder.to(continuingOutput)`) before the collection output. If order changes, the guard script validates the wrong box.

## One subscription per transaction

The guard script checks `OUTPUTS(0)` for continuation, so only one subscription box can be collected per transaction. Batch collection requires multiple sequential transactions.

## Explorer register format inconsistency

The explorer returns registers in different formats depending on the endpoint:
- `/boxes/unspent/byAddress/`: registers as `{ serializedValue: "hex", sigmaType: "...", renderedValue: "..." }`
- `/boxes/{id}`: same object format
- Transaction outputs in `/addresses/{addr}/transactions`: same object format

The `normalizeExplorerBox()` function in `provider.ts` extracts `serializedValue` from both formats. Code that reads registers directly from explorer responses (e.g., admin command detection) must handle the object format.

**Symptom if wrong:** HMAC verification silently fails because the register value is `[object Object]` instead of a hex string.

## Token ID = first input box ID

On Ergo, minting a token with `OutputBuilder.mintToken()` produces a token whose ID equals `inputs[0].boxId`. This is a protocol rule, not a convention. The minted token's amount can be anything, but the ID is always deterministic.

## Minimum box value

Every Ergo box must carry at least `SAFE_MIN_BOX_VALUE` (currently 1,000,000 nanoERG = 0.001 ERG). Attempting to create a box with less ERG will fail at the protocol level. The `OutputBuilder` enforces this.

## Base58 address encoding

Ergo addresses are Base58Check-encoded (not bech32 like Cardano):
- `type_byte(1) || content(33 for P2PK) || blake2b256_checksum(4)` = 38 bytes
- Mainnet P2PK type byte: `0x01` (addresses start with `9`)
- Testnet P2PK type byte: `0x11` (addresses start with `3`)
- P2S addresses are much longer (full ErgoTree in content) — hundreds of characters

## Explorer testnet reliability

- Transaction submission via explorer often times out (503)
- Explorer can lag a few blocks, causing stale UTXO errors on rapid tx sequences
- `getBoxesByTokenId` on testnet returns 404 for the `/unspent` variant; use `/boxes/byTokenId/{id}` and filter client-side
- Submitted transactions may not appear in explorer for 1-2 blocks even after confirmation by the local node

## Sigma serialization for registers

Box registers use Sigma type encoding. `Coll[Byte]` is encoded as `0x0e` + VLQ length + raw bytes. Tuples, Ints, Longs have their own type prefixes. Fleet SDK's `@fleet-sdk/serializer` provides `SColl`, `SByte`, `SInt`, `SLong`, `SPair` for encoding and `decode<T>()` for decoding.

Registers must be sequential — if R8 is set, R4-R7 must also be present. Fleet SDK enforces this.

## ergo-relay signing

The ergo-relay at `localhost:9064` accepts `POST /wallet/transaction/sign` with:
```json
{
  "tx": { ... },
  "secrets": { "dlog": ["<hex private key>"] },
  "height": 254000
}
```

The `height` field is used for scripts that reference `HEIGHT` (like the subscription guard). Pass the current blockchain height from the explorer.

The `tx.inputs` array must contain full box data (value, ergoTree, etc.), not just `{ boxId, extension }`.
