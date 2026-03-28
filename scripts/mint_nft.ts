#!/usr/bin/env -S npx tsx
/**
 * blockhost-mint-nft -- Mint an EIP-4 access credential NFT on Ergo.
 *
 * Called by the provisioner after VM creation to issue an NFT that
 * carries the encrypted connection details for the subscriber.
 *
 * On Ergo, token ID = first input box ID. The NFT is minted with amount=1
 * using Fleet SDK's TransactionBuilder + OutputBuilder.mintToken().
 *
 * Registers (EIP-4):
 *   R4: name (set by mintToken)
 *   R5: description (set by mintToken)
 *   R6: decimals (set by mintToken)
 *   R7: type marker (0x01 0x01 = NFT/general asset)
 *   R8: userEncrypted (encrypted connection details)
 *
 * Usage:
 *   blockhost-mint-nft --owner-wallet <ergo-address>
 *   blockhost-mint-nft --owner-wallet <ergo-address> --user-encrypted <hex>
 *   blockhost-mint-nft --owner-wallet <ergo-address> --user-encrypted <hex> --dry-run
 *
 * stdout: token ID (64-char hex) on success
 * stderr: progress / error messages
 * Exit: 0 = success, 1 = failure
 */

import * as fs from "node:fs";
import { isValidAddress, addressFromPrivateKey } from "../src/ergo/address.js";
import { createProvider } from "../src/ergo/provider.js";
import { loadNetworkConfig } from "../src/fund-manager/web3-config.js";
import { mintNft } from "../src/nft/mint.js";
import { CONFIG_DIR, STATE_DIR } from "../src/paths.js";

// -- Constants ---------------------------------------------------------------

const DEPLOYER_KEY_PATH = `${CONFIG_DIR}/deployer.key`;
const COUNTER_PATH = `${STATE_DIR}/next-nft-id`;

// -- Types -------------------------------------------------------------------

interface Args {
  ownerWallet: string;
  userEncrypted: string;
  dryRun: boolean;
}

// -- Argument parsing --------------------------------------------------------

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let ownerWallet = "";
  let userEncrypted = "";
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--owner-wallet":
        ownerWallet = argv[++i] ?? "";
        break;
      case "--user-encrypted":
        userEncrypted = argv[++i] ?? "";
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        process.stderr.write(`blockhost-mint-nft: unknown argument: ${argv[i]}\n`);
        process.exit(1);
    }
  }

  if (!ownerWallet) {
    process.stderr.write(
      "blockhost-mint-nft: --owner-wallet is required\n" +
      "Usage: blockhost-mint-nft --owner-wallet <ergo-address> [--user-encrypted <hex>] [--dry-run]\n",
    );
    process.exit(1);
  }

  if (!isValidAddress(ownerWallet)) {
    process.stderr.write(
      "blockhost-mint-nft: --owner-wallet must be a valid Ergo address\n",
    );
    process.exit(1);
  }

  if (userEncrypted && !/^[0-9a-fA-F]+$/.test(userEncrypted)) {
    process.stderr.write("blockhost-mint-nft: --user-encrypted must be a hex string\n");
    process.exit(1);
  }

  return { ownerWallet, userEncrypted, dryRun };
}

// -- Key loading -------------------------------------------------------------

function loadDeployerKey(): string {
  const fromEnv = process.env["DEPLOYER_KEY"];
  if (fromEnv) return fromEnv.trim();

  if (!fs.existsSync(DEPLOYER_KEY_PATH)) {
    process.stderr.write(
      `blockhost-mint-nft: set DEPLOYER_KEY or create ${DEPLOYER_KEY_PATH}\n`,
    );
    process.exit(1);
  }
  const raw = fs.readFileSync(DEPLOYER_KEY_PATH, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    process.stderr.write(
      "blockhost-mint-nft: deployer key must be 64 hex chars (32 bytes)\n",
    );
    process.exit(1);
  }
  return raw;
}

// -- NFT ID counter ----------------------------------------------------------

/**
 * Allocate the next sequential NFT ID (for naming, not for token ID).
 * On Ergo, the actual token ID is the first input box ID, but we keep
 * a counter for human-readable NFT naming ("BlockHost Access #NNN").
 */
function allocateNftNumber(): number {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lockPath = COUNTER_PATH + ".lock";

  let lockFd = -1;
  for (let i = 0; i < 50; i++) {
    try {
      lockFd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      break;
    } catch {
      if (i === 49) {
        try { fs.unlinkSync(lockPath); } catch { /* stale lock */ }
        try {
          lockFd = fs.openSync(
            lockPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          );
        } catch { /* give up */ }
        break;
      }
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) { /* brief spin */ }
    }
  }

  try {
    let current = 1;
    try {
      const raw = fs.readFileSync(COUNTER_PATH, "utf8").trim();
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) current = parsed;
    } catch {
      // File does not exist -- start at 1
    }

    fs.writeFileSync(COUNTER_PATH, String(current + 1), { encoding: "utf8" });
    return current;
  } finally {
    if (lockFd >= 0) try { fs.closeSync(lockFd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const { ownerWallet, userEncrypted, dryRun } = parseArgs();

  // Load config
  const config = loadNetworkConfig();
  const mainnet = config.network === "mainnet";

  // Load deployer key
  const privKeyHex = loadDeployerKey();
  const serverAddress = addressFromPrivateKey(privKeyHex, mainnet);

  process.stderr.write(`Server address: ${serverAddress}\n`);
  process.stderr.write(`Owner wallet:   ${ownerWallet}\n`);
  process.stderr.write(`Network:        ${config.network}\n`);

  // Create provider
  const provider = createProvider(config.nodeUrl, config.explorerUrl, config.nodeApiKey);

  // Get current height
  const currentHeight = await provider.getHeight();
  process.stderr.write(`Current height: ${currentHeight}\n`);

  // Allocate sequential number for naming
  const nftNumber = allocateNftNumber();
  const nftName = `BlockHost Access #${nftNumber.toString().padStart(3, "0")}`;
  const nftDescription = `BlockHost VM access credential #${nftNumber}`;

  process.stderr.write(`NFT name:       ${nftName}\n`);

  if (dryRun) {
    process.stderr.write("[DRY RUN] Would mint -- not broadcasting\n");
    // In dry run, output a placeholder token ID
    process.stdout.write(`dry-run-token-id-placeholder\n`);
    return;
  }

  // Mint the NFT
  process.stderr.write("Building and submitting mint transaction...\n");

  const result = await mintNft({
    ownerAddress: ownerWallet,
    name: nftName,
    description: nftDescription,
    userEncrypted,
    serverAddress,
    serverPrivKeyHex: privKeyHex,
    provider,
    currentHeight,
  });

  process.stderr.write(`Transaction submitted: ${result.txId}\n`);
  process.stderr.write(`Token ID: ${result.tokenId}\n`);

  // Output only the token ID to stdout for machine consumption
  process.stdout.write(`${result.tokenId}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `blockhost-mint-nft: ${String(err instanceof Error ? err.message : err)}\n`,
  );
  process.exit(1);
});
