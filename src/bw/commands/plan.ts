/**
 * bw plan create <name> <price>
 *
 * Create a plan box at the server's address with plan details in registers:
 *   R4: plan name (Coll[Byte] UTF-8)
 *   R5: price per day in nanoERG (Long)
 *   R6: plan ID (Int)
 *
 * Uses Fleet SDK TransactionBuilder for unsigned tx, Ergo node for signing.
 */

import {
  TransactionBuilder,
  OutputBuilder,
  SAFE_MIN_BOX_VALUE,
} from "@fleet-sdk/core";
import type { Box, Amount } from "@fleet-sdk/common";
import type { Addressbook } from "../../fund-manager/types.js";
import { getProviderClient } from "../cli-utils.js";
import { loadPrivateKey } from "../key-utils.js";
import { encodeString, encodeLong, encodeInt } from "../../ergo/registers.js";
import { allocateCounter } from "../../util/counter.js";
import { STATE_DIR } from "../../paths.js";

const PLAN_ID_FILE = `${STATE_DIR}/next-plan-id`;

// -- CLI handler ------------------------------------------------------------

export async function planCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  const [subCommand, ...rest] = args;

  if (subCommand === "create") {
    await planCreateCommand(rest, book);
    return;
  }

  console.error("Usage: bw plan create <name> <price>");
  console.error("  Example: bw plan create basic 5000000000");
  console.error("  <price> is in nanoERG (or payment token base units) per day");
  process.exit(1);
}

async function planCreateCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  if (args.length < 2) {
    console.error("Usage: bw plan create <name> <price>");
    console.error(
      "  <price> is in nanoERG (or payment token base units) per day",
    );
    process.exit(1);
  }

  const [name, priceStr] = args;
  if (!name || !priceStr) {
    console.error("Usage: bw plan create <name> <price>");
    process.exit(1);
  }

  const pricePerDay = BigInt(priceStr);

  // Determine signing role
  const signingRole =
    book["server"]?.keyfile
      ? "server"
      : Object.entries(book).find(([, e]) => e.keyfile)?.[0];
  if (!signingRole) {
    throw new Error("No signing wallet available in addressbook");
  }

  const { privKeyHex, address: serverAddress } = loadPrivateKey(
    signingRole,
    book,
  );
  const provider = getProviderClient();

  // Auto-increment plan ID
  const planId = await allocateCounter(PLAN_ID_FILE);

  // Encode registers
  // R4: plan name (Coll[Byte] UTF-8)
  // R5: price per day (Long)
  // R6: plan ID (Int)
  const registers: Record<string, string> = {
    R4: encodeString(name),
    R5: encodeLong(pricePerDay),
    R6: encodeInt(planId),
  };

  // Get current height and server's boxes
  const height = await provider.getHeight();
  const inputs = await provider.getUnspentBoxes(serverAddress);

  if (inputs.length === 0) {
    throw new Error(
      `No unspent boxes found for ${signingRole} (${serverAddress})`,
    );
  }

  // Build the plan box at the server's address
  const planOutput = new OutputBuilder(SAFE_MIN_BOX_VALUE, serverAddress)
    .setAdditionalRegisters(registers);

  const unsignedTx = new TransactionBuilder(height)
    .from(inputs as unknown as Box<Amount>[])
    .to(planOutput)
    .sendChangeTo(serverAddress)
    .payMinFee()
    .build();

  // Sign via ergo-relay — pass full input boxes for signing context
  const signedTx = await provider.signTx(unsignedTx, [privKeyHex], inputs);
  const txId = await provider.submitTx(signedTx);

  console.log(txId);
  console.error(
    `Plan "${name}" created: id=${planId}, price=${pricePerDay.toString()}/day`,
  );
}
