/**
 * Hot wallet distribution logic (Ergo).
 *
 * Steps 2-5 of the fund cycle:
 *
 *  2. Top up hot wallet ERG (server -> hot if hot is low)
 *  3. Top up server stablecoin buffer (hot -> server stablecoin)
 *  4. Revenue shares (hot -> dev/broker per revenue-share.json)
 *  5. Remainder to admin (hot -> admin)
 *
 * All transfers use executeSend() -- no inline transfer code.
 * Errors are caught and logged so one failure does not short-circuit
 * subsequent steps.
 */

import type { Addressbook, FundManagerConfig, RevenueShareConfig } from "./types.js";
import { resolveRole } from "./addressbook.js";
import { executeBalance } from "../bw/commands/balance.js";
import { executeSend } from "../bw/commands/send.js";
import { formatErg } from "../bw/cli-utils.js";

// -- Helpers ------------------------------------------------------------------

/**
 * Convert nanoERG to ERG decimal string for executeSend.
 * e.g. 1_500_000_000n -> "1.500000000"
 */
function nanoErgToStr(nanoErg: bigint): string {
  const whole = nanoErg / 1_000_000_000n;
  const frac = (nanoErg % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole}.${frac}`;
}

// -- Step 2: Hot wallet ERG top-up --------------------------------------------

/**
 * Ensure hot wallet has enough ERG for transaction fees.
 * Server sends ERG to bring hot wallet up to hot_wallet_gas_nanoerg target.
 */
export async function topUpHotWalletGas(
  book: Addressbook,
  config: FundManagerConfig,
): Promise<void> {
  if (!book["hot"]?.address) return;
  if (!book["server"]?.address || !book["server"]?.keyfile) return;

  const hotBal = await executeBalance("hot", undefined, book);
  if (hotBal.nanoErg >= config.hot_wallet_gas_nanoerg) return;

  const needed = config.hot_wallet_gas_nanoerg - hotBal.nanoErg;

  // Require server to keep a healthy reserve for minting and other operations
  const MIN_SERVER_RESERVE = 20_000_000_000n; // 20 ERG
  const serverBal = await executeBalance("server", undefined, book);
  if (serverBal.nanoErg < needed + MIN_SERVER_RESERVE) {
    console.warn(
      `[FUND] Server ERG too low to top up hot wallet ` +
      `(server: ${formatErg(serverBal.nanoErg)}, needed: ${formatErg(needed)})`,
    );
    return;
  }

  console.log(`[FUND] Topping up hot wallet gas: ${formatErg(needed)}`);
  await executeSend(nanoErgToStr(needed), "erg", "server", "hot", book);
  console.log("[FUND] Hot wallet gas top-up complete");
}

// -- Step 3: Server stablecoin buffer -----------------------------------------

/**
 * Ensure server wallet has enough stablecoin for VM provisioning.
 * Hot wallet sends stablecoin to server if server balance is below buffer.
 */
export async function topUpServerStablecoinBuffer(
  book: Addressbook,
  config: FundManagerConfig,
): Promise<void> {
  if (!book["server"]?.address) return;
  if (!book["hot"]?.address) return;

  const serverBal = await executeBalance("server", "stable", book);
  if (serverBal.tokenBalance === undefined) {
    // No payment token configured -- skip silently
    return;
  }

  if (serverBal.tokenBalance >= config.server_stablecoin_buffer_nanoerg) return;

  const needed = config.server_stablecoin_buffer_nanoerg - serverBal.tokenBalance;

  const hotBal = await executeBalance("hot", "stable", book);
  if ((hotBal.tokenBalance ?? 0n) < needed) {
    console.warn(
      `[FUND] Hot wallet stablecoin insufficient for server buffer top-up ` +
      `(hot: ${hotBal.tokenBalance ?? 0n}, needed: ${needed})`,
    );
    return;
  }

  // Stablecoin amounts: pass as integer string (base units)
  const neededStr = needed.toString();
  console.log(`[FUND] Topping up server stablecoin buffer: ${neededStr} base units`);
  await executeSend(neededStr, "stable", "hot", "server", book);
  console.log("[FUND] Server stablecoin buffer topped up");
}

// -- Step 4: Revenue shares ---------------------------------------------------

/**
 * Distribute ERG revenue shares from hot wallet to configured recipients.
 *
 * Uses integer basis-point arithmetic (no float) to avoid rounding errors.
 * The last recipient receives the remainder to avoid dust from integer division.
 */
export async function distributeRevenueShares(
  book: Addressbook,
  revenueConfig: RevenueShareConfig,
): Promise<void> {
  if (!revenueConfig.enabled || revenueConfig.recipients.length === 0) {
    return;
  }

  const totalBps =
    revenueConfig.total_bps ??
    Math.round((revenueConfig.total_percent ?? 0) * 100);
  if (totalBps <= 0) return;

  if (!book["hot"]?.address) return;

  const hotBal = await executeBalance("hot", undefined, book);
  if (hotBal.nanoErg === 0n) {
    console.log("[FUND] Hot wallet ERG balance is zero, skipping revenue shares");
    return;
  }

  // Total ERG available for revenue sharing
  const totalShareAmount = (hotBal.nanoErg * BigInt(totalBps)) / 10_000n;
  if (totalShareAmount === 0n) return;

  console.log(
    `[FUND] Distributing revenue shares: ${formatErg(totalShareAmount)} ` +
    `(${totalBps} bps of ${formatErg(hotBal.nanoErg)})`,
  );

  let distributed = 0n;
  const recipients = revenueConfig.recipients;

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i]!;
    const recipientAddress = resolveRole(recipient.role, book);
    if (!recipientAddress) {
      console.error(
        `[FUND] Revenue share recipient '${recipient.role}' not in addressbook`,
      );
      continue;
    }

    const recipientBps =
      recipient.bps ?? Math.round((recipient.percent ?? 0) * 100);

    const isLast = i === recipients.length - 1;
    const share = isLast
      ? totalShareAmount - distributed
      : (totalShareAmount * BigInt(recipientBps)) / BigInt(totalBps);
    distributed += share;

    if (share === 0n) continue;

    try {
      const shareStr = nanoErgToStr(share);
      await executeSend(shareStr, "erg", "hot", recipient.role, book);
      console.log(
        `[FUND] Revenue share: sent ${formatErg(share)} to ` +
        `${recipient.role} (${recipientBps} bps)`,
      );
    } catch (err) {
      console.error(
        `[FUND] Error sending revenue share to ${recipient.role}: ${err}`,
      );
    }
  }
}

// -- Step 5: Remainder to admin -----------------------------------------------

/**
 * Send all remaining ERG from hot wallet to admin.
 */
export async function sendRemainderToAdmin(
  book: Addressbook,
): Promise<void> {
  const adminAddress = resolveRole("admin", book);
  if (!adminAddress) {
    console.error("[FUND] Cannot send remainder: admin not in addressbook");
    return;
  }

  if (!book["hot"]?.address) return;

  const hotBal = await executeBalance("hot", undefined, book);
  if (hotBal.nanoErg === 0n) {
    console.log("[FUND] Hot wallet ERG balance is zero, nothing to send to admin");
    return;
  }

  try {
    const amountStr = nanoErgToStr(hotBal.nanoErg);
    await executeSend(amountStr, "erg", "hot", "admin", book);
    console.log(`[FUND] Remainder: sent ${formatErg(hotBal.nanoErg)} to admin`);
  } catch (err) {
    console.error(`[FUND] Error sending remainder to admin: ${err}`);
  }
}
