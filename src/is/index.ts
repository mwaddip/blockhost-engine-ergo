#!/usr/bin/env node
/**
 * is (identity predicate) CLI -- yes/no identity questions via exit code
 *
 * Usage:
 *   is <wallet> <nft_id>         Does wallet hold NFT token ID?
 *   is contract <address>        Does a subscription contract have live boxes?
 *
 * Exit: 0 = yes, 1 = no
 *
 * Arguments are order-independent, disambiguated by type:
 *   Address: Ergo Base58 (9... mainnet or 3... testnet)
 *   NFT ID: 64-char hex token ID
 *   "contract": literal keyword
 *
 * Config from web3-defaults.yaml (node_url, explorer_url, network).
 */

import { isValidAddress, ergoTreeFromAddress } from "../ergo/address.js";
import { getProviderClient } from "../bw/cli-utils.js";

/** Ergo token IDs are 64 hex chars. */
function isTokenId(arg: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(arg);
}

function printUsage(): void {
  console.error("is -- identity predicate (exit 0 = yes, 1 = no)");
  console.error("");
  console.error("Usage:");
  console.error(
    "  is <wallet> <nft_id>       Does wallet hold NFT token?",
  );
  console.error(
    "  is contract <address>      Does an address have unspent boxes on-chain?",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (
    argv.length === 0 ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  // Form: is contract <address>
  if (argv.includes("contract")) {
    const other = argv.filter((a) => a !== "contract");
    if (other.length !== 1 || !other[0] || !isValidAddress(other[0])) {
      console.error("Usage: is contract <address>");
      process.exit(1);
    }
    const address = other[0];
    const provider = getProviderClient();
    try {
      const ergoTree = ergoTreeFromAddress(address);
      const boxes = await provider.getUnspentBoxesByErgoTree(ergoTree);
      process.exit(boxes.length > 0 ? 0 : 1);
    } catch {
      process.exit(1);
    }
  }

  if (argv.length !== 2) {
    printUsage();
    process.exit(1);
  }

  const [arg1, arg2] = argv;
  if (!arg1 || !arg2) {
    printUsage();
    process.exit(1);
  }

  // Form: is <wallet> <nft_id>  (order-independent)
  let walletAddr: string | null = null;
  let tokenId: string | null = null;
  if (isValidAddress(arg1) && isTokenId(arg2)) {
    walletAddr = arg1;
    tokenId = arg2;
  } else if (isValidAddress(arg2) && isTokenId(arg1)) {
    walletAddr = arg2;
    tokenId = arg1;
  }

  if (walletAddr && tokenId) {
    const provider = getProviderClient();

    try {
      // Find the unspent box currently holding the token. /tokens/{id} returns
      // the issuance box, which is fixed at mint and lies after any transfer.
      const boxes = await provider.getBoxesByTokenId(tokenId);
      const holder = boxes.find((b) => b.assets.some((a) => a.tokenId === tokenId));
      if (!holder) {
        process.exit(1);
      }
      const walletErgoTree = ergoTreeFromAddress(walletAddr);
      process.exit(
        holder.ergoTree.toLowerCase() === walletErgoTree.toLowerCase() ? 0 : 1,
      );
    } catch {
      process.exit(1);
    }
  }

  console.error("Error: could not parse arguments. See 'is --help'.");
  process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
