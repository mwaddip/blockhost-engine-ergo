/**
 * Native ECIES decrypt + SHAKE256 symmetric encrypt/decrypt.
 *
 * Uses @noble/curves + @noble/hashes directly and Node.js crypto.
 *
 * Wire formats match the signup-template.html browser implementation exactly.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { shake256 } from "@noble/hashes/sha3";
import { hex } from "@fleet-sdk/crypto";
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";

const SERVER_KEY_PATH = "/etc/blockhost/server.key";

// ── Helpers ──────────────────────────────────────────────────────────

/** Decode hex to bytes, defensively stripping a leading "0x" if present. */
export function hexToBytes(input: string): Uint8Array {
  return hex.decode(input.startsWith("0x") ? input.slice(2) : input);
}

const bytesToHex = hex.encode;

// ── ECIES Decrypt ────────────────────────────────────────────────────

/**
 * Decrypt ECIES ciphertext produced by the signup page.
 *
 * Wire format: ephemeralPub(65) + IV(12) + ciphertext + authTag(16)
 * Algorithm:   secp256k1-ECDH -> HKDF-SHA256(32) -> AES-256-GCM
 *
 * @param privateKeyHex - Server private key (hex, no 0x prefix)
 * @param ciphertextHex - Encrypted data (hex, may have 0x prefix)
 * @returns Decrypted plaintext (UTF-8 string)
 */
export function eciesDecrypt(privateKeyHex: string, ciphertextHex: string): string {
  const data = hexToBytes(ciphertextHex);

  if (data.length < 65 + 12 + 16) {
    throw new Error("ECIES ciphertext too short");
  }

  // Parse wire format
  const ephemeralPub = data.slice(0, 65);
  const iv = data.slice(65, 77);
  const ciphertextAndTag = data.slice(77);

  // AES-GCM auth tag is last 16 bytes
  const authTag = ciphertextAndTag.slice(ciphertextAndTag.length - 16);
  const ciphertext = ciphertextAndTag.slice(0, ciphertextAndTag.length - 16);

  // ECDH: derive shared secret X coordinate
  const privKey = hexToBytes(privateKeyHex);
  const sharedPoint = secp256k1.getSharedSecret(privKey, ephemeralPub, false);
  const sharedX = sharedPoint.slice(1, 33);

  // HKDF-SHA256: derive 32-byte encryption key (empty salt, empty info)
  const encryptionKey = hkdf(sha256, sharedX, new Uint8Array(0), new Uint8Array(0), 32);

  // AES-256-GCM decrypt
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString("utf8");
}

// ── ECIES Encrypt ────────────────────────────────────────────────────

/**
 * Encrypt plaintext using ECIES with a recipient's secp256k1 public key.
 *
 * Wire format: ephemeralPub(65) + IV(12) + ciphertext + authTag(16)
 * Algorithm:   secp256k1-ECDH -> HKDF-SHA256(32) -> AES-256-GCM
 *
 * @param publicKeyHex - Recipient public key (hex, uncompressed 65 bytes or compressed 33 bytes)
 * @param plaintext    - Data to encrypt (UTF-8 string)
 * @returns hex string of ephemeralPub + IV + ciphertext + authTag
 */
export function eciesEncrypt(publicKeyHex: string, plaintext: string): string {
  // Generate ephemeral keypair
  const ephemeralPriv = randomBytes(32);
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, false); // uncompressed (65 bytes)

  // ECDH: derive shared secret X coordinate
  const recipientPub = hexToBytes(publicKeyHex);
  const sharedPoint = secp256k1.getSharedSecret(ephemeralPriv, recipientPub, false);
  const sharedX = sharedPoint.slice(1, 33);

  // HKDF-SHA256: derive 32-byte encryption key (empty salt, empty info)
  const encryptionKey = hkdf(sha256, sharedX, new Uint8Array(0), new Uint8Array(0), 32);

  // AES-256-GCM encrypt
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Wire format: ephemeralPub(65) + IV(12) + ciphertext + authTag(16)
  const result = new Uint8Array(65 + 12 + encrypted.length + 16);
  result.set(ephemeralPub, 0);
  result.set(iv, 65);
  result.set(encrypted, 77);
  result.set(authTag, 77 + encrypted.length);

  return bytesToHex(result);
}

// ── Symmetric Encrypt / Decrypt ──────────────────────────────────────

/**
 * Symmetric encrypt using SHAKE256-derived key + AES-256-GCM.
 *
 * Key derivation: shake256(signatureBytes, {dkLen: 32})
 * Wire format:    IV(12) + ciphertext + authTag(16)
 *
 * @param signatureHex - User signature (hex, may have 0x prefix)
 * @param plaintext    - Data to encrypt (UTF-8 string)
 * @returns 0x-prefixed hex of IV + ciphertext + authTag
 */
export function symmetricEncrypt(signatureHex: string, plaintext: string): string {
  const signatureBytes = hexToBytes(signatureHex);
  const key = shake256(signatureBytes, { dkLen: 32 });

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const result = new Uint8Array(12 + encrypted.length + 16);
  result.set(iv, 0);
  result.set(encrypted, 12);
  result.set(authTag, 12 + encrypted.length);

  return "0x" + bytesToHex(result);
}

/**
 * Symmetric decrypt using SHAKE256-derived key + AES-256-GCM.
 *
 * Wire format: IV(12) + ciphertext + authTag(16)
 *
 * @param signatureHex  - User signature (hex, may have 0x prefix)
 * @param ciphertextHex - Encrypted data (hex, may have 0x prefix)
 * @returns Decrypted plaintext (UTF-8 string)
 */
export function symmetricDecrypt(signatureHex: string, ciphertextHex: string): string {
  const signatureBytes = hexToBytes(signatureHex);
  const key = shake256(signatureBytes, { dkLen: 32 });

  const data = hexToBytes(ciphertextHex);

  if (data.length < 12 + 16) {
    throw new Error("Symmetric ciphertext too short");
  }

  const iv = data.slice(0, 12);
  const authTag = data.slice(data.length - 16);
  const ciphertext = data.slice(12, data.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString("utf8");
}

// ── Server Key ───────────────────────────────────────────────────────

/**
 * Load the server's secp256k1 private key from /etc/blockhost/server.key.
 *
 * @returns Raw hex private key (32 bytes, no 0x prefix)
 */
export function loadServerPrivateKey(): string {
  const raw = fs.readFileSync(SERVER_KEY_PATH, "utf8").trim();
  return raw.startsWith("0x") ? raw.slice(2) : raw;
}
