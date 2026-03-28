/**
 * ErgoScript contract definitions — pre-compiled ErgoTree templates.
 *
 * The subscription guard script is compiled once at development time using the
 * Ergo node's ErgoScript compiler. The resulting ErgoTree bytes are stored here
 * as a hex template. At deployment time, the server's public key is substituted
 * into the constants section — no compiler or JRE needed on the host.
 *
 * ErgoTree constant layout (subscription guard):
 *   Constants 0-5: SInt/SLong literals used by the script body
 *   Constant 6:    Coll[Byte](33) — server compressed public key (the only parameter)
 *   Constants 7-9: SInt/SLong literals used by the script body
 *
 * Reference guard is just proveDlog(serverPk) — the server's P2PK ErgoTree.
 *
 * Spending paths:
 *   1. ServiceCollect  — server collects earned payment
 *   2. SubscriberCancel — subscriber reclaims remaining funds
 *   3. SubscriberExtend — subscriber adds more funds/time
 *   4. Migrate          — server moves to new contract version
 */

import { ErgoAddress, Network } from "@fleet-sdk/core";
import { ergoTreeFromAddress } from "./address.js";

// ---------------------------------------------------------------------------
// Pre-compiled ErgoTree templates
// ---------------------------------------------------------------------------

/**
 * Placeholder public key used during compilation.
 * This is the key that appears in the template ErgoTree at constant index 6.
 * Any valid compressed secp256k1 point works — we just need to know what to
 * search for when substituting the real server key.
 *
 * Using the secp256k1 generator point (a well-known constant).
 */
const TEMPLATE_PK_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/**
 * Pre-compiled subscription guard ErgoTree (hex).
 *
 * Compiled from the subscription ErgoScript source using Ergo node v6.0.2+
 * with the template public key above. The script enforces 4 spending paths:
 * ServiceCollect, SubscriberCancel, SubscriberExtend, Migrate.
 *
 * Register layout on subscription boxes:
 *   R4: (Int, Coll[Byte])          — (planId, subscriberErgoTreeBytes)
 *   R5: (Long, (Long, Long))       — (amountRemaining, (ratePerInterval, intervalMs))
 *   R6: (Long, Long)               — (lastCollected, expiry)
 *   R7: Coll[Byte]                 — paymentTokenId (empty for native ERG)
 *   R8: Coll[Byte]                 — userEncrypted
 *   tokens(0): beacon token
 *
 * To regenerate: compile the subscription ErgoScript source with the template
 * PK via an Ergo node's /script/p2sAddress endpoint, then extract the ErgoTree.
 * See scripts/compile-contracts.ts for the compilation tool.
 */
export const SUBSCRIPTION_ERGO_TREE_TEMPLATE =
  "100e0400040004000400040004000400050201000e210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959" +
  "f2815b16f817980406044805000400d81fd601db6903db6503fed602e4c6a70659d6038c720202d6048c720201d605e4" +
  "c6a7054159d6068c720502d6078c720602d6089d999591720172037203720172047207d6098c720601d60a9c72087209" +
  "d60b8c720501d60c9591720a720b720b720ad60d8cb2db6308a773000001d60ec2a7d60fb5a5d9010f6393c2720f720e" +
  "d610b1720fd6119172107301d612957211b2720f730200b2a5730300d613ededed721191b1db630872127304938cb2db" +
  "6308721273050001720d938cb2db63087212730600027307d614e4c6a704400ed6158c721402d616c67212054159d617" +
  "e47216d6188c721702d619957211d803d619e4c6721204400ed61a7216d61b7217ededededed938c7219018c721401" +
  "938c7219027215d801d61c7218938c721c017209938c721802720793e4c67212070ee4c6a7070e93e4c67212080ee4c6" +
  "a7080e7308d61ac672120659d61be4721ad61ccdee7309d61dcdeeb47215730a730bd61ec672120659d61fe4721eeb02" +
  "eb02eb02ea02d1ed91720c730c9592720c720bafa5d9012063afdb63087220d901224d0e948c722201720dededed7211" +
  "72137219d802d620721ad621721beded938ce4c672120541590199720b720c938c7221019a72049c72087207938c7221" +
  "027203721cea02d1afa5d9012063afdb63087220d901224d0e948c722201720d721dea02d1ededed721172137219d802" +
  "d620721ed621721feded928ce4c6721205415901720b928c7221027203938c7221017204721dea02d1ed937210730dae" +
  "a5d9012063ed94c27220720e92c17220c1a7721c";

