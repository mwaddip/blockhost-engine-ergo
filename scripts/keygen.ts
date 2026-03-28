#!/usr/bin/env -S npx tsx
/**
 * keygen — Generate an Ergo wallet for BlockHost provisioning.
 *
 * Generates a BIP39 mnemonic (15 words / 160-bit entropy) and derives
 * an Ergo key via BIP-44 path m/44'/429'/0'/0/0 (EIP-3 standard).
 * Called by the root agent's wallet generation action via subprocess.
 *
 * Usage:
 *   keygen [--mainnet | --testnet]
 *
 * stdout: JSON object:
 *   {
 *     "mnemonic":   "word1 word2 ... word15",
 *     "address":    "9f...",
 *     "privateKey": "<64-char hex>"
 *   }
 *
 * Exit: 0 = success, 1 = failure
 */

import { generateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { addressFromPrivateKey } from "../src/ergo/address.js";

/** BIP-44 derivation path for Ergo (coin type 429, per EIP-3) */
const ERGO_PATH = "m/44'/429'/0'/0/0";

function die(msg: string): never {
  process.stderr.write(`keygen: ${msg}\n`);
  process.exit(1);
}

// ── Parse args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let mainnet = true;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--mainnet") {
    mainnet = true;
  } else if (arg === "--testnet") {
    mainnet = false;
  } else {
    die(`unknown argument: ${arg}\nUsage: keygen [--mainnet | --testnet]`);
  }
}

// ── Generate + derive ─────────────────────────────────────────────────────────

try {
  // 160-bit entropy → 15-word mnemonic (standard for Ergo wallets)
  const mnemonic = generateMnemonic(english, 160);
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(ERGO_PATH);

  if (!child.privateKey) {
    die("key derivation failed — no private key at path " + ERGO_PATH);
  }

  const privKeyHex = Buffer.from(child.privateKey).toString("hex");
  const address = addressFromPrivateKey(privKeyHex, mainnet);

  const output = { mnemonic, address, privateKey: privKeyHex };
  process.stdout.write(JSON.stringify(output) + "\n");
} catch (err: unknown) {
  die(String(err instanceof Error ? err.message : err));
}
