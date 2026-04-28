/**
 * bw withdraw [token] <to>
 *
 * Batch-collect earned payments from subscription boxes.
 *
 * Queries subscription boxes by their ErgoTree (the subscription contract),
 * identifies those that are claimable (enough time elapsed since last collection),
 * and builds a transaction that:
 *   - Spends each claimable subscription box
 *   - Creates continuing outputs with updated registers (reduced amountRemaining)
 *   - Sends collected funds to the specified recipient
 *   - Preserves beacon tokens in continuing outputs (or burns if fully consumed)
 *
 * Uses Fleet SDK TransactionBuilder for unsigned tx, Ergo node for signing.
 * Core function executeWithdraw() is used by fund-manager.
 */

import {
  TransactionBuilder,
  OutputBuilder,
  SAFE_MIN_BOX_VALUE,
} from "@fleet-sdk/core";
import type { Box, Amount } from "@fleet-sdk/common";
import type { Addressbook } from "../../fund-manager/types.js";
import type { SubscriptionState, ErgoBox } from "../../ergo/types.js";
import { resolveAddress, getProviderClient } from "../cli-utils.js";
import { loadPrivateKey } from "../key-utils.js";
import {
  decodeSubscriptionRegisters,
  encodeSubscriptionRegisters,
} from "../../ergo/registers.js";
import {
  getSubscriptionErgoTree,
  contractAddress,
} from "../../ergo/contracts.js";
import { publicKeyFromAddress } from "../../ergo/address.js";
import { loadNetworkConfig } from "../../fund-manager/web3-config.js";

const MAX_BATCH = 15; // max subscription boxes per transaction

// -- Claimability analysis --------------------------------------------------

interface ClaimableInfo {
  box: ErgoBox;
  state: SubscriptionState;
  intervals: bigint;
  collectAmount: bigint;
  fullyConsumed: boolean;
}

/**
 * Analyze a subscription box for claimability.
 */
function analyzeClaimable(
  box: ErgoBox,
  currentHeight: number,
): ClaimableInfo | null {
  const partial = decodeSubscriptionRegisters(box.additionalRegisters);

  // Need all essential fields
  if (
    partial.planId === undefined ||
    partial.subscriber === undefined ||
    partial.amountRemaining === undefined ||
    partial.ratePerInterval === undefined ||
    partial.intervalBlocks === undefined ||
    partial.lastCollectedHeight === undefined ||
    partial.expiryHeight === undefined
  ) {
    return null;
  }

  if (partial.amountRemaining <= 0n) return null;

  // All time references use block height, never timestamps
  
  const effectiveHeight = currentHeight > partial.expiryHeight ? partial.expiryHeight : currentHeight;
  const elapsedBlocks = effectiveHeight - partial.lastCollectedHeight;
  if (elapsedBlocks < partial.intervalBlocks) return null;

  const intervals = BigInt(Math.floor(elapsedBlocks / partial.intervalBlocks));
  let collectAmount = intervals * partial.ratePerInterval;

  const fullyConsumed = collectAmount >= partial.amountRemaining;
  if (fullyConsumed) {
    collectAmount = partial.amountRemaining;
  }

  // Reconstruct full SubscriptionState
  const beaconToken = box.assets[0];
  const state: SubscriptionState = {
    planId: partial.planId,
    subscriber: partial.subscriber,
    amountRemaining: partial.amountRemaining,
    ratePerInterval: partial.ratePerInterval,
    intervalBlocks: partial.intervalBlocks,
    lastCollectedHeight: partial.lastCollectedHeight,
    expiryHeight: partial.expiryHeight,
    paymentTokenId: partial.paymentTokenId ?? "",
    beaconTokenId: beaconToken?.tokenId ?? "",
    userEncrypted: partial.userEncrypted ?? "",
    creationHeight: box.creationHeight,
  };

  return { box, state, intervals, collectAmount, fullyConsumed };
}

// -- Core withdraw ----------------------------------------------------------

/**
 * Core withdraw operation -- used by both CLI and fund-manager.
 */
