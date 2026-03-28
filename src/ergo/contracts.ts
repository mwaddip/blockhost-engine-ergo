/**
 * ErgoScript contract definitions and compilation helpers.
 *
 * Subscription guard script: protects subscription boxes with 4 spending paths:
 *   1. ServiceCollect  — server collects earned payment
 *   2. SubscriberCancel — subscriber reclaims remaining funds
 *   3. SubscriberExtend — subscriber adds more funds/time
 *   4. Migrate          — server moves to new contract version
 *
 * Reference guard: server-only P2PK for NFT reference data boxes.
 *
 * Compilation approach: ErgoScript source is compiled to ErgoTree via the
 * Ergo node's POST /script/p2sAddress endpoint. The resulting P2S address is
 * converted back to its ErgoTree hex. For offline / pre-compiled usage the
 * ErgoTree hex can be cached to avoid repeated node calls.
 */

import { ErgoAddress, Network } from "@fleet-sdk/core";
import { ergoTreeFromAddress } from "./address.js";

// ---------------------------------------------------------------------------
// ErgoScript source code
// ---------------------------------------------------------------------------

/**
 * The ErgoScript source for the subscription guard contract.
 *
 * Parameters (compiled in via string substitution before compilation):
 *   - serverPk: GroupElement — server's secp256k1 public key
 *
 * The script expects the server's public key to be provided as a Base64-encoded
 * group element via `decodePoint(fromBase64("..."))`.
 *
 * Register layout (on the input subscription box):
 *   R4: (Int, Coll[Byte])        — (planId, subscriberErgoTreeBytes)
 *   R5: (Long, Long, Long)       — (amountRemaining, ratePerInterval, intervalMs)
 *   R6: (Long, Long)             — (lastCollected, expiry)
 *   R7: Coll[Byte]               — paymentTokenId (empty for native ERG)
 *   R8: Coll[Byte]               — userEncrypted (ECIES-encrypted connection details)
 *   tokens(0): (Coll[Byte], Long) — beacon token (unique per subscription)
 */
export const SUBSCRIPTION_SCRIPT_TEMPLATE = `{
  // ---- Parameters (compiled in) ----
  val serverPk = decodePoint(fromBase64("$$SERVER_PK_BASE64$$"))

  // ---- Read subscription state from registers ----
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

  // ---- Beacon token (first token in box) ----
  val beaconTokenId = SELF.tokens(0)._1

  // ---- Time from transaction context ----
  val currentTime = CONTEXT.preHeader.timestamp

  // ---- Successor box (first output) ----
  val successor = OUTPUTS(0)

  // ---- Helper: check successor preserves script and beacon ----
  val sameScript = successor.propositionBytes == SELF.propositionBytes
  val beaconPreserved = successor.tokens.size > 0 &&
                        successor.tokens(0)._1 == beaconTokenId &&
                        successor.tokens(0)._2 == 1L

  // ---- Helper: check successor preserves immutable registers ----
  val successorR4 = successor.R4[(Int, Coll[Byte])].get
  val successorR5 = successor.R5[(Long, (Long, Long))].get
  val successorR6 = successor.R6[(Long, Long)].get
  val immutablePreserved = {
    successorR4._1 == planId &&
    successorR4._2 == subscriberErgoTree &&
    successorR5._2._1 == ratePerInterval &&
    successorR5._2._2 == intervalMs &&
    successor.R7[Coll[Byte]].get == paymentTokenId &&
    successor.R8[Coll[Byte]].get == userEncrypted
  }

  // ---- Path 1: ServiceCollect ----
  // Cap elapsed time at expiry — cannot collect beyond subscription end
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
      // Beacon must be burned — verify absent from ALL outputs
      OUTPUTS.forall { (box: Box) =>
        box.tokens.forall { (t: (Coll[Byte], Long)) => t._1 != beaconTokenId }
      }
    } else {
      sameScript && beaconPreserved && immutablePreserved &&
      successorR5._1 == amountRemaining - earned &&
      successorR6._1 == lastCollected + intervals * intervalMs &&
      successorR6._2 == expiry
    }
    sigmaProp(validEarn && validContinuation) && proveDlog(serverPk)
  }

  // ---- Path 2: SubscriberCancel ----
  // Extract subscriber's GroupElement from their P2PK ErgoTree.
  // P2PK ErgoTree = 0008cd + 33-byte compressed pubkey (36 bytes total).
  // decodePoint() takes the 33-byte compressed key.
  val subscriberPk = decodePoint(subscriberErgoTree.slice(3, 36))

  val cancelPath = {
    // Beacon must NOT appear in any output (burned)
    val beaconBurned = OUTPUTS.forall { (box: Box) =>
      box.tokens.forall { (t: (Coll[Byte], Long)) => t._1 != beaconTokenId }
    }
    sigmaProp(beaconBurned) && proveDlog(subscriberPk)
  }

  // ---- Path 3: SubscriberExtend ----
  val extendPath = {
    val validExtension = sameScript && beaconPreserved && immutablePreserved &&
      successorR5._1 >= amountRemaining &&
      successorR6._2 >= expiry &&
      successorR6._1 == lastCollected
    sigmaProp(validExtension) && proveDlog(subscriberPk)
  }

  // ---- Path 4: Migrate ----
  val migratePath = {
    val differentScript = OUTPUTS(0).propositionBytes != SELF.propositionBytes
    val valueMaintained = OUTPUTS(0).value >= SELF.value
    sigmaProp(differentScript && valueMaintained) && proveDlog(serverPk)
  }

  collectPath || cancelPath || extendPath || migratePath
}`;

