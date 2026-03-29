/**
 * EIP-4 NFT minting helpers for Ergo.
 *
 * On Ergo, a token is minted in a transaction where the first input box ID
 * becomes the token ID. An NFT is simply a token with amount = 1.
 *
 * EIP-4 standard registers for the minting output:
 *   R4: Coll[Byte] — token name (UTF-8)
 *   R5: Coll[Byte] — token description (UTF-8)
 *   R6: Coll[Byte] — decimals ("0" for NFTs)
 *   R7: Coll[Byte] — type marker (0x01 0x01 = NFT picture type / general asset)
 *   R8: Coll[Byte] — userEncrypted (encrypted connection details)
 *
 * Fleet SDK's OutputBuilder.mintToken() handles R4-R6 automatically when
 * name/description/decimals are provided on the NewToken object. We add
 * R7 and R8 manually via setAdditionalRegisters().
 *
 * Reference box: a separate output guarded by the server's P2PK address,
 * holding a copy of the NFT (amount=0 is not possible on Ergo, so we use
 * a separate pattern where the reference data is in registers of a
 * server-controlled box).
 */

import {
  TransactionBuilder,
  OutputBuilder,
  SAFE_MIN_BOX_VALUE,
  RECOMMENDED_MIN_FEE_VALUE,
} from "@fleet-sdk/core";
import type { Box, Amount } from "@fleet-sdk/common";
import { SColl, SByte } from "@fleet-sdk/serializer";
import { hex } from "@fleet-sdk/crypto";
import type { ErgoProvider } from "../ergo/provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MintNftParams {
  /** Owner's Ergo address (Base58) — receives the NFT */
  ownerAddress: string;
  /** NFT name (e.g. "BlockHost Access #001") */
  name: string;
  /** NFT description */
  description: string;
  /** Hex-encoded encrypted connection details (may be empty) */
  userEncrypted: string;
  /** Server's Ergo address (Base58) — funds the tx, receives change */
  serverAddress: string;
  /** Server's private key hex (for signing) */
  serverPrivKeyHex: string;
  /** ErgoProvider instance */
  provider: ErgoProvider;
  /** Current blockchain height */
  currentHeight: number;
}

export interface MintNftResult {
  /** The token ID of the minted NFT (= first input box ID) */
  tokenId: string;
  /** Transaction ID */
  txId: string;
}

// ---------------------------------------------------------------------------
// EIP-4 type markers
// ---------------------------------------------------------------------------

/**
 * Type marker bytes for R7.
 * 0x01 = NFT, 0x01 = picture/general asset type.
 */
const NFT_TYPE_MARKER = new Uint8Array([0x01, 0x01]);

// ---------------------------------------------------------------------------
// Build mint transaction
// ---------------------------------------------------------------------------

/**
 * Build an EIP-4 NFT mint transaction.
 *
 * The NFT goes to the owner address with encrypted data in R7/R8.
 * Change goes back to the server address.
 *
 * @returns An unsigned transaction object ready for signing.
 */
export function buildMintNftTx(
  inputs: Box<Amount>[],
  ownerAddress: string,
  name: string,
  description: string,
  userEncrypted: string,
  serverAddress: string,
  currentHeight: number,
): { unsignedTx: ReturnType<TransactionBuilder["build"]>; tokenId: string } {
  if (inputs.length === 0) {
    throw new Error("No input boxes provided for mint transaction");
  }

  // Token ID will be the first input box ID
  const tokenId = inputs[0]!.boxId;

  // EIP-4 registers: R4 = name, R5 = description, R6 = decimals, R7 = type, R8 = userEncrypted
  // Fleet SDK requires sequential registers (R4-R8 all present when R8 is used).
  // We set them all manually and use mintToken() with only the amount.
  const nameBytes = new TextEncoder().encode(name);
  const descBytes = new TextEncoder().encode(description);
  const decBytes = new TextEncoder().encode("0"); // 0 decimals for NFTs

  const r4 = SColl(SByte, nameBytes).toHex();
  const r5 = SColl(SByte, descBytes).toHex();
  const r6 = SColl(SByte, decBytes).toHex();
  const r7 = SColl(SByte, NFT_TYPE_MARKER).toHex();
  const r8Bytes = userEncrypted
    ? hex.decode(userEncrypted)
    : new Uint8Array(0);
  const r8 = SColl(SByte, r8Bytes).toHex();

  // NFT output to owner
  const nftOutput = new OutputBuilder(
    SAFE_MIN_BOX_VALUE,
    ownerAddress,
  )
    .mintToken({ amount: 1n })
    .setAdditionalRegisters({
      R4: r4,
      R5: r5,
      R6: r6,
      R7: r7,
      R8: r8,
    });

  // Build the transaction
  const unsignedTx = new TransactionBuilder(currentHeight)
    .from(inputs)
    .to(nftOutput)
    .sendChangeTo(serverAddress)
    .payFee(RECOMMENDED_MIN_FEE_VALUE)
    .build();

  return { unsignedTx, tokenId };
}

