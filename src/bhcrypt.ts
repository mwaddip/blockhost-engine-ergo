#!/usr/bin/env -S npx tsx
/**
 * bhcrypt — crypto CLI for blockhost-engine-ergo.
 *
 * Subcommand interface backed by src/crypto.ts (native @noble/* crypto).
 *
 * Subcommands:
 *   generate-keypair    <outfile>                    Generate secp256k1 key + Ergo address
 *   generate-mnemonic                                Generate 15-word BIP39 mnemonic
 *   validate-mnemonic   <word1> <word2> ...          Validate BIP39 mnemonic
 *   mnemonic-to-address [--testnet] <word1> <word2> ... Derive Ergo address from mnemonic
 *   encrypt-symmetric   <key-hex> <data>    SHAKE256-keyed AES-256-GCM encryption
 *   decrypt-symmetric   <key-hex> <ciphertext-hex>   Reverse of above
 *   encrypt-asymmetric  <pubkey-hex> <data> ECIES secp256k1 encryption
 *   decrypt-asymmetric  <privkey-hex> <ciphertext-hex> ECIES decryption
 *
 * Key derivation: BIP32 secp256k1 via m/44'/429'/0'/0/0 (EIP-3).
 */

import { eciesDecrypt, eciesEncrypt, symmetricEncrypt, symmetricDecrypt } from "./crypto.js";
import { addressFromPrivateKey } from "./ergo/address.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import * as fs from "node:fs";
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";

const ERGO_PATH = "m/44'/429'/0'/0/0"; // EIP-3

function die(msg: string): never {
  process.stderr.write(`bhcrypt: ${msg}\n`);
  process.exit(1);
}

function requireHex(value: string, label: string): void {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length === 0 || clean.length % 2 !== 0) {
    die(`${label}: invalid hex string`);
  }
}

/**
 * Derive an Ergo private key and address from a BIP39 mnemonic.
 * Uses BIP32 secp256k1 derivation with path m/44'/429'/0'/0/0 (EIP-3).
 */
function deriveErgoKey(mnemonic: string, mainnet = true): { privateKey: string; address: string } {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(ERGO_PATH);
  if (!child.privateKey) {
    throw new Error("Failed to derive private key from mnemonic");
  }
  const privKeyHex = Buffer.from(child.privateKey).toString("hex");
  const address = addressFromPrivateKey(privKeyHex, mainnet);
  return { privateKey: privKeyHex, address };
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] ?? "";

  switch (command) {
    case "generate-keypair": {
      const testnetKp = args.includes("--testnet");
      const outfile = args.filter(a => a !== "--testnet")[1];
      if (!outfile) die("Usage: bhcrypt generate-keypair [--testnet] <outfile>");

      const privKey = secp256k1.utils.randomPrivateKey();
      const privKeyHex = bytesToHex(privKey);
      const address = addressFromPrivateKey(privKeyHex, !testnetKp);

      fs.writeFileSync(outfile, privKeyHex + "\n", { mode: 0o600 });
      process.stdout.write(`${address}\n`);
      break;
    }

    case "generate-mnemonic": {
      // 15-word mnemonic = 160 bits of entropy
      const mnemonic = generateMnemonic(english, 160);
      process.stdout.write(mnemonic + "\n");
      break;
    }

    case "validate-mnemonic": {
      const words = args.slice(1);
      if (words.length === 0) die("Usage: bhcrypt validate-mnemonic <word1> <word2> ...");
      const mnemonic = words.join(" ");
      if (!validateMnemonic(mnemonic, english)) {
        die("invalid mnemonic phrase");
      }
      process.stdout.write("OK\n");
      break;
    }

    case "mnemonic-to-address": {
      const testnetFlag = args.includes("--testnet");
      const words = args.slice(1).filter(w => w !== "--testnet");
      if (words.length === 0) die("Usage: bhcrypt mnemonic-to-address [--testnet] <word1> <word2> ...");
      const mnemonic = words.join(" ");
      if (!validateMnemonic(mnemonic, english)) {
        die("invalid mnemonic phrase");
      }
      const { address } = deriveErgoKey(mnemonic, !testnetFlag);
      process.stdout.write(address + "\n");
      break;
    }

    case "encrypt-symmetric": {
      const keyHex = args[1];
      const plaintext = args[2];
      if (!keyHex || !plaintext) die("Usage: bhcrypt encrypt-symmetric <key-hex> <data>");
      requireHex(keyHex, "key");
      const result = symmetricEncrypt(keyHex, plaintext);
      process.stdout.write(result + "\n");
      break;
    }

    case "decrypt-symmetric": {
      const keyHex = args[1];
      const ciphertextHex = args[2];
      if (!keyHex || !ciphertextHex) die("Usage: bhcrypt decrypt-symmetric <key-hex> <ciphertext-hex>");
      requireHex(keyHex, "key");
      requireHex(ciphertextHex, "ciphertext");
      const result = symmetricDecrypt(keyHex, ciphertextHex);
      process.stdout.write(result + "\n");
      break;
    }

    case "encrypt-asymmetric": {
      const pubKeyHex = args[1];
      const plaintext = args[2];
      if (!pubKeyHex || !plaintext) die("Usage: bhcrypt encrypt-asymmetric <pubkey-hex> <data>");
      requireHex(pubKeyHex, "pubkey");
      const result = eciesEncrypt(pubKeyHex, plaintext);
      process.stdout.write(result + "\n");
      break;
    }

    case "decrypt-asymmetric": {
      const privKeyHex = args[1];
      const ciphertextHex = args[2];
      if (!privKeyHex || !ciphertextHex) die("Usage: bhcrypt decrypt-asymmetric <privkey-hex> <ciphertext-hex>");
      requireHex(privKeyHex, "privkey");
      requireHex(ciphertextHex, "ciphertext");
      const result = eciesDecrypt(privKeyHex, ciphertextHex);
      process.stdout.write(result + "\n");
      break;
    }

    default:
      die(
        `unknown command: ${command || "(none)"}\n` +
        "Usage: bhcrypt <command> [args...]\n" +
        "Commands:\n" +
        "  generate-keypair    <outfile>                    Generate secp256k1 key + Ergo address\n" +
        "  generate-mnemonic                                Generate 15-word BIP39 mnemonic\n" +
        "  validate-mnemonic   <word1> <word2> ...          Validate BIP39 mnemonic\n" +
        "  mnemonic-to-address [--testnet] <word1> <word2> ... Derive Ergo address from mnemonic\n" +
        "  encrypt-symmetric   <key-hex> <data>    Symmetric encryption\n" +
        "  decrypt-symmetric   <key-hex> <ciphertext-hex>   Symmetric decryption\n" +
        "  encrypt-asymmetric  <pubkey-hex> <data> ECIES encryption\n" +
        "  decrypt-asymmetric  <privkey-hex> <ciphertext-hex> ECIES decryption",
      );
  }
}

main();
