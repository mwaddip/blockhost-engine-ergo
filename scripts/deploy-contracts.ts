#!/usr/bin/env -S npx tsx

/**
 * Generate contract configuration for the Ergo engine.
 *
 * Derives the subscription guard ErgoTree from the pre-compiled template
 * by substituting the server's public key. No Ergo node, JRE, or compiler
 * needed — pure byte-level constant substitution.
 *
 * Usage:
 *   npx tsx scripts/deploy-contracts.ts [--dry-run]
 *
 * Environment:
 *   DEPLOYER_KEY_FILE — path to the deployer/server private key file
 *                       (default: /etc/blockhost/deployer.key)
 */

import * as fs from "fs";
import * as yaml from "js-yaml";

import { loadNetworkConfig } from "../src/fund-manager/web3-config.js";
import {
  addressFromPrivateKey,
  publicKeyFromAddress,
  ergoTreeFromAddress,
} from "../src/ergo/address.js";
import {
  getSubscriptionErgoTree,
  getReferenceErgoTree,
  contractAddress,
  SUBSCRIPTION_ERGO_TREE_TEMPLATE,
} from "../src/ergo/contracts.js";
import { CONFIG_DIR } from "../src/paths.js";

// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  if (dryRun) {
    console.log("[dry-run] No files will be written.\n");
  }

  // -- Load deployer key ---------------------------------------------------

  const keyPath = process.env["DEPLOYER_KEY_FILE"] ?? "/etc/blockhost/deployer.key";
  if (!fs.existsSync(keyPath)) {
    console.error(`Deployer key not found: ${keyPath}`);
    console.error("Set DEPLOYER_KEY_FILE or place the key at the default path.");
    process.exit(1);
  }
  const privKeyHex = fs.readFileSync(keyPath, "utf8").trim();

  // -- Load network config -------------------------------------------------

  const config = loadNetworkConfig();
  const mainnet = config.network === "mainnet";

  const serverAddress = addressFromPrivateKey(privKeyHex, mainnet);
  const serverPubKeyHex = publicKeyFromAddress(serverAddress);

  console.error(`Network:        ${config.network}`);
  console.error(`Server address: ${serverAddress}`);
  console.error(`Server pubkey:  ${serverPubKeyHex}`);

  // -- Derive subscription ErgoTree from template --------------------------

  console.error("Deriving subscription guard ErgoTree from template...");
  console.error(`Template size: ${SUBSCRIPTION_ERGO_TREE_TEMPLATE.length / 2} bytes`);

  const subscriptionErgoTree = getSubscriptionErgoTree(serverPubKeyHex);
  const subscriptionAddress = contractAddress(subscriptionErgoTree, mainnet);

  console.error(`Subscription P2S address:  ${subscriptionAddress}`);
  console.error(`Subscription ErgoTree len: ${subscriptionErgoTree.length / 2} bytes`);

  // -- Reference guard (server P2PK) ---------------------------------------

  const referenceErgoTree = getReferenceErgoTree(serverAddress);
  const referenceAddress = contractAddress(referenceErgoTree, mainnet);

  console.error(`Reference P2S address: ${referenceAddress}`);

  // -- Write config --------------------------------------------------------

  const configData = {
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
    network: config.network,
    generated_at: new Date().toISOString(),
  };

  const yamlStr = yaml.dump(configData, { lineWidth: -1 });

  if (dryRun) {
    console.error(`[dry-run] Would write to: ${CONFIG_DIR}/contracts.yaml`);
    console.error(yamlStr);
  } else {
    const outPath = `${CONFIG_DIR}/contracts.yaml`;
    fs.writeFileSync(outPath, yamlStr, "utf8");
    console.error(`Contract config written to: ${outPath}`);
  }

  // Machine-readable output for the wizard (key=value on stdout)
  console.log(`subscription_ergo_tree=${subscriptionErgoTree}`);
  console.log(`subscription_address=${subscriptionAddress}`);
  console.log(`reference_ergo_tree=${referenceErgoTree}`);
  console.error("Done.");
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