// ---------------------------------------------------------------------------
// Mint and submit
// ---------------------------------------------------------------------------

/**
 * Full mint flow: fetch inputs, build tx, sign via node, submit.
 *
 * @returns MintNftResult with tokenId and txId.
 */
export async function mintNft(params: MintNftParams): Promise<MintNftResult> {
  const {
    ownerAddress,
    name,
    description,
    userEncrypted,
    serverAddress,
    serverPrivKeyHex,
    provider,
    currentHeight,
  } = params;

  // Fetch server's unspent boxes for funding
  const inputs = await provider.getUnspentBoxes(serverAddress);
  if (inputs.length === 0) {
    throw new Error(
      `No unspent boxes found for server address ${serverAddress}`,
    );
  }

  // Convert our ErgoBox type to Fleet SDK Box format
  const fleetInputs: Box<Amount>[] = inputs.map((box) => ({
    boxId: box.boxId,
    transactionId: box.transactionId,
    index: box.index,
    value: box.value.toString(),
    ergoTree: box.ergoTree,
    creationHeight: box.creationHeight,
    assets: box.assets.map((a) => ({
      tokenId: a.tokenId,
      amount: a.amount.toString(),
    })),
    additionalRegisters: box.additionalRegisters,
  }));

  const { unsignedTx, tokenId } = buildMintNftTx(
    fleetInputs,
    ownerAddress,
    name,
    description,
    userEncrypted,
    serverAddress,
    currentHeight,
  );

  // Sign via ergo-relay — pass full input boxes for signing context
  const signedTx = await provider.signTx(unsignedTx, [serverPrivKeyHex], inputs);

  // Submit
  const txId = await provider.submitTx(signedTx);

  return { tokenId, txId };
}

// ---------------------------------------------------------------------------
// Reference box helpers
// ---------------------------------------------------------------------------

/**
 * Build a transaction that creates a reference box at the server's address
 * with updatable encrypted data in registers.
 *
 * The reference box holds:
 *   R4: Coll[Byte] — NFT token ID bytes
 *   R5: Coll[Byte] — userEncrypted (can be updated by spending and recreating)
 *
 * This is a server-guarded box (P2PK) so only the server can spend/update it.
 */
export function buildReferenceBoxTx(
  inputs: Box<Amount>[],
  nftTokenId: string,
  userEncrypted: string,
  serverAddress: string,
  currentHeight: number,
): ReturnType<TransactionBuilder["build"]> {
  if (inputs.length === 0) {
    throw new Error("No input boxes provided for reference box transaction");
  }

  const r4 = SColl(SByte, hex.decode(nftTokenId)).toHex();
  const r5Bytes = userEncrypted
    ? hex.decode(userEncrypted)
    : new Uint8Array(0);
  const r5 = SColl(SByte, r5Bytes).toHex();

  const refOutput = new OutputBuilder(
    SAFE_MIN_BOX_VALUE,
    serverAddress,
  ).setAdditionalRegisters({
    R4: r4,
    R5: r5,
  });

  return new TransactionBuilder(currentHeight)
    .from(inputs)
    .to(refOutput)
    .sendChangeTo(serverAddress)
    .payFee(RECOMMENDED_MIN_FEE_VALUE)
    .build();
}
