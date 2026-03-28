/**
 * bw set encrypt <nft_id> <data>
 *
 * Update NFT reference data by spending the reference box holding the
 * NFT reference data and creating a new box with updated R8 (userEncrypted).
 *
 * The reference box is a server-guarded P2PK box. The server's private key
 * is used to sign the spending transaction.
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
import type { ErgoBox } from "../../ergo/types.js";
import { getProviderClient } from "../cli-utils.js";
import { loadPrivateKey } from "../key-utils.js";
import { encodeBytes } from "../../ergo/registers.js";

// -- CLI handler ------------------------------------------------------------

export async function setCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  const [subCommand, ...rest] = args;

  if (subCommand === "encrypt") {
    await setEncryptCommand(rest, book);
    return;
  }

  console.error("Usage: bw set encrypt <nft_id> <data>");
  process.exit(1);
}

async function setEncryptCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  if (args.length < 2) {
    console.error("Usage: bw set encrypt <nft_id> <data>");
    console.error("  <nft_id>  -- 64-char hex token ID of the NFT");
    console.error("  <data>    -- hex-encoded encrypted data");
    process.exit(1);
  }

  const [nftId, data] = args;
  if (!nftId || !data) {
    console.error("Usage: bw set encrypt <nft_id> <data>");
    process.exit(1);
  }

  // Validate nft_id format (64 hex chars)
  if (!/^[0-9a-fA-F]{64}$/.test(nftId)) {
    console.error(`Invalid nft_id: ${nftId}. Expected 64-char hex token ID.`);
    process.exit(1);
  }

  // Determine signing role (prefer "server")
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

  console.error(`Looking for reference box with NFT ${nftId.slice(0, 16)}...`);

  // Find the box holding the NFT reference token at the server address
  const serverBoxes = await provider.getUnspentBoxes(serverAddress);

  let refBox: ErgoBox | undefined;
  for (const box of serverBoxes) {
    const hasNft = box.assets.some((a) => a.tokenId === nftId);
    if (hasNft) {
      refBox = box;
      break;
    }
  }

  if (!refBox) {
    throw new Error(
      `Reference box with NFT ${nftId} not found at server address. Has this NFT been minted?`,
    );
  }

  console.error(`Found at ${refBox.boxId.slice(0, 16)}...`);

  // Build the updated output: same box contents but with updated R8
  const height = await provider.getHeight();

  // Preserve existing registers, update R8 with new encrypted data
  const updatedRegisters: Record<string, string> = {
    ...refBox.additionalRegisters,
  };
  updatedRegisters["R8"] = encodeBytes(data);

  // Create output with same value, tokens, and updated registers
  const outputValue =
    refBox.value >= SAFE_MIN_BOX_VALUE ? refBox.value : SAFE_MIN_BOX_VALUE;

  const output = new OutputBuilder(outputValue, serverAddress)
    .setAdditionalRegisters(updatedRegisters);

  // Preserve all tokens from the original box
  for (const asset of refBox.assets) {
    output.addTokens({ tokenId: asset.tokenId, amount: asset.amount });
  }

  // Build unsigned tx: spend the ref box, create updated output
  const unsignedTx = new TransactionBuilder(height)
    .from([refBox] as unknown as Box<Amount>[])
    .to(output)
    .sendChangeTo(serverAddress)
    .payMinFee()
    .build();

  // Sign via node and submit
  const signedTx = await provider.signTx(unsignedTx, [privKeyHex]);
  const txId = await provider.submitTx(signedTx);

  console.log(txId);
  console.error(`Updated reference data for NFT ${nftId.slice(0, 16)}...`);
}
