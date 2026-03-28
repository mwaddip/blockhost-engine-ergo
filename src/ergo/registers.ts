/**
 * Sigma serialization helpers for Ergo subscription box registers.
 *
 * Register layout:
 *   R4: (Int, Coll[Byte])        — (planId, subscriberErgoTreeBytes)
 *   R5: (Long, (Int, Int))        — (amountRemaining, (ratePerInterval, intervalBlocks))
 *   R6: (Int, Int)               — (lastCollectedHeight, expiryHeight)
 *   R7: Coll[Byte]               — paymentTokenId (empty for native ERG)
 *   R8: Coll[Byte]               — userEncrypted
 *
 * Uses Fleet SDK serializer for Sigma type encoding/decoding.
 */

import {
  SInt,
  SLong,
  SByte,
  SColl,
  SPair,
  decode,
} from "@fleet-sdk/serializer";
import { hex } from "@fleet-sdk/crypto";
import * as fs from "fs";
import type { SubscriptionState } from "./types.js";
import { ergoTreeFromAddress } from "./address.js";
import { TESTING_MODE_FILE } from "../paths.js";
import { ErgoAddress, Network } from "@fleet-sdk/core";

// ---------------------------------------------------------------------------
// Primitive encoders
// ---------------------------------------------------------------------------

/** Encode an Int value as Sigma SInt hex. */
export function encodeInt(value: number): string {
  return SInt(value).toHex();
}

/** Encode a Long value as Sigma SLong hex. */
export function encodeLong(value: bigint): string {
  return SLong(value).toHex();
}

/** Encode raw bytes (given as hex string) as Sigma Coll[Byte] hex. */
export function encodeBytes(hexStr: string): string {
  const bytes = hex.decode(hexStr);
  return SColl(SByte, bytes).toHex();
}

/** Encode a UTF-8 string as Sigma Coll[Byte] hex. */
export function encodeString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return SColl(SByte, bytes).toHex();
}

// ---------------------------------------------------------------------------
// Register encoders
// ---------------------------------------------------------------------------

/**
 * Encode subscription registers R4-R8 from a SubscriptionState.
 * Returns a map of register keys ("R4" .. "R8") to serialized hex values.
 */
export function encodeSubscriptionRegisters(
  state: SubscriptionState,
): Record<string, string> {
  // R4: (Int, Coll[Byte]) — (planId, subscriberErgoTreeBytes)
  const subscriberErgoTree = ergoTreeFromAddress(state.subscriber);
  const ergoTreeBytes = hex.decode(subscriberErgoTree);
  const r4 = SPair(SInt(state.planId), SColl(SByte, ergoTreeBytes));

  // R5: (Long, (Int, Int)) — (amountRemaining, (ratePerInterval, intervalBlocks))
  // All time references use block height, never timestamps.
  const r5 = SPair(
    SLong(state.amountRemaining),
    SPair(SInt(Number(state.ratePerInterval)), SInt(state.intervalBlocks)),
  );

  // R6: (Int, Int) — (lastCollectedHeight, expiryHeight)
  const r6 = SPair(SInt(state.lastCollectedHeight), SInt(state.expiryHeight));

  // R7: Coll[Byte] — paymentTokenId (empty bytes for native ERG)
  const tokenIdBytes = state.paymentTokenId
    ? hex.decode(state.paymentTokenId)
    : new Uint8Array(0);
  const r7 = SColl(SByte, tokenIdBytes);

  // R8: Coll[Byte] — userEncrypted
  const encryptedBytes = state.userEncrypted
    ? hex.decode(state.userEncrypted)
    : new Uint8Array(0);
  const r8 = SColl(SByte, encryptedBytes);

  return {
    R4: r4.toHex(),
    R5: r5.toHex(),
    R6: r6.toHex(),
    R7: r7.toHex(),
    R8: r8.toHex(),
  };
}

// ---------------------------------------------------------------------------
// Register decoders
// ---------------------------------------------------------------------------

/**
 * Decode subscription state from box registers.
 * Returns a partial SubscriptionState — only fields present in the registers
 * are populated (beaconTokenId and creationHeight come from box metadata, not
 * registers, so they are never set here).
 */
export function decodeSubscriptionRegisters(
  regs: Record<string, string>,
): Partial<SubscriptionState> {
  const result: Partial<SubscriptionState> = {};

  // R4: (Int, Coll[Byte]) — (planId, subscriberErgoTreeBytes)
  const r4Hex = regs["R4"];
  if (r4Hex) {
    const r4 = decode<[number, Uint8Array]>(r4Hex);
    if (r4) {
      result.planId = r4[0];
      // Convert ErgoTree bytes back to address, respecting .testing-mode
      const ergoTree = hex.encode(r4[1]);
      try {
        const isTestnet = fs.existsSync(TESTING_MODE_FILE);
        const network = isTestnet ? Network.Testnet : Network.Mainnet;
        const addr = ErgoAddress.fromErgoTree(ergoTree, network);
        result.subscriber = addr.encode(network);
      } catch {
        result.subscriber = ergoTree;
      }
    }
  }

  // R5: (Long, (Int, Int)) — (amountRemaining, (ratePerInterval, intervalBlocks))
  const r5Hex = regs["R5"];
  if (r5Hex) {
    const r5 = decode<[bigint, [number, number]]>(r5Hex);
    if (r5) {
      result.amountRemaining = r5[0];
      const inner = r5[1];
      if (Array.isArray(inner)) {
        result.ratePerInterval = BigInt(inner[0]!);
        result.intervalBlocks = inner[1]!;
      }
    }
  }

  // R6: (Int, Int) — (lastCollectedHeight, expiryHeight)
  const r6Hex = regs["R6"];
  if (r6Hex) {
    const r6 = decode<[number, number]>(r6Hex);
    if (r6) {
      result.lastCollectedHeight = r6[0];
      result.expiryHeight = r6[1];
    }
  }

  // R7: Coll[Byte] — paymentTokenId
  const r7Hex = regs["R7"];
  if (r7Hex) {
    const r7 = decode<Uint8Array>(r7Hex);
    if (r7) {
      result.paymentTokenId = r7.length > 0 ? hex.encode(r7) : "";
    }
  }

  // R8: Coll[Byte] — userEncrypted
  const r8Hex = regs["R8"];
  if (r8Hex) {
    const r8 = decode<Uint8Array>(r8Hex);
    if (r8) {
      result.userEncrypted = hex.encode(r8);
    }
  }

  return result;
}
