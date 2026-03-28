/**
 * bw who <identifier>
 *
 * Query the holder of an Ergo NFT token.
 *
 * Forms:
 *   bw who <token_id>        -- who holds this token? (64-char hex)
 *   bw who <numeric_id>      -- look up NFT by numeric ID
 *   bw who admin             -- who holds the admin NFT? (reads blockhost.yaml)
 *   bw who <msg> <sig>       -- signature recovery (not supported on Ergo)
 *
 * Reads nft-related config from web3-defaults.yaml.
 * Reads admin.credential_nft_id from /etc/blockhost/blockhost.yaml.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { ErgoAddress, Network } from "@fleet-sdk/core";
import { getProviderClient } from "../cli-utils.js";
import { BLOCKHOST_CONFIG_PATH } from "../../paths.js";

// -- Admin NFT ID loader ----------------------------------------------------

function loadAdminNftId(): string {
  if (!fs.existsSync(BLOCKHOST_CONFIG_PATH)) {
    throw new Error(`Config not found: ${BLOCKHOST_CONFIG_PATH}`);
  }

  const raw = yaml.load(
    fs.readFileSync(BLOCKHOST_CONFIG_PATH, "utf8"),
  ) as Record<string, unknown>;

  const admin = raw["admin"] as Record<string, unknown> | undefined;
  if (
    !admin ||
    admin["credential_nft_id"] === undefined ||
    admin["credential_nft_id"] === null
  ) {
    throw new Error("admin.credential_nft_id not set in blockhost.yaml");
  }

  const nftId = String(admin["credential_nft_id"]);
  return nftId;
}

// -- CLI handler ------------------------------------------------------------

export async function whoCommand(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw who <identifier>");
    console.error(
      "  identifier: 64-char hex token ID, numeric ID, or 'admin'",
    );
    process.exit(1);
  }

  const identifier = args[0];
  if (!identifier) {
    console.error("Usage: bw who <identifier>");
    process.exit(1);
  }

  // Check for signature recovery attempt (two args = message + signature)
  if (args.length >= 2) {
    console.error(
      "Signature recovery not supported on Ergo. Use NFT ownership verification instead.",
    );
    process.exit(1);
  }

  let tokenId: string;

  if (identifier === "admin") {
    tokenId = loadAdminNftId();
  } else if (/^[0-9a-fA-F]{64}$/.test(identifier)) {
    // Direct 64-char hex token ID
    tokenId = identifier;
  } else if (/^\d+$/.test(identifier)) {
    // Numeric ID -- would need NFT policy info to map to a token ID
    // For now, try to look up via the blockhost config
    console.error(
      `Numeric NFT IDs require NFT policy configuration. Use the full 64-char hex token ID instead.`,
    );
    process.exit(1);
  } else {
    console.error(
      `Invalid identifier: '${identifier}'. Use a 64-char hex token ID or 'admin'.`,
    );
    process.exit(1);
  }

  const provider = getProviderClient();

  try {
    // Find unspent boxes containing this token
    const boxes = await provider.getBoxesByTokenId(tokenId);
    const box = boxes.find((b) => b.assets.some((a) => a.tokenId === tokenId));

    if (!box) {
      console.error(`No unspent box found holding token ${tokenId}`);
      process.exit(1);
    }

    // Derive the holder address from the box's ErgoTree
    const isTestnet = (await import("fs")).existsSync("/etc/blockhost/.testing-mode");
    const network = isTestnet ? Network.Testnet : Network.Mainnet;
    const addr = ErgoAddress.fromErgoTree(box.ergoTree, network);
    const holderAddress = addr.encode(network);

    console.log(holderAddress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error looking up token ${tokenId}: ${msg}`);
    process.exit(1);
  }
}
