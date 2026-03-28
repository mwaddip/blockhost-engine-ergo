#!/usr/bin/env -S npx tsx

/**
 * Deploy subscription contracts to the Ergo blockchain.
 *
 * Compiles the subscription guard script using the Ergo node's compiler
 * endpoint, optionally creates an initial config box on-chain, and writes
 * the compiled ErgoTree identifiers to a local config file for runtime use.
 *
 * Usage:
 *   npx tsx scripts/deploy-contracts.ts [--dry-run]
 *
 * Environment:
 *   DEPLOYER_KEY_FILE  — path to the deployer/server private key file
 *                        (default: /etc/blockhost/deployer.key)
 *   NODE_API_KEY       — Ergo node API key (required for /script/p2sAddress)
 *
 * The script reads network config from web3-defaults.yaml (node URL, explorer,
 * network type) and derives the server address from the deployer key.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";

import { loadNetworkConfig } from "../src/fund-manager/web3-config.js";
import {
  addressFromPrivateKey,
  publicKeyFromAddress,
} from "../src/ergo/address.js";
import {
  compileToP2SAddress,
  getSubscriptionScript,
  getReferenceScript,
  contractAddress,
  setSubscriptionErgoTree,
} from "../src/ergo/contracts.js";
import { ergoTreeFromAddress } from "../src/ergo/address.js";
import { CONFIG_DIR } from "../src/paths.js";

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

const CONTRACT_CONFIG_PATH = `${CONFIG_DIR}/contracts.yaml`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("[dry-run] No on-chain transactions will be submitted.\n");
  }

  // -- Load deployer key --------------------------------------------------

  const keyPath =
    process.env["DEPLOYER_KEY_FILE"] ?? `${CONFIG_DIR}/deployer.key`;
  if (!fs.existsSync(keyPath)) {
    console.error(`Error: Deployer key file not found: ${keyPath}`);
    console.error(
      "Set DEPLOYER_KEY_FILE env var or place key at the default path.",
    );
    process.exit(1);
  }
  const privKeyHex = fs.readFileSync(keyPath, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(privKeyHex)) {
    console.error("Error: Deployer key must be a 64 hex char private key.");
    process.exit(1);
  }

  // -- Load network config ------------------------------------------------

  const { nodeUrl, network } = loadNetworkConfig();
  const mainnet = network === "mainnet";
  const apiKey = process.env["NODE_API_KEY"] ?? "";

  console.log(`Network:  ${network}`);
  console.log(`Node URL: ${nodeUrl}`);

  // -- Derive server identity ---------------------------------------------

  const serverAddress = addressFromPrivateKey(privKeyHex, mainnet);
  const serverPubKeyHex = publicKeyFromAddress(serverAddress);

  console.log(`Server address: ${serverAddress}`);
  console.log(`Server pubkey:  ${serverPubKeyHex}`);
  console.log();

  // -- Compile subscription contract --------------------------------------

  console.log("Compiling subscription guard script...");
  const subscriptionSource = getSubscriptionScript(serverPubKeyHex);

  if (dryRun) {
    console.log("[dry-run] ErgoScript source:");
    console.log("─".repeat(60));
    console.log(subscriptionSource);
    console.log("─".repeat(60));
    console.log();
  }

  const subscriptionP2S = await compileToP2SAddress(
    nodeUrl,
    subscriptionSource,
    apiKey || undefined,
  );
  const subscriptionErgoTree = ergoTreeFromAddress(subscriptionP2S);
  const subscriptionAddress = contractAddress(subscriptionErgoTree, mainnet);

  console.log(`Subscription P2S address:  ${subscriptionAddress}`);
  console.log(`Subscription ErgoTree:     ${subscriptionErgoTree.slice(0, 40)}...`);
  console.log(`Subscription ErgoTree len: ${subscriptionErgoTree.length / 2} bytes`);
  console.log();

  // Cache it for runtime use
  setSubscriptionErgoTree(serverPubKeyHex, subscriptionErgoTree);

  // -- Compile reference guard (just for verification) --------------------

  console.log("Compiling reference guard script...");
  const referenceSource = getReferenceScript(serverPubKeyHex);
  const referenceP2S = await compileToP2SAddress(
    nodeUrl,
    referenceSource,
    apiKey || undefined,
  );
  const referenceErgoTree = ergoTreeFromAddress(referenceP2S);
  const referenceAddress = contractAddress(referenceErgoTree, mainnet);

  console.log(`Reference P2S address: ${referenceAddress}`);
  console.log(`Reference ErgoTree:    ${referenceErgoTree}`);
  console.log();

  // Verify: the reference script should resolve to the server's P2PK ErgoTree
  const serverErgoTree = ergoTreeFromAddress(serverAddress);
  const referenceIsP2PK = referenceErgoTree === serverErgoTree;
  if (referenceIsP2PK) {
    console.log(
      "Reference guard matches server P2PK (expected for proveDlog(serverPk)).",
    );
  } else {
    console.log(
      "Note: Reference guard differs from raw P2PK. This is expected if the",
    );
    console.log(
      "node wraps it in a P2S structure rather than collapsing to P2PK.",
    );
  }
  console.log();

  // -- Write config -------------------------------------------------------

  const config = {
    server: {
      address: serverAddress,
      pubkey: serverPubKeyHex,
    },
    contracts: {
      subscription: {
        ergoTree: subscriptionErgoTree,
        address: subscriptionAddress,
      },
      reference: {
        ergoTree: referenceErgoTree,
        address: referenceAddress,
      },
    },
    network,
    compiled_at: new Date().toISOString(),
  };

  if (dryRun) {
    console.log("[dry-run] Would write to:", CONTRACT_CONFIG_PATH);
    console.log(yaml.dump(config));
  } else {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONTRACT_CONFIG_PATH, yaml.dump(config), "utf8");
    console.log(`Contract config written to: ${CONTRACT_CONFIG_PATH}`);
  }

  console.log("\nDone.");
}

main().catch((err: unknown) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
