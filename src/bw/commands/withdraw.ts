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
  nowMs: bigint,
): ClaimableInfo | null {
  const partial = decodeSubscriptionRegisters(box.additionalRegisters);

  // Need all essential fields
  if (
    partial.planId === undefined ||
    partial.subscriber === undefined ||
    partial.amountRemaining === undefined ||
    partial.ratePerInterval === undefined ||
    partial.intervalMs === undefined ||
    partial.lastCollected === undefined ||
    partial.expiry === undefined
  ) {
    return null;
  }

  if (partial.amountRemaining <= 0n) return null;

  // Cap effective time at expiry
  const effectiveTime = nowMs > partial.expiry ? partial.expiry : nowMs;
  const elapsed = effectiveTime - partial.lastCollected;
  if (elapsed < partial.intervalMs) return null;

  const intervals = elapsed / partial.intervalMs;
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
    intervalMs: partial.intervalMs,
    lastCollected: partial.lastCollected,
    expiry: partial.expiry,
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

  // Analyze claimability
  const nowMs = BigInt(Date.now());
  const claimable: ClaimableInfo[] = [];
  for (const box of subscriptionBoxes) {
    const info = analyzeClaimable(box, nowMs);
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

  const batch = claimable.slice(0, MAX_BATCH);

  // Get current height and server's boxes for fees/change
  const height = await provider.getHeight();
  const serverBoxes = await provider.getUnspentBoxes(serverAddress);

  // Build the transaction
  // Inputs: subscription boxes (to spend) + server boxes (for fees)
  const allInputBoxes: ErgoBox[] = [...batch.map((b) => b.box), ...serverBoxes];

  const txBuilder = new TransactionBuilder(height).from(
    allInputBoxes as unknown as Box<Amount>[],
  );

  let totalCollected = 0n;

  for (const info of batch) {
    totalCollected += info.collectAmount;

    if (info.fullyConsumed) {
      // Fully consumed: beacon token is burned (not included in any output)
      // No continuing box needed -- the box is consumed entirely
      // If the beacon token is not accounted for in outputs, Fleet SDK
      // will require explicit burn
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
        lastCollected:
          info.state.lastCollected + info.intervals * info.state.intervalMs,
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

      txBuilder.to(continuingOutput);
    }
  }

  // Send collected funds to recipient
  if (totalCollected > 0n) {
    // Check if collecting ERG or tokens
    const firstInfo = batch[0];
    if (firstInfo && firstInfo.state.paymentTokenId === "") {
      // ERG collection
      txBuilder.to(new OutputBuilder(totalCollected, toAddress));
    } else if (firstInfo && firstInfo.state.paymentTokenId !== "") {
      // Token collection
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

  // Sign via node (server key handles the subscription guard script spending proof)
  const signedTx = await provider.signTx(unsignedTx, [privKeyHex]);
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