/**
 * Simple reference box guard script: only the server can spend.
 * In practice this is equivalent to the server's P2PK address, so we use
 * the server's P2PK ErgoTree directly rather than compiling a script.
 */
export const REFERENCE_SCRIPT_TEMPLATE = `{
  proveDlog(decodePoint(fromBase64("$$SERVER_PK_BASE64$$")))
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex-encoded compressed public key (33 bytes / 66 hex chars)
 * to Base64 encoding suitable for ErgoScript's fromBase64().
 */
export function pubKeyHexToBase64(pubKeyHex: string): string {
  if (pubKeyHex.length !== 66) {
    throw new Error(
      `Expected 66 hex char compressed public key, got ${pubKeyHex.length} chars`,
    );
  }
  return Buffer.from(pubKeyHex, "hex").toString("base64");
}

/**
 * Substitute the server public key placeholder in an ErgoScript template.
 *
 * @param template  ErgoScript source with $$SERVER_PK_BASE64$$ placeholder
 * @param serverPubKeyHex  Compressed public key hex (66 chars)
 * @returns ErgoScript source with the placeholder replaced
 */
export function substituteServerPk(
  template: string,
  serverPubKeyHex: string,
): string {
  const b64 = pubKeyHexToBase64(serverPubKeyHex);
  return template.replace(/\$\$SERVER_PK_BASE64\$\$/g, b64);
}

/**
 * Produce the final ErgoScript source for the subscription guard,
 * parameterized with a specific server public key.
 *
 * @param serverPubKeyHex  Compressed secp256k1 public key (66 hex chars)
 * @returns Ready-to-compile ErgoScript source string
 */
export function getSubscriptionScript(serverPubKeyHex: string): string {
  return substituteServerPk(SUBSCRIPTION_SCRIPT_TEMPLATE, serverPubKeyHex);
}

/**
 * Produce the final ErgoScript source for the reference box guard,
 * parameterized with a specific server public key.
 *
 * @param serverPubKeyHex  Compressed secp256k1 public key (66 hex chars)
 * @returns Ready-to-compile ErgoScript source string
 */
export function getReferenceScript(serverPubKeyHex: string): string {
  return substituteServerPk(REFERENCE_SCRIPT_TEMPLATE, serverPubKeyHex);
}

// ---------------------------------------------------------------------------
// Compilation via Ergo node
// ---------------------------------------------------------------------------

/**
 * Compile an ErgoScript source string to a P2S address using the Ergo node's
 * /script/p2sAddress endpoint.
 *
 * @param nodeUrl  Ergo node base URL (e.g. "http://localhost:9053")
 * @param source   ErgoScript source code
 * @param apiKey   Optional API key for authenticated node endpoints
 * @returns The compiled P2S address (Base58)
 */
export async function compileToP2SAddress(
  nodeUrl: string,
  source: string,
  apiKey?: string,
): Promise<string> {
  const url = `${nodeUrl.replace(/\/+$/, "")}/script/p2sAddress`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["api_key"] = apiKey;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ source, treeVersion: 0 }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `ErgoScript compilation failed (${res.status}): ${body}`,
    );
  }

  const data = (await res.json()) as { address: string };
  return data.address;
}

/**
 * Compile the subscription guard script with a server public key,
 * using the Ergo node for compilation.
 *
 * @param nodeUrl          Ergo node URL
 * @param serverPubKeyHex  Server compressed public key (66 hex chars)
 * @param apiKey           Optional node API key
 * @returns ErgoTree hex string for the subscription guard
 */
export async function compileSubscriptionContract(
  nodeUrl: string,
  serverPubKeyHex: string,
  apiKey?: string,
): Promise<string> {
  const source = getSubscriptionScript(serverPubKeyHex);
  const p2sAddress = await compileToP2SAddress(nodeUrl, source, apiKey);
  return ergoTreeFromAddress(p2sAddress);
}

/**
 * Get the ErgoTree hex for a reference box.
 *
 * For reference boxes the guard is simply the server's P2PK, so we can
 * derive it directly from the server address without node compilation.
 * This is equivalent to the server's P2PK ErgoTree (0008cd + pubkey).
 *
 * @param serverAddress  Server's Base58 P2PK address
 * @returns ErgoTree hex string
 */
export function getReferenceErgoTree(serverAddress: string): string {
  return ergoTreeFromAddress(serverAddress);
}

/**
 * Compute the P2S address from an ErgoTree hex string.
 *
 * @param ergoTreeHex  Hex-encoded ErgoTree bytes
 * @param mainnet      Whether to use mainnet encoding (default true)
 * @returns Base58-encoded P2S address
 */
export function contractAddress(
  ergoTreeHex: string,
  mainnet = true,
): string {
  const network = mainnet ? Network.Mainnet : Network.Testnet;
  const addr = ErgoAddress.fromErgoTree(ergoTreeHex, network);
  return addr.encode(network);
}

// ---------------------------------------------------------------------------
// Pre-compiled ErgoTree cache
// ---------------------------------------------------------------------------

/**
 * Cache for pre-compiled ErgoTree hex strings.
 *
 * When a node is not available (e.g., offline testing), pre-compiled
 * ErgoTrees can be loaded from a config file and set here. Runtime
 * compilation results are also cached to avoid redundant node calls.
 */
const ergoTreeCache = new Map<string, string>();

/**
 * Cache key for the subscription contract with a given server pubkey.
 */
function subscriptionCacheKey(serverPubKeyHex: string): string {
  return `subscription:${serverPubKeyHex}`;
}

/**
 * Get a cached ErgoTree for the subscription contract, or compile it.
 *
 * @param nodeUrl          Ergo node URL
 * @param serverPubKeyHex  Server compressed public key (66 hex chars)
 * @param apiKey           Optional node API key
 * @returns ErgoTree hex string
 */
export async function getOrCompileSubscriptionErgoTree(
  nodeUrl: string,
  serverPubKeyHex: string,
  apiKey?: string,
): Promise<string> {
  const key = subscriptionCacheKey(serverPubKeyHex);
  const cached = ergoTreeCache.get(key);
  if (cached) return cached;

  const ergoTree = await compileSubscriptionContract(
    nodeUrl,
    serverPubKeyHex,
    apiKey,
  );
  ergoTreeCache.set(key, ergoTree);
  return ergoTree;
}

/**
 * Set a pre-compiled ErgoTree for the subscription contract.
 * Used when loading from config files or for testing.
 *
 * @param serverPubKeyHex  Server compressed public key (66 hex chars)
 * @param ergoTreeHex      Pre-compiled ErgoTree hex
 */
export function setSubscriptionErgoTree(
  serverPubKeyHex: string,
  ergoTreeHex: string,
): void {
  const key = subscriptionCacheKey(serverPubKeyHex);
  ergoTreeCache.set(key, ergoTreeHex);
}

/**
 * Clear the ErgoTree cache. Primarily for testing.
 */
export function clearErgoTreeCache(): void {
  ergoTreeCache.clear();
}
