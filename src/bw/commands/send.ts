/**
 * bw send <amount> <token> <from> <to>
 *
 * Send ERG or native tokens from a signing wallet to a recipient.
 * Uses Fleet SDK TransactionBuilder for unsigned tx, Ergo node for signing.
 *
 * Core function executeSend() is also used by fund-manager.
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
  getProviderClient,
  parseAmountToBaseUnits,
} from "../cli-utils.js";
import { loadPrivateKey } from "../key-utils.js";

/**
 * Core send operation -- used by both CLI and fund-manager.
 *
 * @param amountStr  Human-readable amount (e.g. "1.5" for 1.5 ERG, or base units for tokens)
 * @param tokenArg   Token shortcut or 64-char hex token ID
 * @param fromRole   Addressbook role (must have keyfile)
 * @param toRole     Addressbook role or Base58 address
 * @param book       Addressbook
 */
export async function executeSend(
  amountStr: string,
  tokenArg: string,
  fromRole: string,
  toRole: string,
  book: Addressbook,
): Promise<string> {
  const tokenId = resolveToken(tokenArg);
  const toAddress = resolveAddress(toRole, book);
  const { privKeyHex, address: fromAddress } = loadPrivateKey(fromRole, book);
  const provider = getProviderClient();

  const isErg = tokenId === "";

  // Get current height and sender's boxes
  const height = await provider.getHeight();
  const inputs = await provider.getUnspentBoxes(fromAddress);

  if (inputs.length === 0) {
    throw new Error(`No unspent boxes found for ${fromRole} (${fromAddress})`);
  }

  let unsignedTx;

  if (isErg) {
    // ERG transfer: amount is in ERG (decimal), convert to nanoERG.
    // String-based parsing (parseAmountToBaseUnits) preserves precision —
    // parseFloat would round past ~7 significant digits.
    const nanoErg = parseAmountToBaseUnits(amountStr, 9);

    unsignedTx = new TransactionBuilder(height)
      .from(inputs)
      .to(new OutputBuilder(nanoErg, toAddress))
      .sendChangeTo(fromAddress)
      .payMinFee()
      .build();
  } else {
    // Token transfer: amount is in base units
    const tokenAmount = BigInt(amountStr);

    unsignedTx = new TransactionBuilder(height)
      .from(inputs)
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, toAddress)
          .addTokens({ tokenId, amount: tokenAmount }),
      )
      .sendChangeTo(fromAddress)
      .payMinFee()
      .build();
  }

  // Sign via ergo-relay — pass full input boxes for signing context
  const signedTx = await provider.signTx(unsignedTx, [privKeyHex], inputs);
  const txId = await provider.submitTx(signedTx);
  return txId;
}

/**
 * CLI handler
 */
export async function sendCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  if (args.length < 4) {
    console.error("Usage: bw send <amount> <token> <from> <to>");
    console.error("  Example: bw send 1.5 erg hot admin");
    console.error("  Example: bw send 100 stable server hot");
    process.exit(1);
  }

  const [amountStr, tokenArg, fromRole, toRole] = args;
  if (!amountStr || !tokenArg || !fromRole || !toRole) {
    console.error("Usage: bw send <amount> <token> <from> <to>");
    process.exit(1);
  }

  const amount = parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(`Invalid amount: ${amountStr}`);
    process.exit(1);
  }

  const txId = await executeSend(amountStr, tokenArg, fromRole, toRole, book);
  console.log(txId);
}
