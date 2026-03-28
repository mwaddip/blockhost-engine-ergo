/**
 * bw swap <amount> <from-token> erg <wallet>
 *
 * Swap native tokens for ERG via a DEX aggregator.
 *
 * Stub: DEX integration not yet implemented for Ergo.
 * Will require integration with an Ergo DEX (e.g. Spectrum/ErgoDEX).
 */

import type { Addressbook } from "../../fund-manager/types.js";

/**
 * CLI handler
 */
export async function swapCommand(
  args: string[],
  _book: Addressbook,
): Promise<void> {
  if (args.length < 4) {
    console.error("Usage: bw swap <amount> <from-token> erg <wallet>");
    console.error("  Example: bw swap 100 stable erg hot");
    process.exit(1);
  }

  const [amountStr, fromTokenArg, toTokenArg, walletRole] = args;
  if (!amountStr || !fromTokenArg || !toTokenArg || !walletRole) {
    console.error("Usage: bw swap <amount> <from-token> erg <wallet>");
    process.exit(1);
  }

  if (toTokenArg.toLowerCase() !== "erg") {
    console.error(`Only 'erg' is supported as to-token, got: ${toTokenArg}`);
    process.exit(1);
  }

  console.error("DEX swap not yet implemented for Ergo");
  process.exit(1);
}
