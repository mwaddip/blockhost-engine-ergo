/**
 * NFT holder lookup for Ergo.
 *
 * On Ergo, tokens don't have a "policy ID" — each token is uniquely
 * identified by a 64-char hex token ID (= the box ID of the first input
 * in the minting transaction).
 *
 * To find the current holder of an NFT, we query the explorer for the
 * token's information and then look up which boxes hold it. The holder's
 * address is derived from the box's ErgoTree.
 */

import * as fs from "fs";
import type { ErgoProvider } from "../ergo/provider.js";
import { ErgoAddress, Network } from "@fleet-sdk/core";
import { TESTING_MODE_FILE } from "../paths.js";

// ---------------------------------------------------------------------------
// NFT holder lookup
// ---------------------------------------------------------------------------

/**
 * Find the current holder of an Ergo NFT (token with amount = 1).
 *
 * Strategy:
 *   1. Query the explorer for the token metadata to verify it exists
 *   2. Query the explorer for boxes containing the token
 *   3. Extract the address from the box's ErgoTree
 *
 * @param tokenId  The 64-char hex token ID
 * @param provider ErgoProvider instance (with explorer access)
 * @returns The Base58 Ergo address of the holder, or null if not found
 */
export async function findNftHolder(
  tokenId: string,
  provider: ErgoProvider,
): Promise<string | null> {
  try {
    // Use the explorer to find who holds this token.
    // The explorer /api/v1/tokens/{tokenId} gives us the issuance box,
    // but we need the current holder. We search for unspent boxes
    // containing this token by querying the node's box-by-token endpoint
    // or the explorer's token holders endpoint.
    //
    // Approach: get token info, then check balance of known addresses.
    // For a simple lookup, we use the explorer's boxes/byTokenId endpoint.
    const tokenInfo = await provider.getToken(tokenId);
    if (!tokenInfo) return null;

    // The token exists — now find unspent boxes containing it.
    // We use a targeted search: query the explorer for boxes containing
    // this specific token ID.
    // Since our provider doesn't have a dedicated "boxes by token" endpoint,
    // we'll use the approach of checking the issuance box first, then
    // following the spending chain via the explorer.
    //
    // Simplified approach: query the explorer for the token and derive
    // the holder from the box metadata returned.
    // For now, use the explorer's balance endpoint if we track known addresses.
    // In practice, the explorer v1 API provides a /boxes/byTokenId endpoint.
    const box = await findBoxByToken(tokenId, provider);
    if (!box) return null;

    // Derive address from ErgoTree, respecting network from .testing-mode
    const isTestnet = fs.existsSync(TESTING_MODE_FILE);
    const network = isTestnet ? Network.Testnet : Network.Mainnet;
    try {
      const addr = ErgoAddress.fromErgoTree(box.ergoTree, network);
      return addr.encode(network);
    } catch {
      console.warn(
        `[NFT] Cannot derive address from ErgoTree for token ${tokenId}`,
      );
      return null;
    }
  } catch (err) {
    console.warn(
      `[NFT] Error finding holder for token ${tokenId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: find box containing a specific token
// ---------------------------------------------------------------------------

interface BoxWithErgoTree {
  boxId: string;
  ergoTree: string;
}

/**
 * Find an unspent box that contains a specific token.
 *
 * Uses the provider's getBoxesByTokenId method which queries the explorer's
 * /api/v1/boxes/byTokenId/{tokenId}/unspent endpoint.
 */
async function findBoxByToken(
  tokenId: string,
  provider: ErgoProvider,
): Promise<BoxWithErgoTree | null> {
  try {
    const boxes = await provider.getBoxesByTokenId(tokenId);
    const box = boxes.find((b) => b.assets.some((a) => a.tokenId === tokenId));
    if (box) {
      return { boxId: box.boxId, ergoTree: box.ergoTree };
    }
  } catch {
    // Explorer query failed
  }

  return null;
}
