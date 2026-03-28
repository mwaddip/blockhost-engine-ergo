/**
 * Subscription withdrawal step for the fund cycle (Ergo).
 *
 * Delegates to executeWithdraw() from bw/commands/withdraw.ts which handles:
 *   - Finding subscription boxes by ErgoTree
 *   - Analyzing claimability (interval elapsed, amount remaining)
 *   - Building batch transactions with continuing outputs
 *   - Signing and submitting via the Ergo node
 *
 * This module is a thin wrapper that the fund-manager index calls.
 */

import type { Addressbook } from "./types.js";
import { executeWithdraw } from "../bw/commands/withdraw.js";

/**
 * Run the fund cycle withdrawal step.
 *
 * Collects earned payments from subscription boxes and sends them
 * to the hot wallet.
 *
 * @param book  Addressbook (must contain "server" with keyfile and "hot")
 */
export async function runWithdrawal(book: Addressbook): Promise<void> {
  console.log("[FUND] Running subscription withdrawal...");

  if (!book["server"]?.keyfile) {
    console.error("[FUND] Cannot collect: server wallet has no keyfile");
    return;
  }

  if (!book["hot"]?.address) {
    console.error("[FUND] Cannot collect: hot wallet not configured");
    return;
  }

  try {
    await executeWithdraw("hot", book);
    console.log("[FUND] Subscription withdrawal complete");
  } catch (err) {
    console.error(`[FUND] Subscription withdrawal failed: ${err}`);
  }
}
