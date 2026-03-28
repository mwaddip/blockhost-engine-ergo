/**
 * TypeScript types for Ergo box register structures.
 *
 * Ergo subscription state lives in box registers R4-R9:
 *   R4: (planId: Int, subscriber: Coll[Byte])
 *   R5: (amountRemaining: Long, (ratePerInterval: Long, intervalMs: Long))
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
