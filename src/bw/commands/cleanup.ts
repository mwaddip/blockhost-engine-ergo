/**
 * bw --debug --cleanup <address>
 *
 * Debug utility -- sweep all ERG from every signing wallet to a target address.
 * Requires both --debug and --cleanup flags as a safety guard.
 *
 * Uses Fleet SDK TransactionBuilder for unsigned tx, Ergo node for signing.
 */

import {
  TransactionBuilder,
  OutputBuilder,
  RECOMMENDED_MIN_FEE_VALUE,
} from "@fleet-sdk/core";
import type { Box, Amount } from "@fleet-sdk/common";
import type { Addressbook } from "../../fund-manager/types.js";
import { isValidAddress } from "../../ergo/address.js";
import { getProviderClient } from "../cli-utils.js";
import { loadPrivateKey } from "../key-utils.js";

export async function cleanupCommand(
  targetAddress: string,
  book: Addressbook,
): Promise<void> {
  if (!isValidAddress(targetAddress)) {
    console.error(`Invalid target address: ${targetAddress}`);
    process.exit(1);
  }

  const signingRoles = Object.entries(book)
    .filter(([, entry]) => Boolean(entry.keyfile))
    .map(([role]) => role);

  if (signingRoles.length === 0) {
    console.log("No signing wallets found in addressbook.");
    return;
  }

  const provider = getProviderClient();

  console.error(
    `Sweeping ERG from ${signingRoles.length} wallet(s) to ${targetAddress}`,
  );

  for (const role of signingRoles) {
    try {
      const { privKeyHex, address } = loadPrivateKey(role, book);

      if (address === targetAddress) {
        console.error(`  ${role}: is the target address, skipping`);
        continue;
      }

      const boxes = await provider.getUnspentBoxes(address);

      if (boxes.length === 0) {
        console.error(
          `  ${role} (${address.slice(0, 25)}...): no boxes, skipping`,
        );
        continue;
      }

      let totalNanoErg = 0n;
      for (const b of boxes) totalNanoErg += b.value;

      if (totalNanoErg <= RECOMMENDED_MIN_FEE_VALUE) {
        console.error(
          `  ${role}: only ${totalNanoErg.toString()} nanoERG, skipping (below dust)`,
        );
        continue;
      }

      // Send everything minus fee
      const sendAmount = totalNanoErg - RECOMMENDED_MIN_FEE_VALUE;
      if (sendAmount <= 0n) {
        console.error(
          `  ${role}: balance too low after fee estimate, skipping`,
        );
        continue;
      }

      console.error(
        `  ${role}: sweeping ${totalNanoErg.toString()} nanoERG (${boxes.length} box(es))`,
      );

      const height = await provider.getHeight();

      const unsignedTx = new TransactionBuilder(height)
        .from(boxes as unknown as Box<Amount>[])
        .to(new OutputBuilder(sendAmount, targetAddress))
        .sendChangeTo(targetAddress)
        .payMinFee()
        .build();

      const signedTx = await provider.signTx(unsignedTx, [privKeyHex]);
      const txId = await provider.submitTx(signedTx);
      console.log(`${role}: ${txId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${role}: failed -- ${msg}`);
    }
  }
}
