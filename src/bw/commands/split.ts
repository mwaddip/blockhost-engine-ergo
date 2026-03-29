/**
 * bw split <amount> <token> <ratios> <from> <to1> <to2> ...
 *
 * Split an ERG or native token amount from a signing wallet to multiple
 * recipients according to a ratio string (e.g. "60/40" or "50/30/20").
 *
 * Ratios must be positive integers that sum to 100.
 * The last recipient receives any rounding dust.
 *
 * Builds a single multi-output transaction for atomicity and lower fees.
 */

import {
  TransactionBuilder,
  OutputBuilder,
  SAFE_MIN_BOX_VALUE,
} from "@fleet-sdk/core";
import type { Addressbook } from "../../fund-manager/types.js";
import {
  resolveAddress,
  resolveToken,
  formatErg,
  formatToken,
  getProviderClient,
} from "../cli-utils.js";
import { loadPrivateKey } from "../key-utils.js";

/**
 * CLI handler
 */
export async function splitCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  if (args.length < 5) {
    console.error(
      "Usage: bw split <amount> <token> <ratios> <from> <to1> <to2> ...",
    );
    console.error("  Example: bw split 10 erg 60/40 hot dev broker");
    console.error("  Example: bw split 100 stable 50/50 hot dev admin");
    process.exit(1);
  }

  const [amountStr, tokenArg, ratiosStr, fromRole, ...recipientRoles] = args;
  if (!amountStr || !tokenArg || !ratiosStr || !fromRole) {
    console.error(
      "Usage: bw split <amount> <token> <ratios> <from> <to1> <to2> ...",
    );
    process.exit(1);
  }

  const amount = parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(`Invalid amount: ${amountStr}`);
    process.exit(1);
  }

  // Parse ratios
  const ratios = ratiosStr.split("/").map(Number);
  if (ratios.some(isNaN) || ratios.some((r) => r <= 0)) {
    console.error(
      `Invalid ratios: ${ratiosStr}. Use format like 60/40 or 50/30/20`,
    );
    process.exit(1);
  }

  const ratioSum = ratios.reduce((a, b) => a + b, 0);
  if (ratioSum !== 100) {
    console.error(`Ratios must sum to 100, got ${ratioSum}`);
    process.exit(1);
  }

  if (ratios.length !== recipientRoles.length) {
    console.error(
      `Number of ratios (${ratios.length}) must match number of recipients (${recipientRoles.length})`,
    );
    process.exit(1);
  }

  // Resolve token and addresses
  const tokenId = resolveToken(tokenArg);
  const isErg = tokenId === "";
  const recipients: string[] = [];
  for (const role of recipientRoles) {
    recipients.push(resolveAddress(role, book));
  }

  const { privKeyHex, address: fromAddress } = loadPrivateKey(fromRole, book);
  const provider = getProviderClient();

  // Parse total into base units for precise splitting
  // ERG: 9 decimal places; tokens: 0 (base units)
  const decimals = isErg ? 9 : 0;
  const totalBaseUnits = parseAmountToBaseUnits(amountStr, decimals);

  console.log(
    `Splitting ${isErg ? formatErg(totalBaseUnits) : formatToken(totalBaseUnits, decimals)} from ${fromRole}:`,
  );

  // Get current height and sender's boxes
  const height = await provider.getHeight();
  const inputs = await provider.getUnspentBoxes(fromAddress);

  if (inputs.length === 0) {
    throw new Error(`No unspent boxes found for ${fromRole} (${fromAddress})`);
  }

  // Build multi-output transaction
  const txBuilder = new TransactionBuilder(height).from(inputs);

  let remaining = totalBaseUnits;
  for (let i = 0; i < recipients.length; i++) {
    const ratio = ratios[i];
    const recipientRole = recipientRoles[i];
    const recipientAddr = recipients[i];
    if (ratio === undefined || !recipientRole || !recipientAddr) continue;

    const isLast = i === recipients.length - 1;
    const share = isLast
      ? remaining
      : (totalBaseUnits * BigInt(ratio)) / 100n;
    remaining -= share;

    const display = isErg
      ? formatErg(share)
      : formatToken(share, decimals);
    console.log(`  ${recipientRole}: ${display}`);

    if (isErg) {
      txBuilder.to(new OutputBuilder(share, recipientAddr));
    } else {
      txBuilder.to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, recipientAddr)
          .addTokens({ tokenId, amount: share }),
      );
    }
  }

  const unsignedTx = txBuilder
    .sendChangeTo(fromAddress)
    .payMinFee()
    .build();

  // Sign via ergo-relay — pass full input boxes for signing context
  const signedTx = await provider.signTx(unsignedTx, [privKeyHex], inputs);
  const txId = await provider.submitTx(signedTx);
  console.log(txId);
  console.log("Done.");
}

// -- Helpers ----------------------------------------------------------------

/**
 * Parse a human-readable amount string into base units.
 *
 * "1.5" with decimals=9 -> 1_500_000_000n
 * "100" with decimals=0 -> 100n
 */
function parseAmountToBaseUnits(amountStr: string, decimals: number): bigint {
  const parts = amountStr.split(".");
  const wholePart = parts[0] ?? "0";
  const fracPart = (parts[1] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(wholePart) * BigInt(10 ** decimals) + BigInt(fracPart || "0");
}