export async function executeWithdraw(
  toRole: string,
  book: Addressbook,
  tokenFilter?: string,
): Promise<void> {
  const toAddress = resolveAddress(toRole, book);
  const provider = getProviderClient();
  const config = loadNetworkConfig();

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
  const serverPubKey = publicKeyFromAddress(serverAddress);

  // Get subscription contract ErgoTree
  const subscriptionErgoTree = getSubscriptionErgoTree(serverPubKey);
  const subscriptionAddress = contractAddress(
    subscriptionErgoTree,
    config.network === "mainnet",
  );

  console.error(
    `Scanning subscription address: ${subscriptionAddress.slice(0, 25)}...`,
  );

  // Fetch all unspent boxes at the subscription contract address
  const subscriptionBoxes =
    await provider.getUnspentBoxesByErgoTree(subscriptionErgoTree);

  if (subscriptionBoxes.length === 0) {
    console.log("No subscription boxes found.");
    return;
  }
  console.error(`Found ${subscriptionBoxes.length} subscription box(es)`);

  // Analyze claimability using current block height.
  // The guard script uses HEIGHT which is deterministic.
  const currentHeight = await provider.getHeight();
  const claimable: ClaimableInfo[] = [];
  for (const box of subscriptionBoxes) {
    const info = analyzeClaimable(box, currentHeight);
    if (info) {
      // If a token filter is specified, only include boxes with that paymentTokenId
      if (tokenFilter && info.state.paymentTokenId !== tokenFilter) continue;
      claimable.push(info);
    }
  }

  if (claimable.length === 0) {
    console.log("No claimable subscription boxes at this time.");
    return;
  }
  console.error(
    `${claimable.length} claimable box(es) (processing up to ${MAX_BATCH})`,
  );

  // Process one subscription at a time — the guard script checks OUTPUTS(0)
  // for the continuing box, so we can only have one per tx
  const batch = claimable.slice(0, 1);

  // Reuse the height fetched for claimability analysis above
  const serverBoxes = await provider.getUnspentBoxes(serverAddress);

  // Build the transaction
  // IMPORTANT: subscription box must be FIRST input (its guard script runs)
  // Server boxes follow (for fee payment)
  const allInputBoxes: ErgoBox[] = [...batch.map((b) => b.box), ...serverBoxes];

  const txBuilder = new TransactionBuilder(currentHeight).from(
    allInputBoxes as unknown as Box<Amount>[],
  );

  // Build outputs in correct order:
  // OUTPUTS(0) = continuing subscription box (guard script checks this)
  // OUTPUTS(1) = collected funds to recipient
  // OUTPUTS(2) = miner fee
  // OUTPUTS(3+) = change
  const continuingOutputs: OutputBuilder[] = [];
  let totalCollected = 0n;

  for (const info of batch) {
    totalCollected += info.collectAmount;

    if (info.fullyConsumed) {
      // Fully consumed: beacon token is burned.
      // The guard script eagerly evaluates OUTPUTS(0).R4/R5/R6.get even on the
      // fullyConsumed path. We must create OUTPUTS(0) with valid register types
      // to avoid a None.get crash, but WITHOUT the beacon token (the fullyConsumed
      // check verifies no output contains the beacon).
      const dummyRegs = encodeSubscriptionRegisters(info.state);
      continuingOutputs.push(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, serverAddress)
          .setAdditionalRegisters(dummyRegs),
      );
      if (info.state.beaconTokenId) {
        const beaconAmount = info.box.assets[0]?.amount ?? 1n;
        txBuilder.burnTokens({
          tokenId: info.state.beaconTokenId,
          amount: beaconAmount,
        });
      }
    } else {
      // Partial collection: create continuing box with updated state
      const updatedState: SubscriptionState = {
        ...info.state,
        amountRemaining: info.state.amountRemaining - info.collectAmount,
        lastCollectedHeight:
          info.state.lastCollectedHeight + Number(info.intervals) * info.state.intervalBlocks,
      };

      const regs = encodeSubscriptionRegisters(updatedState);

      // Calculate continuing box value
      let continuingValue: bigint;
      if (info.state.paymentTokenId === "") {
        // ERG payment: subtract collected amount from box value
        continuingValue = info.box.value - info.collectAmount;
        if (continuingValue < SAFE_MIN_BOX_VALUE) {
          continuingValue = SAFE_MIN_BOX_VALUE;
        }
      } else {
        // Token payment: ERG value stays the same (just for box storage)
        continuingValue = info.box.value;
      }

      const continuingOutput = new OutputBuilder(
        continuingValue,
        subscriptionAddress,
      ).setAdditionalRegisters(regs);

      // Preserve beacon token
      if (info.state.beaconTokenId) {
        continuingOutput.addTokens({
          tokenId: info.state.beaconTokenId,
          amount: info.box.assets[0]?.amount ?? 1n,
        });
      }

      // Preserve payment token (if token payment, minus collected amount)
      if (info.state.paymentTokenId !== "") {
        const payTokenAsset = info.box.assets.find(
          (a) => a.tokenId === info.state.paymentTokenId,
        );
        if (payTokenAsset) {
          const remainingTokens = payTokenAsset.amount - info.collectAmount;
          if (remainingTokens > 0n) {
            continuingOutput.addTokens({
              tokenId: info.state.paymentTokenId,
              amount: remainingTokens,
            });
          }
        }
      }

      continuingOutputs.push(continuingOutput); // MUST be OUTPUTS(0)
    }
  }

  // Add continuing boxes FIRST (guard script checks OUTPUTS(0))
  for (const out of continuingOutputs) {
    txBuilder.to(out);
  }

  // Then collection output
  if (totalCollected > 0n) {
    const firstInfo = batch[0];
    if (firstInfo && firstInfo.state.paymentTokenId === "") {
      txBuilder.to(new OutputBuilder(totalCollected, toAddress));
    } else if (firstInfo && firstInfo.state.paymentTokenId !== "") {
      txBuilder.to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, toAddress).addTokens({
          tokenId: firstInfo.state.paymentTokenId,
          amount: totalCollected,
        }),
      );
    }
  }

  const unsignedTx = txBuilder
    .sendChangeTo(serverAddress)
    .payMinFee()
    .build();

  // Sign via ergo-relay — pass full input boxes for signing context
  const signedTx = await provider.signTx(unsignedTx, [privKeyHex], allInputBoxes);
  const txId = await provider.submitTx(signedTx);

  console.log(txId);
  console.error(
    `Collected from ${batch.length} box(es), total: ${totalCollected.toString()} base units`,
  );
}

// -- CLI handler ------------------------------------------------------------

export async function withdrawCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw withdraw [token] <to>");
    console.error("  Example: bw withdraw admin");
    console.error("  Example: bw withdraw <token_id> admin");
    process.exit(1);
  }

  let tokenFilter: string | undefined;
  let toRole: string;

  if (args.length >= 2 && /^[0-9a-fA-F]{64}$/.test(args[0] ?? "")) {
    // First arg is a 64-char hex token ID, second is the recipient
    tokenFilter = args[0];
    toRole = args[1] ?? "";
  } else {
    toRole = args[0] ?? "";
  }

  if (!toRole) {
    console.error("Usage: bw withdraw [token] <to>");
    process.exit(1);
  }

  await executeWithdraw(toRole, book, tokenFilter);
}
