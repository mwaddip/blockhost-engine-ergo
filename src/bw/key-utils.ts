/**
 * Key loading utilities for bw commands.
 *
 * Ergo keyfiles contain a raw 32-byte hex private key (64 chars).
 * The private key is used to derive the public key and address,
 * and is sent to the Ergo node's /wallet/transaction/sign endpoint.
 */

import * as fs from "fs";
import { addressFromPrivateKey } from "../ergo/address.js";
import type { Addressbook } from "../fund-manager/types.js";

export interface KeyInfo {
  privKeyHex: string;
  address: string;
}

/**
 * Load the private key for an addressbook role.
 *
 * @param role  Addressbook role name (e.g. "server", "hot")
 * @param book  Addressbook
 * @returns The hex-encoded private key and derived address
 * @throws If the role has no keyfile or the key is invalid
 */
export function loadPrivateKey(role: string, book: Addressbook): KeyInfo {
  const entry = book[role];
  if (!entry) {
    throw new Error(`Role '${role}' not found in addressbook`);
  }
  if (!entry.keyfile) {
    throw new Error(`Role '${role}' has no keyfile -- cannot sign`);
  }

  const privKeyHex = fs.readFileSync(entry.keyfile, "utf8").trim();

  // Validate: should be 64 hex chars
  if (!/^[0-9a-fA-F]{64}$/.test(privKeyHex)) {
    throw new Error(
      `Invalid private key in keyfile for '${role}': expected 64 hex chars`,
    );
  }

  // Use the address from the addressbook (authoritative) rather than deriving
  // to handle both mainnet and testnet configs
  const address = entry.address;

  return { privKeyHex, address };
}

/**
 * Derive the address from a private key hex string.
 * Used when we need to verify the key matches the addressbook entry.
 */
export function deriveAddress(privKeyHex: string, mainnet = true): string {
  return addressFromPrivateKey(privKeyHex, mainnet);
}
