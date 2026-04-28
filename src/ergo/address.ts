/**
 * Ergo address validation and encoding utilities.
 *
 * Ergo P2PK address format:
 *   Head byte: networkPrefix + addressType (mainnet P2PK: 0x01, testnet P2PK: 0x11)
 *   Body: compressed public key (33 bytes)
 *   Checksum: first 4 bytes of blake2b256(headByte + body)
 *   Encoded: Base58(headByte + body + checksum)
 *
 * P2PK ErgoTree format: 0008cd + compressed public key hex (33 bytes = 66 hex chars)
 */

import { ErgoAddress, Network, validateAddress } from "@fleet-sdk/core";
import { secp256k1 } from "@noble/curves/secp256k1";

/**
 * Validate an Ergo address (any type, any network).
 * Returns true if the address is a well-formed Ergo address.
 */
export function isValidAddress(address: string): boolean {
  try {
    return validateAddress(address);
  } catch {
    return false;
  }
}

/**
 * Derive an Ergo P2PK address from a compressed public key hex string.
 * @param pubKeyHex Compressed public key (66 hex chars = 33 bytes)
 * @param mainnet  Whether to encode for mainnet (default true)
 */
export function addressFromPublicKey(pubKeyHex: string, mainnet = true): string {
  const network = mainnet ? Network.Mainnet : Network.Testnet;
  const addr = ErgoAddress.fromPublicKey(pubKeyHex, network);
  return addr.encode(network);
}

/**
 * Derive an Ergo P2PK address from a 32-byte private key hex string.
 * Uses secp256k1 to derive the compressed public key, then encodes as address.
 * @param privKeyHex Private key (64 hex chars = 32 bytes)
 * @param mainnet   Whether to encode for mainnet (default true)
 */
export function addressFromPrivateKey(privKeyHex: string, mainnet = true): string {
  const pubKeyBytes = secp256k1.getPublicKey(privKeyHex, true);
  const pubKeyHex = Buffer.from(pubKeyBytes).toString("hex");
  return addressFromPublicKey(pubKeyHex, mainnet);
}

/**
 * Get the ErgoTree hex string for an Ergo address.
 * For P2PK addresses this is "0008cd" + compressed public key hex.
 * For other address types, Fleet SDK derives the full ErgoTree.
 */
export function ergoTreeFromAddress(address: string): string {
  const addr = ErgoAddress.fromBase58(address);
  return addr.ergoTree;
}

/** Extract the compressed public key hex from a P2PK address */
export function publicKeyFromAddress(address: string): string {
  const tree = ergoTreeFromAddress(address);
  if (tree.startsWith("0008cd") && tree.length === 72) {
    return tree.slice(6);
  }
  throw new Error("Not a P2PK address — cannot extract public key");
}