// ---------------------------------------------------------------------------
// ErgoTree constant substitution
// ---------------------------------------------------------------------------

/**
 * Parse a VLQ (Variable-Length Quantity) encoded unsigned integer from a byte
 * array, starting at the given offset.
 *
 * @returns [value, newOffset]
 */
function readVLQ(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos]!;
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

/**
 * Locate the server public key constant within an ErgoTree's constants section
 * and return the byte offset and length of the raw key bytes.
 *
 * The ErgoTree format with segregated constants:
 *   [header:1] [numConstants:VLQ] [constant_0] [constant_1] ... [body]
 *
 * Each constant is: [typeDescriptor] [serializedValue]
 * For Coll[Byte]: type = 0x0e, value = [length:VLQ] [bytes...]
 *
 * We search for a Coll[Byte] constant that is exactly 33 bytes long and matches
 * the template PK. Returns { offset, length } of the 33 raw key bytes.
 */
function findPkConstant(
  ergoTreeBytes: Uint8Array,
  templatePkBytes: Uint8Array,
): { offset: number; length: number } | null {
  // Byte 0: header. Bit 4 must be set (constants segregated)
  const header = ergoTreeBytes[0]!;
  if ((header & 0x10) === 0) {
    throw new Error("ErgoTree does not have segregated constants");
  }

  // Parse number of constants
  let pos = 1;
  let numConstants: number;
  [numConstants, pos] = readVLQ(ergoTreeBytes, pos);

  // Walk through each constant
  for (let i = 0; i < numConstants; i++) {
    const typeByte = ergoTreeBytes[pos]!;
    pos++;

    if (typeByte === 0x01) {
      // SBoolean — 1 byte value (0 or 1)
      pos++;
    } else if (typeByte === 0x04) {
      // SInt — VLQ zigzag encoded, skip the value
      [, pos] = readVLQ(ergoTreeBytes, pos);
    } else if (typeByte === 0x05) {
      // SLong — VLQ zigzag encoded, skip the value
      [, pos] = readVLQ(ergoTreeBytes, pos);
    } else if (typeByte === 0x0e) {
      // Coll[Byte] — VLQ length + raw bytes
      let length: number;
      [length, pos] = readVLQ(ergoTreeBytes, pos);

      if (length === 33) {
        // Check if this is our template PK
        const candidate = ergoTreeBytes.slice(pos, pos + 33);
        let match = true;
        for (let j = 0; j < 33; j++) {
          if (candidate[j] !== templatePkBytes[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          return { offset: pos, length: 33 };
        }
      }
      pos += length;
    } else {
      // Unknown type — can't continue parsing
      throw new Error(`Unknown constant type 0x${typeByte.toString(16)} at position ${pos - 1}`);
    }
  }

  return null;
}

/**
 * Substitute the server public key in a pre-compiled ErgoTree template.
 *
 * Finds the 33-byte template PK constant in the ErgoTree's constants section
 * and replaces it with the actual server public key. The rest of the ErgoTree
 * (including the body opcodes) is unchanged.
 *
 * @param templateHex     Pre-compiled ErgoTree hex with template PK
 * @param serverPkHex     Actual server compressed public key (66 hex chars)
 * @param templatePkHex   The template PK to search for (default: secp256k1 generator)
 * @returns ErgoTree hex with substituted server PK
 */
export function substituteErgoTreePk(
  templateHex: string,
  serverPkHex: string,
  templatePkHex: string = TEMPLATE_PK_HEX,
): string {
  if (serverPkHex.length !== 66) {
    throw new Error(`Expected 66 hex char compressed public key, got ${serverPkHex.length}`);
  }

  const treeBytes = hexToBytes(templateHex);
  const templatePkBytes = hexToBytes(templatePkHex);
  const serverPkBytes = hexToBytes(serverPkHex);

  const loc = findPkConstant(treeBytes, templatePkBytes);
  if (!loc) {
    throw new Error("Template PK not found in ErgoTree constants section");
  }

  // Substitute in place
  const result = new Uint8Array(treeBytes);
  for (let i = 0; i < 33; i++) {
    result[loc.offset + i] = serverPkBytes[i]!;
  }

  return bytesToHex(result);
}

// ---------------------------------------------------------------------------
// Template management
// ---------------------------------------------------------------------------

/**
 * Get the subscription guard ErgoTree for a specific server public key.
 *
 * Substitutes the server PK constant in the pre-compiled template.
 * No compiler, JRE, or node needed — pure byte surgery.
 *
 * @param serverPkHex  Compressed secp256k1 public key (66 hex chars)
 * @returns ErgoTree hex string
 */
export function getSubscriptionErgoTree(serverPkHex: string): string {
  return substituteErgoTreePk(SUBSCRIPTION_ERGO_TREE_TEMPLATE, serverPkHex);
}

/**
 * Get the reference guard ErgoTree for a specific server address.
 *
 * For reference boxes the guard is simply proveDlog(serverPk), which is
 * equivalent to the server's P2PK ErgoTree: 0008cd + compressed pubkey.
 * No template substitution needed.
 *
 * @param serverAddress  Server's Base58 P2PK address
 * @returns ErgoTree hex string
 */
export function getReferenceErgoTree(serverAddress: string): string {
  return ergoTreeFromAddress(serverAddress);
}

/**
 * Compute the P2S address from an ErgoTree hex string.
 */
export function contractAddress(ergoTreeHex: string, mainnet = true): string {
  const network = mainnet ? Network.Mainnet : Network.Testnet;
  const addr = ErgoAddress.fromErgoTree(ergoTreeHex, network);
  return addr.encode(network);
}

// ---------------------------------------------------------------------------
// Legacy: node-based compilation (for initial template generation only)
// ---------------------------------------------------------------------------

/** Convert compressed pubkey hex to Base64 for ErgoScript fromBase64() */
export function pubKeyHexToBase64(pubKeyHex: string): string {
  if (pubKeyHex.length !== 66) {
    throw new Error(`Expected 66 hex char compressed public key, got ${pubKeyHex.length} chars`);
  }
  return Buffer.from(pubKeyHex, "hex").toString("base64");
}

/**
 * The ErgoScript source for the subscription guard.
 * Only needed for initial template compilation — not used at runtime.
 */
export const SUBSCRIPTION_SCRIPT_SOURCE = `{
  val serverPk = decodePoint(fromBase64("$$SERVER_PK_BASE64$$"))
  val r4 = SELF.R4[(Int, Coll[Byte])].get
  val planId = r4._1
  val subscriberErgoTree = r4._2
  val r5 = SELF.R5[(Long, (Long, Long))].get
  val amountRemaining = r5._1
  val ratePerInterval = r5._2._1
  val intervalMs = r5._2._2
  val r6 = SELF.R6[(Long, Long)].get
  val lastCollected = r6._1
  val expiry = r6._2
  val paymentTokenId = SELF.R7[Coll[Byte]].get
  val userEncrypted = SELF.R8[Coll[Byte]].get
  val beaconTokenId = SELF.tokens(0)._1
  val currentTime = CONTEXT.preHeader.timestamp
  val selfScript = SELF.propositionBytes
  val successors = OUTPUTS.filter { (box: Box) => box.propositionBytes == selfScript }
  val hasSuccessor = successors.size > 0
  val successor = if (hasSuccessor) successors(0) else OUTPUTS(0)
  val beaconPreserved = hasSuccessor && successor.tokens.size > 0 &&
                        successor.tokens(0)._1 == beaconTokenId &&
                        successor.tokens(0)._2 == 1L
  val immutablePreserved = if (hasSuccessor) {
    val successorR4 = successor.R4[(Int, Coll[Byte])].get
    val successorR5 = successor.R5[(Long, (Long, Long))].get
    successorR4._1 == planId &&
    successorR4._2 == subscriberErgoTree &&
    successorR5._2._1 == ratePerInterval &&
    successorR5._2._2 == intervalMs &&
    successor.R7[Coll[Byte]].get == paymentTokenId &&
    successor.R8[Coll[Byte]].get == userEncrypted
  } else false
  val effectiveTime = if (currentTime > expiry) expiry else currentTime
  val elapsedMs = effectiveTime - lastCollected
  val intervals = elapsedMs / intervalMs
  val earned = {
    val raw = intervals * ratePerInterval
    if (raw > amountRemaining) amountRemaining else raw
  }
  val fullyConsumed = earned >= amountRemaining
  val collectPath = {
    val validEarn = earned > 0L
    val validContinuation = if (fullyConsumed) {
      OUTPUTS.forall { (box: Box) =>
        box.tokens.forall { (t: (Coll[Byte], Long)) => t._1 != beaconTokenId }
      }
    } else {
      hasSuccessor && beaconPreserved && immutablePreserved && {
        val sR5 = successor.R5[(Long, (Long, Long))].get
        val sR6 = successor.R6[(Long, Long)].get
        sR5._1 == amountRemaining - earned &&
        sR6._1 == lastCollected + intervals * intervalMs &&
        sR6._2 == expiry
      }
    }
    sigmaProp(validEarn && validContinuation) && proveDlog(serverPk)
  }
  val subscriberPk = decodePoint(subscriberErgoTree.slice(3, 36))
  val cancelPath = {
    val beaconBurned = OUTPUTS.forall { (box: Box) =>
      box.tokens.forall { (t: (Coll[Byte], Long)) => t._1 != beaconTokenId }
    }
    sigmaProp(beaconBurned) && proveDlog(subscriberPk)
  }
  val extendPath = {
    val validExtension = hasSuccessor && beaconPreserved && immutablePreserved && {
      val sR5 = successor.R5[(Long, (Long, Long))].get
      val sR6 = successor.R6[(Long, Long)].get
      sR5._1 >= amountRemaining &&
      sR6._2 >= expiry &&
      sR6._1 == lastCollected
    }
    sigmaProp(validExtension) && proveDlog(subscriberPk)
  }
  val migratePath = {
    val noSuccessor = successors.size == 0
    val anyOutputHasValue = OUTPUTS.exists { (box: Box) =>
      box.propositionBytes != selfScript && box.value >= SELF.value
    }
    sigmaProp(noSuccessor && anyOutputHasValue) && proveDlog(serverPk)
  }
  collectPath || cancelPath || extendPath || migratePath
}`;

/**
 * Compile ErgoScript to P2S address via Ergo node.
 * Only used for initial template generation — not needed at runtime.
 */
export async function compileToP2SAddress(
  nodeUrl: string,
  source: string,
  apiKey?: string,
): Promise<string> {
  const url = `${nodeUrl.replace(/\/+$/, "")}/script/p2sAddress`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["api_key"] = apiKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ source, treeVersion: 0 }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ErgoScript compilation failed (${res.status}): ${body}`);
  }

  return ((await res.json()) as { address: string }).address;
}

// ---------------------------------------------------------------------------
// Hex helpers (avoid importing from other modules for self-containment)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
